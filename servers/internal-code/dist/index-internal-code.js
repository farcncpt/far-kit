#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { Project, Node, SyntaxKind } from "ts-morph";
import madge from "madge";
import { readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { glob } from "glob";
import { projectCache } from "./cache.js";
import { validateToolUsage, validateToolUsageSchema } from "./tools/validate_tool_usage.js";
import { inspectServerLogs, inspectServerLogsSchema } from "./tools/inspect_server_logs.js";
import { validateFunctionBehavior, validateFunctionBehaviorSchema } from "./tools/validate_function_behavior.js";
import { validateTypeScript, validateTypeScriptSchema, validateTypeScriptBatch, validateTypeScriptBatchSchema } from "./tools/validate_typescript.js";
import { preDeployAudit, preDeployAuditSchema } from "./tools/pre_deploy_audit.js";
import { analyzeProjectChecks, analyzeProjectChecksSchema } from "./tools/analyze_project_checks.js";
import { suspenseBoundaryCheck, suspenseBoundaryCheckSchema } from "./tools/suspense_boundary_check.js";
import { zodToJsonSchema } from "zod-to-json-schema";
// Initialize Server
const server = new Server({
    name: "internal-code-mcp",
    version: "0.1.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Helper to format JSON response
const formatResponse = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: data.status === "error",
});
// Levenshtein distance for fuzzy matching
function levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            }
            else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
            }
        }
    }
    return matrix[b.length][a.length];
}
// Find similar file paths for fix suggestions
async function findSimilarFiles(missingPath, projectRoot) {
    try {
        const allFiles = await glob(`${projectRoot}/**/*.{ts,js,tsx,jsx}`, {
            ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**']
        });
        const baseName = missingPath.split('/').pop()?.replace(/\.(ts|js|tsx|jsx)$/, '') || '';
        const suggestions = [];
        for (const file of allFiles) {
            const fileName = file.split('/').pop()?.replace(/\.(ts|js|tsx|jsx)$/, '') || '';
            const distance = levenshteinDistance(baseName.toLowerCase(), fileName.toLowerCase());
            // Only suggest if reasonably similar (distance < 5 or less than 50% of name length)
            const threshold = Math.min(5, Math.ceil(baseName.length / 2));
            if (distance <= threshold) {
                const relativePath = file.replace(projectRoot + '/', '');
                const confidence = 1 - (distance / Math.max(baseName.length, fileName.length));
                suggestions.push({
                    path: relativePath,
                    fileName,
                    distance,
                    confidence: Math.round(confidence * 100) / 100,
                    fileExists: true
                });
            }
        }
        // Sort by distance (best matches first)
        suggestions.sort((a, b) => a.distance - b.distance);
        return suggestions.slice(0, 5); // Return top 5 suggestions
    }
    catch (error) {
        return [];
    }
}
// Find nearest tsconfig.json by traversing up the directory tree
function findNearestTsConfig(startDir) {
    let currentDir = startDir;
    const root = resolve('/');
    while (currentDir !== root) {
        const tsconfigPath = join(currentDir, 'tsconfig.json');
        try {
            readFileSync(tsconfigPath);
            return tsconfigPath;
        }
        catch {
            // Move to parent directory
            const parentDir = dirname(currentDir);
            if (parentDir === currentDir)
                break; // Reached filesystem root
            currentDir = parentDir;
        }
    }
    return undefined;
}
function parseTsConfigPaths(tsconfigPath) {
    try {
        const content = readFileSync(tsconfigPath, 'utf-8');
        const config = JSON.parse(content);
        const compilerOptions = config.compilerOptions || {};
        return {
            baseUrl: compilerOptions.baseUrl,
            paths: compilerOptions.paths || {}
        };
    }
    catch {
        return null;
    }
}
// Resolve a module specifier using path aliases
function resolveWithPathAlias(moduleSpecifier, aliases, tsconfigDir) {
    if (!aliases || !aliases.paths)
        return null;
    for (const [pattern, targets] of Object.entries(aliases.paths)) {
        // Handle patterns like "@/*" or "~/*"
        const patternBase = pattern.replace(/\/\*$/, '');
        if (moduleSpecifier === patternBase || moduleSpecifier.startsWith(patternBase + '/')) {
            const remainingPath = moduleSpecifier.slice(patternBase.length);
            for (const target of targets) {
                const targetBase = target.replace(/\/\*$/, '');
                const baseUrl = aliases.baseUrl || '.';
                const resolvedBase = resolve(tsconfigDir, baseUrl, targetBase);
                const fullPath = resolvedBase + remainingPath;
                // Try common extensions
                const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
                for (const ext of extensions) {
                    const testPath = fullPath + ext;
                    try {
                        readFileSync(testPath);
                        return testPath;
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
    }
    return null;
}
// --- Core Logic Helpers ---
async function validateImportTree(args) {
    const { filePath, recursive, checkTypes, projectRoot } = args;
    if (!filePath) {
        return {
            status: "error",
            message: "filePath parameter is required",
            hint: "Provide a valid file path to validate"
        };
    }
    try {
        const absolutePath = resolve(filePath);
        const rootPath = projectRoot ? resolve(projectRoot) : dirname(absolutePath);
        // Find tsconfig.json
        let tsconfigPath = join(rootPath, "tsconfig.json");
        try {
            readFileSync(tsconfigPath);
        }
        catch {
            tsconfigPath = undefined;
        }
        let project = projectCache.get(rootPath, tsconfigPath);
        if (!project) {
            project = new Project({
                tsConfigFilePath: tsconfigPath,
                skipAddingFilesFromTsConfig: true,
            });
            projectCache.set(rootPath, project, tsconfigPath);
        }
        project.addSourceFileAtPath(absolutePath);
        const sourceFile = project.getSourceFile(absolutePath);
        if (!sourceFile) {
            return {
                status: "error",
                message: `File not found: ${filePath}`,
                hint: "Check the file path and ensure it exists",
            };
        }
        const issues = [];
        const processedFiles = new Set();
        const analyzeFile = async (file) => {
            const filePath = file.getFilePath();
            if (processedFiles.has(filePath))
                return;
            processedFiles.add(filePath);
            // Check all imports
            for (const importDecl of file.getImportDeclarations()) {
                const moduleSpecifier = importDecl.getModuleSpecifierValue();
                const lineNumber = importDecl.getStartLineNumber();
                // Skip node_modules imports
                if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
                    continue;
                }
                const resolved = importDecl.getModuleSpecifierSourceFile();
                if (!resolved) {
                    // Find similar files for suggestions
                    const suggestions = await findSimilarFiles(moduleSpecifier, rootPath);
                    issues.push({
                        type: "missing_import",
                        file: filePath,
                        line: lineNumber,
                        message: `Unresolved import: '${moduleSpecifier}'`,
                        hint: suggestions.length > 0 ? "Did you mean one of these?" : "File does not exist or path is incorrect",
                        suggestions: suggestions.length > 0 ? suggestions : undefined,
                        autoFixAvailable: suggestions.length > 0
                    });
                }
                else if (checkTypes !== false) {
                    // Validate imported symbols exist in target
                    const namedImports = importDecl.getNamedImports();
                    const exports = resolved.getExportedDeclarations();
                    for (const namedImport of namedImports) {
                        const importName = namedImport.getName();
                        if (!exports.has(importName)) {
                            issues.push({
                                type: "missing_export",
                                file: filePath,
                                line: namedImport.getStartLineNumber(),
                                message: `Symbol '${importName}' not exported from '${moduleSpecifier}'`,
                                hint: "Check the export statement in the target file",
                            });
                        }
                    }
                    // Recursively analyze imported files
                    if (recursive) {
                        await analyzeFile(resolved);
                    }
                }
            }
        };
        await analyzeFile(sourceFile);
        return {
            status: issues.length > 0 ? "error" : "success",
            valid: issues.length === 0,
            issues: issues,
            filesAnalyzed: processedFiles.size,
            summary: issues.length > 0
                ? `Found ${issues.length} import issues across ${processedFiles.size} files`
                : `All imports valid in ${processedFiles.size} file(s)`,
            hint: issues.length > 0 ? "Review missing imports and exports" : null,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            status: "error",
            message: `Analysis failed: ${errorMessage}`,
            hint: "Ensure the file path is correct and TypeScript is configured properly",
        };
    }
}
async function validateSymbolUsage(args) {
    const { filePath, symbolName, projectRoot } = args;
    if (!filePath || !symbolName) {
        return {
            status: "error",
            message: "filePath and symbolName parameters are required",
            hint: "Provide valid file path and symbol name"
        };
    }
    try {
        const absolutePath = resolve(filePath);
        const rootPath = projectRoot ? resolve(projectRoot) : dirname(absolutePath);
        let tsconfigPath = join(rootPath, "tsconfig.json");
        try {
            readFileSync(tsconfigPath);
        }
        catch {
            tsconfigPath = undefined;
        }
        let project = projectCache.get(rootPath, tsconfigPath);
        if (!project) {
            project = new Project({
                tsConfigFilePath: tsconfigPath,
                skipAddingFilesFromTsConfig: true,
            });
            projectCache.set(rootPath, project, tsconfigPath);
        }
        project.addSourceFileAtPath(absolutePath);
        const sourceFile = project.getSourceFile(absolutePath);
        if (!sourceFile) {
            return {
                status: "error",
                message: `File not found: ${filePath}`,
                hint: "Check the file path",
            };
        }
        // Check if symbol is imported
        let symbolFound = false;
        let symbolType = "unknown";
        let sourceModule = "";
        for (const importDecl of sourceFile.getImportDeclarations()) {
            const namedImports = importDecl.getNamedImports();
            for (const namedImport of namedImports) {
                if (namedImport.getName() === symbolName) {
                    symbolFound = true;
                    sourceModule = importDecl.getModuleSpecifierValue();
                    // Check symbol type in source
                    const sourceFile = importDecl.getModuleSpecifierSourceFile();
                    if (sourceFile) {
                        const exports = sourceFile.getExportedDeclarations();
                        const declaration = exports.get(symbolName)?.[0];
                        if (declaration) {
                            if (Node.isFunctionDeclaration(declaration)) {
                                symbolType = "function";
                            }
                            else if (Node.isClassDeclaration(declaration)) {
                                symbolType = "class";
                            }
                            else if (Node.isVariableDeclaration(declaration)) {
                                symbolType = "const/let/var";
                            }
                            else if (Node.isInterfaceDeclaration(declaration)) {
                                symbolType = "interface";
                            }
                            else if (Node.isTypeAliasDeclaration(declaration)) {
                                symbolType = "type";
                            }
                        }
                    }
                    break;
                }
            }
        }
        if (!symbolFound) {
            return {
                status: "error",
                found: false,
                message: `Symbol '${symbolName}' not imported in ${filePath}`,
                hint: "Add the import statement or check the symbol name",
            };
        }
        // Check usage in file
        const usages = [];
        sourceFile.forEachDescendant((node) => {
            if (Node.isIdentifier(node) && node.getText() === symbolName) {
                const parent = node.getParent();
                let usageType = "reference";
                if (parent && Node.isCallExpression(parent) && parent.getExpression() === node) {
                    usageType = "function_call";
                }
                else if (parent && Node.isNewExpression(parent)) {
                    usageType = "instantiation";
                }
                usages.push({
                    line: node.getStartLineNumber(),
                    type: usageType,
                });
            }
        });
        return {
            status: "success",
            found: true,
            symbolName,
            symbolType,
            sourceModule,
            usageCount: usages.length,
            usages,
            summary: `Symbol '${symbolName}' is a ${symbolType} from '${sourceModule}', used ${usages.length} time(s)`,
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            status: "error",
            message: `Symbol validation failed: ${errorMessage}`,
            hint: "Ensure the file and symbol exist",
        };
    }
}
// Export Tracing Functions
async function traceExportUsage(args) {
    const { filePath, exportName, includeReExports, projectRoot } = args;
    if (!filePath || !exportName) {
        return {
            status: "error",
            message: "filePath and exportName parameters are required",
            hint: "Provide valid file path and export name"
        };
    }
    try {
        const absolutePath = resolve(filePath);
        const rootPath = projectRoot ? resolve(projectRoot) : dirname(absolutePath);
        // Find tsconfig.json
        let tsconfigPath = join(rootPath, "tsconfig.json");
        try {
            readFileSync(tsconfigPath);
        }
        catch {
            tsconfigPath = undefined;
        }
        let project = projectCache.get(rootPath, tsconfigPath);
        if (!project) {
            project = new Project({
                tsConfigFilePath: tsconfigPath,
                skipAddingFilesFromTsConfig: true,
            });
            projectCache.set(rootPath, project, tsconfigPath);
        }
        // Add the source file
        if (!project.getSourceFile(absolutePath)) {
            project.addSourceFileAtPath(absolutePath);
        }
        const sourceFile = project.getSourceFile(absolutePath);
        if (!sourceFile) {
            return {
                status: "error",
                message: `File not found: ${filePath}`,
                hint: "Check the file path and ensure it exists"
            };
        }
        // Verify export exists
        const exports = sourceFile.getExportedDeclarations();
        if (!exports.has(exportName)) {
            return {
                status: "error",
                message: `Export '${exportName}' not found in ${filePath}`,
                hint: "Check the export name spelling",
                availableExports: Array.from(exports.keys())
            };
        }
        // Find all files in project
        const allFiles = await glob(`${rootPath}/**/*.{ts,js,tsx,jsx}`, {
            ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**']
        });
        const directImports = [];
        const reExports = [];
        let totalUsages = 0;
        for (const file of allFiles) {
            if (file === absolutePath)
                continue; // Skip the source file itself
            try {
                if (!project.getSourceFile(file)) {
                    project.addSourceFileAtPath(file);
                }
                const checkFile = project.getSourceFile(file);
                if (!checkFile)
                    continue;
                // Check for imports
                for (const importDecl of checkFile.getImportDeclarations()) {
                    const moduleSpecifier = importDecl.getModuleSpecifierSourceFile();
                    if (moduleSpecifier?.getFilePath() === absolutePath) {
                        const namedImports = importDecl.getNamedImports();
                        const defaultImport = importDecl.getDefaultImport();
                        let isImported = false;
                        let importType = "";
                        // Check named imports
                        for (const namedImport of namedImports) {
                            if (namedImport.getName() === exportName) {
                                isImported = true;
                                importType = "named";
                                break;
                            }
                        }
                        // Check default import
                        if (defaultImport && exportName === "default") {
                            isImported = true;
                            importType = "default";
                        }
                        if (isImported) {
                            // Count actual usages in the file
                            const identifiers = checkFile.getDescendantsOfKind(SyntaxKind.Identifier);
                            let usageCount = 0;
                            for (const id of identifiers) {
                                if (id.getText() === exportName || (importType === "default" && defaultImport && id.getText() === defaultImport.getText())) {
                                    usageCount++;
                                }
                            }
                            directImports.push({
                                file: file.replace(rootPath + '/', ''),
                                line: importDecl.getStartLineNumber(),
                                importType,
                                usageCount
                            });
                            totalUsages += usageCount;
                            // Check if this file re-exports it
                            if (includeReExports !== false) {
                                const fileExports = checkFile.getExportedDeclarations();
                                if (fileExports.has(exportName)) {
                                    reExports.push({
                                        file: file.replace(rootPath + '/', ''),
                                        reExportsAs: exportName
                                    });
                                }
                            }
                        }
                    }
                }
            }
            catch (err) {
                // Skip files that can't be parsed
            }
        }
        // Determine if it's a public API (exported from index.ts)
        const isPublicAPI = reExports.some(r => r.file.endsWith('index.ts') || r.file.endsWith('index.js'));
        return {
            status: "success",
            exportName,
            sourceFile: filePath,
            directImports: directImports.length,
            reExports: reExports.length,
            totalUsages,
            consumers: directImports,
            reExportChain: reExports,
            isPublicAPI,
            impact: directImports.length > 10 ? "high" : directImports.length > 3 ? "medium" : "low",
            summary: `Export '${exportName}' is used in ${directImports.length} files with ${totalUsages} total references`
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            status: "error",
            message: `Export tracing failed: ${errorMessage}`,
            hint: "Ensure the file and export exist"
        };
    }
}
// Run Knip - the industry-standard tool for finding unused code
async function runKnip(args) {
    const { directory, include, exclude, production, strict, fix } = args;
    if (!directory) {
        return {
            status: "error",
            message: "directory parameter is required",
            hint: "Provide a valid project directory path containing package.json"
        };
    }
    try {
        const absoluteDir = resolve(directory);
        // Check if package.json exists
        const packageJsonPath = join(absoluteDir, 'package.json');
        try {
            readFileSync(packageJsonPath);
        }
        catch {
            return {
                status: "error",
                message: "No package.json found in directory",
                hint: "Knip requires a package.json file. Make sure you're pointing to a valid project root."
            };
        }
        // Build knip command
        const knipArgs = ['knip', '--reporter', 'json'];
        if (include && include.length > 0) {
            knipArgs.push('--include', include.join(','));
        }
        if (exclude && exclude.length > 0) {
            knipArgs.push('--exclude', exclude.join(','));
        }
        if (production) {
            knipArgs.push('--production');
        }
        if (strict) {
            knipArgs.push('--strict');
        }
        if (fix) {
            knipArgs.push('--fix');
        }
        // Run knip using npx
        const { execSync } = await import('child_process');
        let output;
        try {
            output = execSync(`npx ${knipArgs.join(' ')}`, {
                cwd: absoluteDir,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large projects
                timeout: 120000, // 2 minute timeout
            });
        }
        catch (execError) {
            // Knip exits with code 1 when it finds issues, but still outputs valid JSON
            if (execError.stdout) {
                output = execError.stdout;
            }
            else if (execError.stderr && execError.stderr.includes('command not found')) {
                return {
                    status: "error",
                    message: "Knip is not installed",
                    hint: "Install knip globally with 'npm install -g knip' or run 'npx knip' to use without installing",
                    installCommand: "npm install -g knip"
                };
            }
            else {
                throw execError;
            }
        }
        // Parse the JSON output
        let knipResult;
        try {
            knipResult = JSON.parse(output);
        }
        catch {
            // If JSON parsing fails, try to extract meaningful info
            return {
                status: "success",
                rawOutput: output,
                note: "Knip output was not JSON. This may indicate no issues found or a configuration problem."
            };
        }
        // Structure the results for easy consumption
        const summary = {
            unusedFiles: knipResult.files?.length || 0,
            unusedDependencies: knipResult.dependencies?.length || 0,
            unusedDevDependencies: knipResult.devDependencies?.length || 0,
            unusedExports: knipResult.exports?.length || 0,
            unusedTypes: knipResult.types?.length || 0,
            unlistedDependencies: knipResult.unlisted?.length || 0,
            duplicates: knipResult.duplicates?.length || 0,
        };
        const totalIssues = Object.values(summary).reduce((a, b) => a + b, 0);
        return {
            status: "success",
            summary,
            totalIssues,
            details: {
                files: knipResult.files || [],
                dependencies: knipResult.dependencies || [],
                devDependencies: knipResult.devDependencies || [],
                exports: (knipResult.exports || []).slice(0, 100), // Limit for readability
                types: (knipResult.types || []).slice(0, 100),
                unlisted: knipResult.unlisted || [],
                duplicates: knipResult.duplicates || [],
            },
            message: totalIssues === 0
                ? "No unused code found - your project is clean!"
                : `Found ${totalIssues} issues: ${summary.unusedFiles} unused files, ${summary.unusedDependencies} unused dependencies, ${summary.unusedExports} unused exports`,
            fixApplied: fix || false,
            knipVersion: "Uses latest via npx",
            tip: "Run with production: true to focus on production code only"
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            status: "error",
            message: `Knip execution failed: ${errorMessage}`,
            hint: "Make sure the directory is a valid npm project. You may need to run 'npm install' first.",
            troubleshooting: [
                "Ensure package.json exists in the directory",
                "Run 'npm install' to install dependencies",
                "Check if tsconfig.json is valid (if TypeScript project)",
                "Try running 'npx knip' manually to see detailed errors"
            ]
        };
    }
}
async function analyzeExportImpact(args) {
    const { filePath, exportName, changeType } = args;
    if (!filePath || !exportName || !changeType) {
        return {
            status: "error",
            message: "filePath, exportName, and changeType parameters are required",
            hint: "Provide valid file path, export name, and change type (remove, rename, signature_change)"
        };
    }
    try {
        // First trace the export usage
        const usageResult = await traceExportUsage({ filePath, exportName, includeReExports: true });
        if (usageResult.status === "error") {
            return usageResult;
        }
        // Type assertion after checking status
        const successResult = usageResult;
        const breakingChange = successResult.directImports > 0;
        const affectedFiles = successResult.directImports;
        const affectedTests = successResult.consumers?.filter((c) => c.file.includes('.test.') || c.file.includes('.spec.') || c.file.includes('__tests__')).length || 0;
        let recommendation = "";
        let migrationPath = "";
        if (changeType === "remove") {
            if (breakingChange) {
                recommendation = successResult.isPublicAPI
                    ? "Deprecate first, then remove in next major version"
                    : "Update all consumers before removing";
                migrationPath = "Remove all imports before deleting export";
            }
            else {
                recommendation = "Safe to remove (no consumers found)";
                migrationPath = "Can delete immediately";
            }
        }
        else if (changeType === "rename") {
            recommendation = breakingChange
                ? "Create alias first, migrate consumers, then remove old name"
                : "Safe to rename (no consumers)";
            migrationPath = "Use 'export { newName as oldName }' for backwards compatibility";
        }
        else if (changeType === "signature_change") {
            recommendation = breakingChange
                ? "Add new function, deprecate old, migrate consumers"
                : "Safe to change (no consumers)";
            migrationPath = "Provide both old and new signatures temporarily";
        }
        return {
            status: breakingChange ? "error" : "success",
            breakingChange,
            changeType,
            exportName,
            affectedFiles,
            affectedTests,
            isPublicAPI: successResult.isPublicAPI,
            impact: successResult.impact,
            consumers: successResult.consumers,
            recommendation,
            migrationPath,
            summary: breakingChange
                ? `⚠️ Breaking change: ${affectedFiles} files will be affected`
                : `✅ Safe change: No consumers found`
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            status: "error",
            message: `Export impact analysis failed: ${errorMessage}`,
            hint: "Ensure the file and export exist"
        };
    }
}
// Tool Handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "validate_import_tree",
                description: "Validates all imports in a file or directory resolve to actual files and exports",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string", description: "Path to file or directory to validate" },
                        recursive: { type: "boolean", description: "Check all imports recursively", default: false },
                        checkTypes: { type: "boolean", description: "Validate TypeScript types exist", default: true },
                        projectRoot: { type: "string", description: "Optional project root for tsconfig resolution" },
                    },
                    required: ["filePath"],
                },
            },
            {
                name: "validate_import_tree_batch",
                description: "Validates imports for multiple files or directories in parallel",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePaths: {
                            type: "array",
                            items: { type: "string" },
                            description: "Paths to files or directories to validate"
                        },
                        recursive: { type: "boolean", description: "Check all imports recursively", default: false },
                        checkTypes: { type: "boolean", description: "Validate TypeScript types exist", default: true },
                        projectRoot: { type: "string", description: "Optional project root for tsconfig resolution" },
                    },
                    required: ["filePaths"],
                },
            },
            {
                name: "validate_symbol_usage",
                description: "Checks if imported symbols are actually exported and used correctly",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string", description: "Path to file to validate" },
                        symbolName: { type: "string", description: "Symbol to validate" },
                        projectRoot: { type: "string", description: "Optional project root for tsconfig resolution" },
                    },
                    required: ["filePath", "symbolName"],
                },
            },
            {
                name: "validate_symbol_usage_batch",
                description: "Checks usage of multiple symbols across the codebase in parallel",
                inputSchema: {
                    type: "object",
                    properties: {
                        symbols: {
                            type: "string",
                            enum: ["plugins", "services", "routes", "modules"],
                            description: "Type of references to validate"
                        },
                        codebasePath: { type: "string", description: "Path to codebase root" },
                    },
                    required: ["configPath", "referenceType", "codebasePath"],
                },
            },
            {
                name: "analyze_dependency_graph",
                description: "Builds and validates the module dependency graph",
                inputSchema: {
                    type: "object",
                    properties: {
                        entryPoint: { type: "string", description: "Entry point file path" },
                        checkCircular: { type: "boolean", description: "Check for circular dependencies", default: true },
                        maxDepth: { type: "number", description: "Maximum dependency depth", default: 10 },
                    },
                    required: ["entryPoint"],
                },
            },
            {
                name: "audit_codebase_health",
                description: "Runs comprehensive validation checks across the codebase",
                inputSchema: {
                    type: "object",
                    properties: {
                        projectRoot: { type: "string", description: "Project root directory" },
                        checks: {
                            type: "array",
                            items: {
                                type: "string",
                                enum: ["imports", "symbols", "dependencies", "dead-code"]
                            },
                            description: "Types of checks to run"
                        },
                        failFast: { type: "boolean", description: "Stop on first error", default: false },
                    },
                    required: ["projectRoot", "checks"],
                },
            },
            {
                name: "trace_export_usage",
                description: "Find all places where an export is imported and used across the codebase",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string", description: "Path to file containing the export" },
                        exportName: { type: "string", description: "Name of the export to trace" },
                        includeReExports: { type: "boolean", description: "Include re-export chains", default: false },
                        projectRoot: { type: "string", description: "Optional project root for tsconfig resolution" },
                    },
                    required: ["filePath", "exportName"],
                },
            },
            {
                name: "run_knip",
                description: "Run Knip to find unused files, dependencies, and exports in JavaScript/TypeScript projects. Knip is the industry-standard tool for dead code detection with 100+ framework plugins.",
                inputSchema: {
                    type: "object",
                    properties: {
                        directory: { type: "string", description: "Project directory to analyze (must contain package.json)" },
                        include: {
                            type: "array",
                            items: { type: "string" },
                            description: "Issue types to include: files, dependencies, devDependencies, unlisted, binaries, duplicates, exports, types, nsExports, nsTypes, enumMembers, classMembers"
                        },
                        exclude: {
                            type: "array",
                            items: { type: "string" },
                            description: "Issue types to exclude"
                        },
                        production: { type: "boolean", description: "Analyze production code only (excludes test files, devDependencies)" },
                        strict: { type: "boolean", description: "Enable strict mode for more comprehensive detection" },
                        fix: { type: "boolean", description: "Automatically remove unused dependencies from package.json" },
                    },
                    required: ["directory"],
                },
            },
            {
                name: "analyze_export_impact",
                description: "Analyze the impact of removing, renaming, or changing an export",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string", description: "Path to file containing the export" },
                        exportName: { type: "string", description: "Name of the export to analyze" },
                        changeType: {
                            type: "string",
                            enum: ["remove", "rename", "signature_change"],
                            description: "Type of change being considered"
                        },
                    },
                    required: ["filePath", "exportName", "changeType"],
                },
            },
            {
                name: "validate_tool_usage",
                description: "Analyzes the codebase to verify that AI tools are correctly defined, exported, and compatible with the AI SDK.",
                inputSchema: zodToJsonSchema(validateToolUsageSchema)
            },
            {
                name: "inspect_server_logs",
                description: "Retrieves the recent logs from a log file to diagnose errors.",
                inputSchema: zodToJsonSchema(inspectServerLogsSchema)
            },
            {
                name: "validate_function_behavior",
                description: "Validates TypeScript/JavaScript functions by executing them with test cases. Supports named/default exports, error testing, and detailed pass/fail reporting. 100-400x faster than Jest/Vitest for simple function testing.",
                inputSchema: zodToJsonSchema(validateFunctionBehaviorSchema)
            },
            {
                name: "validate_typescript",
                description: "Runs TypeScript compiler (tsc --noEmit) to catch type errors before build. Parses errors into structured format with categories (implicit-any, null-check, etc.) and can auto-fix common issues like implicit any in .map() callbacks. Much faster than full build for catching TypeScript errors.",
                inputSchema: zodToJsonSchema(validateTypeScriptSchema)
            },
            {
                name: "validate_typescript_batch",
                description: "Validates TypeScript for multiple projects in sequence. Useful for monorepos or validating multiple codebases at once.",
                inputSchema: zodToJsonSchema(validateTypeScriptBatchSchema)
            },
            {
                name: "pre_deploy_audit",
                description: "Comprehensive pre-deployment validation that runs multiple checks in parallel: TypeScript compilation (with CI simulation), import resolution, circular dependencies, unused code detection, Suspense boundary validation, and environment variable validation. Returns a unified report with pass/fail status, critical issues, and recommendations. Ideal for running before deploying to catch issues that would fail in CI.",
                inputSchema: zodToJsonSchema(preDeployAuditSchema)
            },
            {
                name: "analyze_project_checks",
                description: "Analyzes a project to detect frameworks (Next.js, React, etc.), auth libraries (Stack Auth, Clerk, NextAuth), and other patterns. Returns recommended pre-deploy checks with reasoning. Use this before pre_deploy_audit to get dynamic, project-specific check recommendations.",
                inputSchema: zodToJsonSchema(analyzeProjectChecksSchema)
            },
            {
                name: "suspense_boundary_check",
                description: "Static analysis for Next.js App Router layouts. Detects auth hooks (useUser, useAuth, useSession) in 'use client' layouts that aren't wrapped in Suspense boundaries. These cause 'suspendIfSsr()' errors during static generation. Returns specific issues with fix suggestions.",
                inputSchema: zodToJsonSchema(suspenseBoundaryCheckSchema)
            },
        ],
    };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // Handle nested params structure (args might be {params: {...}} or {...})
    const toolArgs = args.params || args;
    // Debug logging
    console.error('[IC Debug] Tool called:', name);
    console.error('[IC Debug] Arguments received:', JSON.stringify(args, null, 2));
    try {
        if (name === "validate_tool_usage") {
            // @ts-ignore
            return formatResponse(await validateToolUsage(toolArgs));
        }
        if (name === "inspect_server_logs") {
            // @ts-ignore
            return formatResponse(await inspectServerLogs(toolArgs));
        }
        if (name === "validate_function_behavior") {
            // @ts-ignore
            return formatResponse(await validateFunctionBehavior(toolArgs));
        }
        if (name === "validate_typescript") {
            // @ts-ignore
            return formatResponse(await validateTypeScript(toolArgs));
        }
        if (name === "validate_typescript_batch") {
            // @ts-ignore
            return formatResponse(await validateTypeScriptBatch(toolArgs));
        }
        if (name === "pre_deploy_audit") {
            // @ts-ignore
            return formatResponse(await preDeployAudit(toolArgs));
        }
        if (name === "analyze_project_checks") {
            // @ts-ignore
            return formatResponse(await analyzeProjectChecks(toolArgs));
        }
        if (name === "suspense_boundary_check") {
            // @ts-ignore
            return formatResponse(await suspenseBoundaryCheck(toolArgs));
        }
        if (name === "validate_import_tree") {
            const params = toolArgs;
            return formatResponse(await validateImportTree(params));
        }
        if (name === "validate_import_tree_batch") {
            const { filePaths, recursive, checkTypes, projectRoot } = toolArgs;
            const results = await Promise.all(filePaths.map(filePath => validateImportTree({ filePath, recursive, checkTypes, projectRoot })));
            const errors = results.filter(r => r.status === "error");
            const successCount = results.length - errors.length;
            return formatResponse({
                status: "success",
                summary: `Batch import validation: ${successCount}/${results.length} files valid`,
                results: results.map((r, i) => ({ filePath: filePaths[i], ...r })),
                hint: errors.length > 0 ? "Review individual file errors" : null
            });
        }
        if (name === "validate_symbol_usage") {
            const params = toolArgs;
            return formatResponse(await validateSymbolUsage(params));
        }
        if (name === "validate_symbol_usage_batch") {
            const { symbols, projectRoot } = toolArgs;
            const results = await Promise.all(symbols.map(s => validateSymbolUsage({ ...s, projectRoot })));
            const foundCount = results.filter(r => r.found).length;
            return formatResponse({
                status: "success",
                summary: `Batch symbol validation: ${foundCount}/${results.length} symbols found/used`,
                results: results.map((r, i) => ({ symbol: symbols[i], ...r })),
            });
        }
        if (name === "validate_config_references") {
            const { configPath, referenceType, codebasePath } = toolArgs;
            try {
                const absoluteConfigPath = resolve(configPath);
                const absoluteCodebasePath = resolve(codebasePath);
                // Read config file
                const configContent = readFileSync(absoluteConfigPath, "utf-8");
                const config = JSON.parse(configContent);
                // Extract references based on type
                let references = [];
                if (referenceType === "plugins" && config.plugins) {
                    references = Array.isArray(config.plugins)
                        ? config.plugins
                        : Object.keys(config.plugins);
                }
                else if (referenceType === "services" && config.services) {
                    references = Array.isArray(config.services)
                        ? config.services
                        : Object.keys(config.services);
                }
                else if (referenceType === "modules" && config.modules) {
                    references = Array.isArray(config.modules)
                        ? config.modules
                        : Object.keys(config.modules);
                }
                else if (referenceType === "routes" && config.routes) {
                    references = Array.isArray(config.routes)
                        ? config.routes
                        : Object.keys(config.routes);
                }
                // Search for references in codebase
                const issues = [];
                const found = [];
                for (const ref of references) {
                    // Search for files/exports matching the reference
                    const patterns = [
                        `${absoluteCodebasePath}/**/${ref}.ts`,
                        `${absoluteCodebasePath}/**/${ref}.js`,
                        `${absoluteCodebasePath}/**/${ref}/index.ts`,
                        `${absoluteCodebasePath}/**/${ref}/index.js`,
                    ];
                    let fileFound = false;
                    for (const pattern of patterns) {
                        const matches = await glob(pattern);
                        if (matches.length > 0) {
                            found.push({
                                reference: ref,
                                file: matches[0],
                            });
                            fileFound = true;
                            break;
                        }
                    }
                    if (!fileFound) {
                        issues.push({
                            type: "missing_reference",
                            reference: ref,
                            message: `Config references '${ref}' but no matching file found in codebase`,
                            hint: `Create ${ref}.ts or ${ref}/index.ts in the appropriate directory`,
                        });
                    }
                }
                return formatResponse({
                    status: issues.length > 0 ? "error" : "success",
                    valid: issues.length === 0,
                    configType: referenceType,
                    totalReferences: references.length,
                    foundReferences: found.length,
                    issues,
                    found,
                    summary: issues.length > 0
                        ? `Found ${issues.length} missing references out of ${references.length}`
                        : `All ${references.length} ${referenceType} references are valid`,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Config validation failed: ${errorMessage}`,
                    hint: "Ensure config file exists and is valid JSON",
                });
            }
        }
        if (name === "analyze_dependency_graph") {
            const { entryPoint, checkCircular, maxDepth } = toolArgs;
            try {
                const absolutePath = resolve(entryPoint);
                const result = await madge(absolutePath, {
                    fileExtensions: ["ts", "js", "tsx", "jsx"],
                });
                const dependencies = result.obj();
                const circular = checkCircular !== false ? result.circular() : [];
                const orphans = result.orphans();
                const stats = {
                    totalModules: Object.keys(dependencies).length,
                    circularDependencies: circular.length,
                    orphanedModules: orphans.length,
                };
                const issues = [];
                // Report circular dependencies
                for (const cycle of circular) {
                    issues.push({
                        type: "circular_dependency",
                        cycle: cycle,
                        message: `Circular dependency: ${cycle.join(" -> ")}`,
                        hint: "Refactor to break the circular dependency",
                    });
                }
                // Report orphaned modules
                for (const orphan of orphans) {
                    issues.push({
                        type: "dead_code",
                        file: orphan,
                        message: `Orphaned module: ${orphan} (never imported)`,
                        hint: "Remove unused code or add import",
                    });
                }
                return formatResponse({
                    status: issues.length > 0 ? "error" : "success",
                    valid: issues.length === 0,
                    stats,
                    issues,
                    dependencyTree: dependencies,
                    summary: issues.length > 0
                        ? `Found ${circular.length} circular dependencies and ${orphans.length} orphaned modules`
                        : `Dependency graph is healthy: ${stats.totalModules} modules analyzed`,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Dependency analysis failed: ${errorMessage}`,
                    hint: "Ensure entry point exists and is a valid JavaScript/TypeScript file",
                });
            }
        }
        if (name === "audit_codebase_health") {
            const { projectRoot, checks, failFast } = toolArgs;
            try {
                const absoluteRoot = resolve(projectRoot);
                const allIssues = [];
                const results = {};
                // Find entry point (common patterns)
                const entryPatterns = [
                    join(absoluteRoot, "src/index.ts"),
                    join(absoluteRoot, "src/main.ts"),
                    join(absoluteRoot, "index.ts"),
                    join(absoluteRoot, "src/index.js"),
                ];
                let entryPoint = "";
                for (const pattern of entryPatterns) {
                    try {
                        readFileSync(pattern);
                        entryPoint = pattern;
                        break;
                    }
                    catch { }
                }
                // Run requested checks
                for (const check of checks) {
                    if (check === "dependencies" && entryPoint) {
                        try {
                            const result = await madge(entryPoint, {
                                fileExtensions: ["ts", "js", "tsx", "jsx"],
                            });
                            const circular = result.circular();
                            const orphans = result.orphans();
                            results.dependencies = {
                                status: circular.length === 0 && orphans.length === 0 ? "pass" : "fail",
                                circular: circular.length,
                                orphans: orphans.length,
                            };
                            for (const cycle of circular) {
                                allIssues.push({
                                    check: "dependencies",
                                    type: "circular_dependency",
                                    cycle: cycle,
                                });
                                if (failFast)
                                    break;
                            }
                        }
                        catch (error) {
                            results.dependencies = {
                                status: "error",
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                        if (failFast && allIssues.length > 0)
                            break;
                    }
                    if (check === "imports" && entryPoint) {
                        try {
                            let tsconfigPath = join(absoluteRoot, "tsconfig.json");
                            try {
                                readFileSync(tsconfigPath);
                            }
                            catch {
                                tsconfigPath = undefined;
                            }
                            let project = projectCache.get(absoluteRoot, tsconfigPath);
                            if (!project) {
                                project = new Project({
                                    tsConfigFilePath: tsconfigPath,
                                    skipAddingFilesFromTsConfig: true,
                                });
                                projectCache.set(absoluteRoot, project, tsconfigPath);
                            }
                            // Find all TypeScript files
                            const tsFiles = await glob(`${absoluteRoot}/**/*.ts`, {
                                ignore: ["**/node_modules/**", "**/dist/**"],
                            });
                            let importIssues = 0;
                            for (const file of tsFiles.slice(0, 50)) { // Limit for performance
                                project.addSourceFileAtPath(file);
                                const sourceFile = project.getSourceFile(file);
                                if (sourceFile) {
                                    for (const importDecl of sourceFile.getImportDeclarations()) {
                                        const moduleSpecifier = importDecl.getModuleSpecifierValue();
                                        if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
                                            const resolved = importDecl.getModuleSpecifierSourceFile();
                                            if (!resolved) {
                                                importIssues++;
                                                allIssues.push({
                                                    check: "imports",
                                                    type: "missing_import",
                                                    file: file,
                                                    import: moduleSpecifier,
                                                });
                                                if (failFast)
                                                    break;
                                            }
                                        }
                                    }
                                }
                                if (failFast && allIssues.length > 0)
                                    break;
                            }
                            results.imports = {
                                status: importIssues === 0 ? "pass" : "fail",
                                issues: importIssues,
                                filesChecked: Math.min(tsFiles.length, 50),
                            };
                        }
                        catch (error) {
                            results.imports = {
                                status: "error",
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                        if (failFast && allIssues.length > 0)
                            break;
                    }
                }
                return formatResponse({
                    status: allIssues.length > 0 ? "error" : "success",
                    valid: allIssues.length === 0,
                    checksRun: checks,
                    results,
                    totalIssues: allIssues.length,
                    issues: allIssues.slice(0, 20), // Limit output
                    summary: `Codebase audit completed: ${allIssues.length} issues found across ${checks.length} checks`,
                });
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return formatResponse({
                    status: "error",
                    message: `Audit failed: ${errorMessage}`,
                    hint: "Ensure project root is correct",
                });
            }
        }
        if (name === "trace_export_usage") {
            const params = toolArgs;
            return formatResponse(await traceExportUsage(params));
        }
        if (name === "run_knip") {
            const params = toolArgs;
            return formatResponse(await runKnip(params));
        }
        if (name === "analyze_export_impact") {
            const params = toolArgs;
            return formatResponse(await analyzeExportImpact(params));
        }
        throw new Error(`Unknown tool: ${name}`);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return formatResponse({
            status: "error",
            message: `Error: ${errorMessage}`,
            hint: "Check tool arguments and server logs",
        });
    }
});
// Start Server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Internal Code MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
//# sourceMappingURL=index-internal-code.js.map
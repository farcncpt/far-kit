import { z } from "zod";
import { spawnSync } from "child_process";
import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
// Default paths to clean when simulating CI
const DEFAULT_CLEAN_PATHS = [
    'node_modules/.prisma',
    '.next/types',
    '.next/dev/types',
];
// Clean generated types to simulate CI environment
function cleanGeneratedTypes(projectRoot, cleanPaths) {
    const paths = cleanPaths || DEFAULT_CLEAN_PATHS;
    const cleaned = [];
    const errors = [];
    for (const relativePath of paths) {
        const absolutePath = join(projectRoot, relativePath);
        if (existsSync(absolutePath)) {
            try {
                rmSync(absolutePath, { recursive: true, force: true });
                cleaned.push(relativePath);
            }
            catch (e) {
                errors.push(`Failed to clean ${relativePath}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    return { cleaned, errors };
}
// Detect and run type generators
function regenerateTypes(projectRoot) {
    const generators = [];
    let output = '';
    let success = true;
    // Check for Prisma
    const prismaSchemaPath = join(projectRoot, 'prisma', 'schema.prisma');
    const prismaPackageExists = existsSync(join(projectRoot, 'node_modules', '.bin', 'prisma')) ||
        existsSync(join(projectRoot, 'node_modules', 'prisma'));
    if (existsSync(prismaSchemaPath) && prismaPackageExists) {
        generators.push('prisma');
        try {
            const result = spawnSync('npx', ['prisma', 'generate'], {
                cwd: projectRoot,
                encoding: 'utf-8',
                timeout: 60000,
                shell: true,
            });
            output += `Prisma generate:\n${result.stdout || ''}${result.stderr || ''}\n`;
            if (result.status !== 0) {
                success = false;
            }
        }
        catch (e) {
            output += `Prisma generate failed: ${e instanceof Error ? e.message : String(e)}\n`;
            success = false;
        }
    }
    // Check for other common generators (drizzle-kit, etc.)
    const drizzleConfigExists = existsSync(join(projectRoot, 'drizzle.config.ts')) ||
        existsSync(join(projectRoot, 'drizzle.config.js'));
    if (drizzleConfigExists) {
        generators.push('drizzle (detected but not auto-generated)');
    }
    return { generators, success, output };
}
// Schema for the tool
export const validateTypeScriptSchema = z.object({
    projectRoot: z.string().describe("Path to the project root (where tsconfig.json is located)"),
    fix: z.boolean().default(false).describe("Attempt to auto-fix common issues"),
    include: z.array(z.string()).optional().describe("Specific files or patterns to check"),
    timeout: z.number().default(60000).describe("Timeout in milliseconds for tsc execution"),
    simulateCI: z.boolean().default(false).describe("Simulate CI environment by removing generated types (Prisma, .next) before validation"),
    regenerate: z.boolean().default(false).describe("Regenerate types after cleaning (runs prisma generate if detected)"),
    cleanPaths: z.array(z.string()).optional().describe("Custom paths to clean (default: node_modules/.prisma, .next/types)"),
});
// Auto-fix patterns for common TypeScript errors
const FIX_PATTERNS = [
    {
        // TS7006: Parameter 'x' implicitly has an 'any' type
        code: "TS7006",
        pattern: /Parameter '(\w+)' implicitly has an 'any' type/,
        category: "implicit-any",
        fix: (error, fileContent) => {
            const lines = fileContent.split('\n');
            const lineIndex = error.line - 1;
            const line = lines[lineIndex];
            if (!line)
                return null;
            // Check for common patterns and suggest fixes
            // Pattern 1: .map((x) => ...) - add typeof array[number]
            const mapPattern = /\.map\(\((\w+)\)\s*=>/;
            const mapMatch = line.match(mapPattern);
            if (mapMatch && mapMatch[1] === error.message.match(/Parameter '(\w+)'/)?.[1]) {
                // Find the array variable before .map
                const beforeMap = line.substring(0, line.indexOf('.map('));
                const arrayVarMatch = beforeMap.match(/(\w+(?:\.\w+)*)\s*$/);
                if (arrayVarMatch) {
                    const arrayVar = arrayVarMatch[1];
                    const paramName = mapMatch[1];
                    const newLine = line.replace(`.map((${paramName})`, `.map((${paramName}: (typeof ${arrayVar})[number])`);
                    lines[lineIndex] = newLine;
                    return {
                        fixed: true,
                        content: lines.join('\n'),
                        description: `Added type annotation: (typeof ${arrayVar})[number]`
                    };
                }
            }
            // Pattern 2: .filter((x) => ...) - same approach
            const filterPattern = /\.filter\(\((\w+)\)\s*=>/;
            const filterMatch = line.match(filterPattern);
            if (filterMatch && filterMatch[1] === error.message.match(/Parameter '(\w+)'/)?.[1]) {
                const beforeFilter = line.substring(0, line.indexOf('.filter('));
                const arrayVarMatch = beforeFilter.match(/(\w+(?:\.\w+)*)\s*$/);
                if (arrayVarMatch) {
                    const arrayVar = arrayVarMatch[1];
                    const paramName = filterMatch[1];
                    const newLine = line.replace(`.filter((${paramName})`, `.filter((${paramName}: (typeof ${arrayVar})[number])`);
                    lines[lineIndex] = newLine;
                    return {
                        fixed: true,
                        content: lines.join('\n'),
                        description: `Added type annotation: (typeof ${arrayVar})[number]`
                    };
                }
            }
            // Pattern 3: .forEach((x) => ...)
            const forEachPattern = /\.forEach\(\((\w+)\)\s*=>/;
            const forEachMatch = line.match(forEachPattern);
            if (forEachMatch && forEachMatch[1] === error.message.match(/Parameter '(\w+)'/)?.[1]) {
                const beforeForEach = line.substring(0, line.indexOf('.forEach('));
                const arrayVarMatch = beforeForEach.match(/(\w+(?:\.\w+)*)\s*$/);
                if (arrayVarMatch) {
                    const arrayVar = arrayVarMatch[1];
                    const paramName = forEachMatch[1];
                    const newLine = line.replace(`.forEach((${paramName})`, `.forEach((${paramName}: (typeof ${arrayVar})[number])`);
                    lines[lineIndex] = newLine;
                    return {
                        fixed: true,
                        content: lines.join('\n'),
                        description: `Added type annotation: (typeof ${arrayVar})[number]`
                    };
                }
            }
            // Pattern 4: .reduce((acc, x) => ...) - handle accumulator and current
            const reducePattern = /\.reduce\(\((\w+),\s*(\w+)\)\s*=>/;
            const reduceMatch = line.match(reducePattern);
            if (reduceMatch) {
                const paramName = error.message.match(/Parameter '(\w+)'/)?.[1];
                if (paramName === reduceMatch[2]) {
                    // Current value needs typing
                    const beforeReduce = line.substring(0, line.indexOf('.reduce('));
                    const arrayVarMatch = beforeReduce.match(/(\w+(?:\.\w+)*)\s*$/);
                    if (arrayVarMatch) {
                        const arrayVar = arrayVarMatch[1];
                        const accParam = reduceMatch[1];
                        const currParam = reduceMatch[2];
                        const newLine = line.replace(`.reduce((${accParam}, ${currParam})`, `.reduce((${accParam}, ${currParam}: (typeof ${arrayVar})[number])`);
                        lines[lineIndex] = newLine;
                        return {
                            fixed: true,
                            content: lines.join('\n'),
                            description: `Added type annotation: (typeof ${arrayVar})[number]`
                        };
                    }
                }
            }
            return null;
        }
    },
    {
        // TS2345: Argument of type 'X | undefined' is not assignable
        code: "TS2345",
        pattern: /Argument of type '.*\| undefined' is not assignable/,
        category: "possibly-undefined",
        fix: (error, fileContent) => {
            // This is informational - suggest using optional chaining or nullish coalescing
            return null; // Return null, but set fixable info in error parsing
        }
    },
    {
        // TS2531: Object is possibly 'null'
        code: "TS2531",
        pattern: /Object is possibly 'null'/,
        category: "null-check",
        fix: (error, fileContent) => {
            // Suggest adding null check - informational for now
            return null;
        }
    },
    {
        // TS2532: Object is possibly 'undefined'
        code: "TS2532",
        pattern: /Object is possibly 'undefined'/,
        category: "undefined-check",
        fix: (error, fileContent) => {
            // Suggest adding undefined check - informational for now
            return null;
        }
    },
    {
        // TS18046: 'x' is of type 'unknown'
        code: "TS18046",
        pattern: /'(\w+)' is of type 'unknown'/,
        category: "unknown-type",
        fix: (error, fileContent) => {
            // Suggest type assertion or type guard
            return null;
        }
    }
];
// Parse tsc output into structured errors
function parseTscOutput(output, projectRoot) {
    const errors = [];
    const lines = output.split('\n');
    // TypeScript error format: file(line,column): error TSxxxx: message
    const errorPattern = /^(.+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;
    for (const line of lines) {
        const match = line.match(errorPattern);
        if (match) {
            const [, file, lineNum, column, severity, code, message] = match;
            // Determine category and fixability
            let category = "other";
            let fixable = false;
            let suggestedFix = undefined;
            for (const fixPattern of FIX_PATTERNS) {
                if (code === fixPattern.code && fixPattern.pattern.test(message)) {
                    category = fixPattern.category;
                    fixable = fixPattern.fix !== null;
                    // Generate fix suggestion
                    if (category === "implicit-any") {
                        suggestedFix = {
                            description: "Add explicit type annotation using typeof",
                        };
                    }
                    else if (category === "possibly-undefined" || category === "null-check" || category === "undefined-check") {
                        suggestedFix = {
                            description: "Add null/undefined check or use optional chaining (?.) / nullish coalescing (??)",
                        };
                    }
                    else if (category === "unknown-type") {
                        suggestedFix = {
                            description: "Add type assertion (as Type) or type guard (if/typeof check)",
                        };
                    }
                    break;
                }
            }
            // Try to get line content for context
            let lineContent;
            try {
                const absolutePath = resolve(projectRoot, file);
                if (existsSync(absolutePath)) {
                    const content = readFileSync(absolutePath, 'utf-8');
                    const contentLines = content.split('\n');
                    lineContent = contentLines[parseInt(lineNum) - 1]?.trim();
                }
            }
            catch {
                // Ignore errors reading file
            }
            if (suggestedFix && lineContent) {
                suggestedFix.lineContent = lineContent;
            }
            errors.push({
                file: file.replace(/\\/g, '/'),
                line: parseInt(lineNum),
                column: parseInt(column),
                code,
                message,
                severity: severity,
                category,
                fixable,
                suggestedFix,
            });
        }
    }
    return errors;
}
// Apply auto-fixes to files
function applyFixes(errors, projectRoot) {
    const fileContents = new Map();
    const fixDetails = [];
    let fixed = 0;
    let failed = 0;
    // Group errors by file to avoid multiple reads
    const errorsByFile = new Map();
    for (const error of errors) {
        if (!error.fixable)
            continue;
        const existing = errorsByFile.get(error.file) || [];
        existing.push(error);
        errorsByFile.set(error.file, existing);
    }
    for (const [file, fileErrors] of errorsByFile) {
        const absolutePath = resolve(projectRoot, file);
        if (!existsSync(absolutePath)) {
            for (const error of fileErrors) {
                fixDetails.push({ file, line: error.line, description: "File not found", success: false });
                failed++;
            }
            continue;
        }
        let content = fileContents.get(absolutePath) || readFileSync(absolutePath, 'utf-8');
        // Sort errors by line number descending to apply fixes from bottom to top
        // This prevents line number shifts from affecting subsequent fixes
        const sortedErrors = [...fileErrors].sort((a, b) => b.line - a.line);
        for (const error of sortedErrors) {
            const fixPattern = FIX_PATTERNS.find(p => p.code === error.code);
            if (!fixPattern) {
                fixDetails.push({ file, line: error.line, description: "No fix pattern", success: false });
                failed++;
                continue;
            }
            const result = fixPattern.fix(error, content);
            if (result && result.fixed) {
                content = result.content;
                fixDetails.push({ file, line: error.line, description: result.description, success: true });
                fixed++;
            }
            else {
                fixDetails.push({ file, line: error.line, description: "Fix pattern did not match", success: false });
                failed++;
            }
        }
        // Write back the modified content
        if (fixed > 0) {
            fileContents.set(absolutePath, content);
            try {
                writeFileSync(absolutePath, content, 'utf-8');
            }
            catch (e) {
                // If write fails, revert the fix count
                const writtenFixes = fixDetails.filter(d => d.file === file && d.success);
                for (const f of writtenFixes) {
                    f.success = false;
                    f.description = `Write failed: ${e instanceof Error ? e.message : String(e)}`;
                    fixed--;
                    failed++;
                }
            }
        }
    }
    return { fixed, failed, details: fixDetails };
}
// Main validation function
export async function validateTypeScript(params) {
    const { projectRoot, fix, include, timeout, simulateCI, regenerate, cleanPaths } = params;
    const absoluteRoot = resolve(projectRoot);
    // Validate project root
    if (!existsSync(absoluteRoot)) {
        return {
            status: "error",
            message: `Project root not found: ${projectRoot}`,
            hint: "Provide a valid path to the project directory"
        };
    }
    // Check for tsconfig.json
    const tsconfigPath = join(absoluteRoot, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) {
        return {
            status: "error",
            message: `tsconfig.json not found in ${projectRoot}`,
            hint: "Ensure the project has a tsconfig.json file"
        };
    }
    // CI Simulation: Clean generated types
    let ciSimulation = null;
    if (simulateCI) {
        const cleanResult = cleanGeneratedTypes(absoluteRoot, cleanPaths);
        ciSimulation = {
            enabled: true,
            cleaned: cleanResult.cleaned,
            cleanErrors: cleanResult.errors,
            regenerated: null,
        };
        // Optionally regenerate types
        if (regenerate) {
            ciSimulation.regenerated = regenerateTypes(absoluteRoot);
        }
    }
    // Build tsc command
    let tscCommand = 'npx tsc --noEmit --pretty false';
    if (include && include.length > 0) {
        // If specific files are provided, check them
        tscCommand += ' ' + include.map(f => `"${f}"`).join(' ');
    }
    try {
        // Run tsc
        const startTime = Date.now();
        let stdout = '';
        let stderr = '';
        let exitCode = 0;
        try {
            const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
                cwd: absoluteRoot,
                encoding: 'utf-8',
                timeout,
                shell: true,
                maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large projects
            });
            stdout = result.stdout || '';
            stderr = result.stderr || '';
            exitCode = result.status || 0;
        }
        catch (e) {
            if (e.killed) {
                return {
                    status: "error",
                    message: `TypeScript compilation timed out after ${timeout}ms`,
                    hint: "Increase timeout or check for infinite loops in type definitions"
                };
            }
            throw e;
        }
        const duration = Date.now() - startTime;
        // Parse errors
        const output = stdout + stderr;
        const errors = parseTscOutput(output, absoluteRoot);
        // Group errors by category for summary
        const byCategory = errors.reduce((acc, err) => {
            acc[err.category] = (acc[err.category] || 0) + 1;
            return acc;
        }, {});
        // Group errors by file for file-level summary
        const byFile = errors.reduce((acc, err) => {
            acc[err.file] = (acc[err.file] || 0) + 1;
            return acc;
        }, {});
        // Apply fixes if requested
        let fixResult = null;
        if (fix && errors.some(e => e.fixable)) {
            fixResult = applyFixes(errors, absoluteRoot);
        }
        // Determine overall status
        const hasErrors = errors.some(e => e.severity === "error");
        // Build hint message
        let hint = hasErrors
            ? `Found ${errors.length} TypeScript errors. Run with fix:true to attempt auto-fixes for ${errors.filter(e => e.fixable).length} issues.`
            : "TypeScript validation passed with no errors";
        // Add CI simulation hint if relevant
        if (ciSimulation && hasErrors && !regenerate) {
            hint += " (simulateCI mode: types were cleaned. Try with regenerate:true to run prisma generate)";
        }
        return {
            status: hasErrors ? "error" : "success",
            valid: !hasErrors,
            duration: `${duration}ms`,
            ciSimulation: ciSimulation || undefined,
            summary: {
                total: errors.length,
                errors: errors.filter(e => e.severity === "error").length,
                warnings: errors.filter(e => e.severity === "warning").length,
                fixable: errors.filter(e => e.fixable).length,
                byCategory,
                byFile,
            },
            errors: errors.slice(0, 50), // Limit to first 50 for readability
            truncated: errors.length > 50,
            fixes: fixResult ? {
                applied: fixResult.fixed,
                failed: fixResult.failed,
                details: fixResult.details.slice(0, 20), // Limit details
            } : null,
            hint,
        };
    }
    catch (error) {
        return {
            status: "error",
            message: `TypeScript validation failed: ${error instanceof Error ? error.message : String(error)}`,
            hint: "Ensure TypeScript is installed and tsconfig.json is valid"
        };
    }
}
// Batch validation for multiple projects
export const validateTypeScriptBatchSchema = z.object({
    projects: z.array(z.object({
        projectRoot: z.string(),
        name: z.string().optional(),
    })).describe("Array of projects to validate"),
    fix: z.boolean().default(false).describe("Attempt to auto-fix common issues"),
    timeout: z.number().default(60000).describe("Timeout per project in milliseconds"),
    stopOnFirstError: z.boolean().default(false).describe("Stop on first project with errors"),
});
export async function validateTypeScriptBatch(params) {
    const { projects, fix, timeout, stopOnFirstError } = params;
    const results = [];
    let totalErrors = 0;
    let totalFixed = 0;
    for (const project of projects) {
        const result = await validateTypeScript({
            projectRoot: project.projectRoot,
            fix,
            timeout,
            simulateCI: false,
            regenerate: false,
        });
        const errorCount = result.summary?.errors || 0;
        totalErrors += errorCount;
        if (result.fixes?.applied) {
            totalFixed += result.fixes.applied;
        }
        results.push({
            name: project.name || project.projectRoot,
            projectRoot: project.projectRoot,
            status: result.status,
            errorCount,
            duration: result.duration || 'N/A',
        });
        if (stopOnFirstError && result.status === "error") {
            break;
        }
    }
    return {
        status: totalErrors > 0 ? "error" : "success",
        summary: {
            projectsChecked: results.length,
            projectsWithErrors: results.filter(r => r.status === "error").length,
            totalErrors,
            totalFixed,
        },
        results,
        hint: totalErrors > 0
            ? `Found errors in ${results.filter(r => r.status === "error").length} project(s)`
            : "All projects passed TypeScript validation"
    };
}
//# sourceMappingURL=validate_typescript.js.map
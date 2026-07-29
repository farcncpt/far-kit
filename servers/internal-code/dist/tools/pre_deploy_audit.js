import { z } from "zod";
import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { glob } from "glob";
import madge from "madge";
import { validateTypeScript } from "./validate_typescript.js";
import { suspenseBoundaryCheck } from "./suspense_boundary_check.js";
// Schema for the tool
export const preDeployAuditSchema = z.object({
    projectRoot: z.string().describe("Path to the project root directory"),
    checks: z.array(z.enum([
        "typescript", // TypeScript compilation
        "typescript-ci", // TypeScript with simulateCI (removes generated types)
        "imports", // Import resolution
        "circular", // Circular dependency detection
        "unused", // Unused exports/dead code (uses knip if available)
        "env", // Environment variable validation
        "suspense-boundaries", // Next.js App Router Suspense boundary check
    ])).default(["typescript-ci", "imports", "circular"]).describe("Which checks to run"),
    timeout: z.number().default(300000).describe("Total timeout in ms (default 5 minutes)"),
    failFast: z.boolean().default(false).describe("Stop on first critical error"),
    parallel: z.boolean().default(true).describe("Run independent checks in parallel"),
    verbose: z.boolean().default(false).describe("Include detailed output for each check"),
});
// Check: TypeScript Compilation
async function checkTypeScript(projectRoot, simulateCI, timeout) {
    const startTime = Date.now();
    const checkName = simulateCI ? "typescript-ci" : "typescript";
    try {
        const result = await validateTypeScript({
            projectRoot,
            fix: false,
            timeout,
            simulateCI,
            regenerate: false,
        });
        const duration = Date.now() - startTime;
        const errorCount = result.summary?.errors || 0;
        const warningCount = result.summary?.warnings || 0;
        return {
            name: checkName,
            status: errorCount > 0 ? "fail" : "pass",
            duration,
            summary: errorCount > 0
                ? `${errorCount} TypeScript errors found${simulateCI ? " (CI simulation)" : ""}`
                : `TypeScript compilation passed${simulateCI ? " (CI simulation)" : ""}`,
            errorCount,
            warningCount,
            errors: result.errors?.slice(0, 20),
            details: {
                ciSimulation: result.ciSimulation,
                byCategory: result.summary?.byCategory,
                byFile: result.summary?.byFile,
            }
        };
    }
    catch (error) {
        return {
            name: checkName,
            status: "error",
            duration: Date.now() - startTime,
            summary: `TypeScript check failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCount: 1,
            warningCount: 0,
        };
    }
}
// Check: Import Resolution
async function checkImports(projectRoot) {
    const startTime = Date.now();
    try {
        // Find all TypeScript/JavaScript files
        const files = await glob(`${projectRoot}/src/**/*.{ts,tsx,js,jsx}`, {
            ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**']
        });
        const issues = [];
        let checkedFiles = 0;
        // Simple import check - look for unresolved relative imports
        for (const file of files.slice(0, 100)) { // Limit for performance
            try {
                const content = readFileSync(file, 'utf-8');
                const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"](\.[^'"]+)['"]/g;
                let match;
                while ((match = importRegex.exec(content)) !== null) {
                    const importPath = match[1];
                    const resolvedPath = resolve(file, '..', importPath);
                    // Check common extensions
                    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
                    let found = false;
                    for (const ext of extensions) {
                        if (existsSync(resolvedPath + ext)) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        issues.push({
                            file: file.replace(projectRoot + '/', ''),
                            import: importPath,
                            message: `Unresolved import: ${importPath}`
                        });
                    }
                }
                checkedFiles++;
            }
            catch (err) {
                // Skip unreadable files
            }
        }
        const duration = Date.now() - startTime;
        return {
            name: "imports",
            status: issues.length > 0 ? "fail" : "pass",
            duration,
            summary: issues.length > 0
                ? `${issues.length} unresolved imports in ${checkedFiles} files`
                : `All imports resolved in ${checkedFiles} files`,
            errorCount: issues.length,
            warningCount: 0,
            errors: issues.slice(0, 20),
            details: { filesChecked: checkedFiles }
        };
    }
    catch (error) {
        return {
            name: "imports",
            status: "error",
            duration: Date.now() - startTime,
            summary: `Import check failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCount: 1,
            warningCount: 0,
        };
    }
}
// Check: Circular Dependencies
async function checkCircular(projectRoot) {
    const startTime = Date.now();
    try {
        // Find entry point
        const entryPoints = [
            join(projectRoot, 'src/index.ts'),
            join(projectRoot, 'src/main.ts'),
            join(projectRoot, 'src/app/layout.tsx'), // Next.js
            join(projectRoot, 'src/app/page.tsx'),
            join(projectRoot, 'index.ts'),
        ];
        let entryPoint = '';
        for (const ep of entryPoints) {
            if (existsSync(ep)) {
                entryPoint = ep;
                break;
            }
        }
        if (!entryPoint) {
            // Try to find any TypeScript file as entry
            const files = await glob(`${projectRoot}/src/**/*.{ts,tsx}`, {
                ignore: ['**/node_modules/**', '**/*.d.ts']
            });
            if (files.length > 0) {
                entryPoint = files[0];
            }
        }
        if (!entryPoint) {
            return {
                name: "circular",
                status: "skip",
                duration: Date.now() - startTime,
                summary: "No entry point found for dependency analysis",
                errorCount: 0,
                warningCount: 1,
            };
        }
        const result = await madge(entryPoint, {
            fileExtensions: ['ts', 'tsx', 'js', 'jsx'],
            excludeRegExp: [/node_modules/, /\.next/, /dist/],
        });
        const circular = result.circular();
        const duration = Date.now() - startTime;
        return {
            name: "circular",
            status: circular.length > 0 ? "warn" : "pass",
            duration,
            summary: circular.length > 0
                ? `${circular.length} circular dependency chains found`
                : "No circular dependencies detected",
            errorCount: 0,
            warningCount: circular.length,
            errors: circular.map(cycle => ({
                type: "circular",
                chain: cycle.join(" -> "),
            })),
            details: {
                totalModules: Object.keys(result.obj()).length,
                orphans: result.orphans().length,
            }
        };
    }
    catch (error) {
        return {
            name: "circular",
            status: "error",
            duration: Date.now() - startTime,
            summary: `Circular dependency check failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCount: 1,
            warningCount: 0,
        };
    }
}
// Check: Unused Exports (uses knip if available)
async function checkUnused(projectRoot, timeout) {
    const startTime = Date.now();
    try {
        // Check if knip is available
        const result = spawnSync('npx', ['knip', '--reporter', 'json'], {
            cwd: projectRoot,
            encoding: 'utf-8',
            timeout: Math.min(timeout, 120000), // Max 2 minutes for knip
            shell: true,
            maxBuffer: 10 * 1024 * 1024,
        });
        const duration = Date.now() - startTime;
        if (result.error || (!result.stdout && !result.stderr)) {
            return {
                name: "unused",
                status: "skip",
                duration,
                summary: "Knip not available or failed to run",
                errorCount: 0,
                warningCount: 1,
                details: { hint: "Install knip with 'npm install -D knip'" }
            };
        }
        // Parse knip output
        let knipResult;
        try {
            knipResult = JSON.parse(result.stdout || result.stderr || '{}');
        }
        catch {
            return {
                name: "unused",
                status: "pass",
                duration,
                summary: "No unused code detected by knip",
                errorCount: 0,
                warningCount: 0,
            };
        }
        const unusedFiles = knipResult.files?.length || 0;
        const unusedDeps = knipResult.dependencies?.length || 0;
        const unusedExports = knipResult.exports?.length || 0;
        const totalIssues = unusedFiles + unusedDeps + unusedExports;
        return {
            name: "unused",
            status: totalIssues > 0 ? "warn" : "pass",
            duration,
            summary: totalIssues > 0
                ? `Found ${unusedFiles} unused files, ${unusedDeps} unused deps, ${unusedExports} unused exports`
                : "No unused code detected",
            errorCount: 0,
            warningCount: totalIssues,
            details: {
                unusedFiles,
                unusedDependencies: unusedDeps,
                unusedExports,
                files: knipResult.files?.slice(0, 10),
                dependencies: knipResult.dependencies?.slice(0, 10),
            }
        };
    }
    catch (error) {
        return {
            name: "unused",
            status: "error",
            duration: Date.now() - startTime,
            summary: `Unused code check failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCount: 1,
            warningCount: 0,
        };
    }
}
// Check: Environment Variables
async function checkEnv(projectRoot) {
    const startTime = Date.now();
    try {
        const issues = [];
        // Check for .env.example or .env.local.example
        const envExamplePaths = [
            join(projectRoot, '.env.example'),
            join(projectRoot, '.env.local.example'),
            join(projectRoot, '.env.template'),
        ];
        let envExample = {};
        let envExamplePath = '';
        for (const path of envExamplePaths) {
            if (existsSync(path)) {
                envExamplePath = path;
                const content = readFileSync(path, 'utf-8');
                content.split('\n').forEach(line => {
                    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
                    if (match) {
                        envExample[match[1]] = '';
                    }
                });
                break;
            }
        }
        // Find env vars used in code
        const files = await glob(`${projectRoot}/src/**/*.{ts,tsx,js,jsx}`, {
            ignore: ['**/node_modules/**']
        });
        const usedEnvVars = new Set();
        const envVarRegex = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
        for (const file of files) {
            try {
                const content = readFileSync(file, 'utf-8');
                let match;
                while ((match = envVarRegex.exec(content)) !== null) {
                    usedEnvVars.add(match[1]);
                }
            }
            catch { }
        }
        // Check for undocumented env vars
        const undocumented = [];
        for (const envVar of usedEnvVars) {
            if (envExamplePath && !envExample.hasOwnProperty(envVar) && !envVar.startsWith('NEXT_PUBLIC_')) {
                undocumented.push(envVar);
            }
        }
        // Check for required vars without defaults
        const requiredVars = ['DATABASE_URL', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL'];
        const missingRequired = [];
        for (const reqVar of requiredVars) {
            if (usedEnvVars.has(reqVar)) {
                // Check if it's in .env.example
                if (envExamplePath && !envExample.hasOwnProperty(reqVar)) {
                    missingRequired.push(reqVar);
                }
            }
        }
        const duration = Date.now() - startTime;
        const totalIssues = undocumented.length + missingRequired.length;
        return {
            name: "env",
            status: totalIssues > 0 ? "warn" : "pass",
            duration,
            summary: totalIssues > 0
                ? `${undocumented.length} undocumented env vars, ${missingRequired.length} missing required vars`
                : `${usedEnvVars.size} env vars used, all documented`,
            errorCount: missingRequired.length,
            warningCount: undocumented.length,
            details: {
                totalEnvVars: usedEnvVars.size,
                undocumented: undocumented.slice(0, 10),
                missingRequired,
                envExampleFound: !!envExamplePath,
            }
        };
    }
    catch (error) {
        return {
            name: "env",
            status: "error",
            duration: Date.now() - startTime,
            summary: `Env check failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCount: 1,
            warningCount: 0,
        };
    }
}
// Check: Suspense Boundaries (Next.js App Router with auth hooks)
async function checkSuspenseBoundaries(projectRoot) {
    const startTime = Date.now();
    try {
        const result = await suspenseBoundaryCheck({ projectRoot, verbose: false });
        const duration = Date.now() - startTime;
        if (result.status === "error") {
            return {
                name: "suspense-boundaries",
                status: "error",
                duration,
                summary: result.summary,
                errorCount: 1,
                warningCount: 0,
            };
        }
        const errorCount = result.issues.length;
        return {
            name: "suspense-boundaries",
            status: errorCount > 0 ? "fail" : "pass",
            duration,
            summary: result.summary,
            errorCount,
            warningCount: 0,
            errors: result.issues.map(i => ({
                file: i.file,
                line: i.line,
                message: i.message,
                suggestion: i.suggestion,
            })),
            details: {
                layoutsChecked: result.layoutsChecked,
                recommendation: result.recommendation,
            }
        };
    }
    catch (error) {
        return {
            name: "suspense-boundaries",
            status: "error",
            duration: Date.now() - startTime,
            summary: `Suspense boundary check failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCount: 1,
            warningCount: 0,
        };
    }
}
// Main audit function
export async function preDeployAudit(params) {
    const { projectRoot, checks, timeout, failFast, parallel, verbose } = params;
    const absoluteRoot = resolve(projectRoot);
    const startTime = Date.now();
    // Validate project root
    if (!existsSync(absoluteRoot)) {
        return {
            status: "error",
            projectRoot: absoluteRoot,
            timestamp: new Date().toISOString(),
            totalDuration: 0,
            checks: [],
            summary: { passed: 0, failed: 0, warnings: 0, skipped: 0, totalErrors: 1, totalWarnings: 0 },
            criticalIssues: [`Project root not found: ${projectRoot}`],
            recommendations: ["Verify the project path is correct"],
            hint: "Project root does not exist"
        };
    }
    const results = [];
    const criticalIssues = [];
    // Define check functions
    const checkFunctions = {
        "typescript": () => checkTypeScript(absoluteRoot, false, timeout / 2),
        "typescript-ci": () => checkTypeScript(absoluteRoot, true, timeout / 2),
        "imports": () => checkImports(absoluteRoot),
        "circular": () => checkCircular(absoluteRoot),
        "unused": () => checkUnused(absoluteRoot, timeout / 3),
        "env": () => checkEnv(absoluteRoot),
        "suspense-boundaries": () => checkSuspenseBoundaries(absoluteRoot),
    };
    // Run checks
    if (parallel) {
        // Run all checks in parallel
        const promises = checks.map(check => checkFunctions[check]?.() || Promise.resolve({
            name: check,
            status: "skip",
            duration: 0,
            summary: `Unknown check: ${check}`,
            errorCount: 0,
            warningCount: 0,
        }));
        const checkResults = await Promise.all(promises);
        results.push(...checkResults);
    }
    else {
        // Run checks sequentially
        for (const check of checks) {
            const checkFn = checkFunctions[check];
            if (checkFn) {
                const result = await checkFn();
                results.push(result);
                // Fail fast on critical errors
                if (failFast && result.status === "fail" && result.errorCount > 0) {
                    criticalIssues.push(`${result.name}: ${result.summary}`);
                    break;
                }
            }
        }
    }
    // Aggregate results
    const summary = {
        passed: results.filter(r => r.status === "pass").length,
        failed: results.filter(r => r.status === "fail").length,
        warnings: results.filter(r => r.status === "warn").length,
        skipped: results.filter(r => r.status === "skip" || r.status === "error").length,
        totalErrors: results.reduce((sum, r) => sum + r.errorCount, 0),
        totalWarnings: results.reduce((sum, r) => sum + r.warningCount, 0),
    };
    // Collect critical issues
    for (const result of results) {
        if (result.status === "fail") {
            criticalIssues.push(`${result.name}: ${result.summary}`);
        }
    }
    // Generate recommendations
    const recommendations = [];
    for (const result of results) {
        if (result.name === "typescript-ci" && result.status === "fail") {
            recommendations.push("Fix TypeScript errors before deploying - CI environment will fail");
        }
        if (result.name === "circular" && result.status === "warn") {
            recommendations.push("Consider refactoring circular dependencies for better maintainability");
        }
        if (result.name === "unused" && result.status === "warn") {
            recommendations.push("Remove unused code to reduce bundle size");
        }
        if (result.name === "env" && result.status === "warn") {
            recommendations.push("Document all environment variables in .env.example");
        }
        if (result.name === "suspense-boundaries" && result.status === "fail") {
            recommendations.push("Wrap auth hooks in Suspense boundaries - layouts using useUser/useAuth will fail during Next.js static generation");
        }
    }
    const totalDuration = Date.now() - startTime;
    const overallStatus = summary.failed > 0 ? "fail" : "pass";
    // Clean up results if not verbose
    const cleanResults = results.map(r => {
        if (!verbose) {
            const { errors, details, ...rest } = r;
            return {
                ...rest,
                errors: errors?.slice(0, 5),
            };
        }
        return r;
    });
    return {
        status: overallStatus,
        projectRoot: absoluteRoot,
        timestamp: new Date().toISOString(),
        totalDuration,
        checks: cleanResults,
        summary,
        criticalIssues,
        recommendations,
        hint: overallStatus === "pass"
            ? `All ${summary.passed} checks passed in ${(totalDuration / 1000).toFixed(1)}s - ready to deploy!`
            : `${summary.failed} checks failed, ${summary.totalErrors} errors found - fix before deploying`
    };
}
//# sourceMappingURL=pre_deploy_audit.js.map
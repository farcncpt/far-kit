#!/usr/bin/env node
/**
 * Truth Seeker CLI
 *
 * Static analysis CLI that scans Next.js projects for common issues
 * that cause 500 errors, missing imports, bad exports, and runtime crashes.
 *
 * Usage:
 *   truth-seeker scan /path/to/project
 *   truth-seeker routes /path/to/project
 *   truth-seeker health /path/to/project
 *   truth-seeker validate-ssr /path/to/project
 *   truth-seeker validate-runtime-types /path/to/project
 */
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { validateCodePatterns } from './tools/validate_runtime_types.js';
// ========================================
// COLORS (ANSI escape codes)
// ========================================
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
// ========================================
// UTILITY FUNCTIONS
// ========================================
async function findFiles(dir, pattern, results = []) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git' || entry.name === 'dist') {
                    continue;
                }
                await findFiles(fullPath, pattern, results);
            }
            else if (pattern.test(entry.name)) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // skip inaccessible dirs
    }
    return results;
}
function extractImports(code) {
    const imports = [];
    // Match: import X from 'module', import { X } from 'module', import 'module'
    const importRegex = /import\s+(?:(?:\{[^}]*\}|[\w*]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(code)) !== null) {
        imports.push(match[1]);
    }
    // Dynamic imports
    const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicRegex.exec(code)) !== null) {
        imports.push(match[1]);
    }
    return imports;
}
function getRoutePathFromFile(filePath, srcDir) {
    let rel = path.relative(srcDir, filePath);
    // Remove src/app prefix
    rel = rel.replace(/^src[\/\\]app[\/\\]/, '');
    // Remove route group prefixes like (storefront)
    rel = rel.replace(/\([^)]+\)[\/\\]/g, '');
    // Remove filename
    rel = rel.replace(/[\/\\](route|page|layout|loading|error|not-found)\.(ts|tsx|js|jsx)$/, '');
    // Convert to URL path
    rel = '/' + rel.replace(/\\/g, '/');
    // Handle dynamic segments
    rel = rel.replace(/\[\.\.\.(\w+)\]/g, ':$1*');
    rel = rel.replace(/\[(\w+)\]/g, ':$1');
    return rel === '/.' ? '/' : rel;
}
// ========================================
// ROUTE ANALYSIS
// ========================================
const KNOWN_PROBLEMATIC_IMPORTS = [
    '@pucksh/',
    'puck-editor',
    '@measured/puck',
];
const NEXT_ROUTE_EXPORTS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const NEXT_PAGE_EXPORTS = ['default', 'metadata', 'generateMetadata', 'generateStaticParams'];
function analyzeRouteFile(filePath, code, type) {
    const issues = [];
    const lines = code.split('\n');
    // 1. Check for problematic imports (e.g., Puck remnants)
    const imports = extractImports(code);
    for (const imp of imports) {
        for (const prob of KNOWN_PROBLEMATIC_IMPORTS) {
            if (imp.includes(prob)) {
                const lineNum = lines.findIndex(l => l.includes(imp)) + 1;
                issues.push({
                    severity: 'critical',
                    message: `Problematic import: "${imp}" (Puck remnant or removed package)`,
                    line: lineNum,
                    suggestion: `Remove or replace this import - the package may not be installed`
                });
            }
        }
    }
    // 2. Check for missing local imports (relative imports that don't resolve)
    for (const imp of imports) {
        if (imp.startsWith('.') || imp.startsWith('@/')) {
            // Resolve relative to file
            let resolvedBase;
            if (imp.startsWith('@/')) {
                // @/ alias typically maps to src/
                const projectRoot = filePath.replace(/[\/\\]src[\/\\].*$/, '');
                resolvedBase = path.join(projectRoot, 'src', imp.slice(2));
            }
            else {
                resolvedBase = path.join(path.dirname(filePath), imp);
            }
            // Check common extensions
            const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
            const found = extensions.some(ext => existsSync(resolvedBase + ext));
            if (!found) {
                const lineNum = lines.findIndex(l => l.includes(imp)) + 1;
                issues.push({
                    severity: 'critical',
                    message: `Missing import: "${imp}" - file not found`,
                    line: lineNum,
                    suggestion: `Check the import path. File might have been moved or deleted.`
                });
            }
        }
    }
    // 3. For API routes, check exports
    if (type === 'api') {
        const hasValidExport = NEXT_ROUTE_EXPORTS.some(exp => {
            const regex = new RegExp(`export\\s+(async\\s+)?function\\s+${exp}\\b|export\\s+(?:const|let)\\s+${exp}\\s*=`);
            return regex.test(code);
        });
        if (!hasValidExport) {
            issues.push({
                severity: 'critical',
                message: `No valid HTTP method export (GET, POST, PUT, DELETE, PATCH)`,
                suggestion: `API route must export named functions: export async function GET(req) { ... }`
            });
        }
    }
    // 4. For page routes, check default export
    if (type === 'page') {
        const hasDefault = /export\s+default\s+/.test(code) ||
            /export\s*\{\s*[^}]*\bas\s+default\b/.test(code);
        if (!hasDefault) {
            issues.push({
                severity: 'critical',
                message: `No default export - page will 500`,
                suggestion: `Add: export default function Page() { ... }`
            });
        }
    }
    // 5. Check for unguarded database calls (no try-catch)
    const dbPatterns = [
        /prisma\.\w+\.(findMany|findUnique|findFirst|create|update|delete|upsert|count|aggregate)/g,
        /db\.\w+\.(findMany|findUnique|findFirst|create|update|delete|upsert|count|aggregate)/g,
        /\.query\s*\(/g,
        /await\s+fetch\s*\(/g,
    ];
    for (const pattern of dbPatterns) {
        let match;
        while ((match = pattern.exec(code)) !== null) {
            // Check if this call is inside a try-catch
            const beforeMatch = code.slice(0, match.index);
            const tryCount = (beforeMatch.match(/\btry\s*\{/g) || []).length;
            const catchCount = (beforeMatch.match(/\bcatch\s*[\(\{]/g) || []).length;
            // Rough heuristic: if we see more try's than catches before this point,
            // we're likely inside a try block
            if (tryCount <= catchCount) {
                const lineNum = code.slice(0, match.index).split('\n').length;
                issues.push({
                    severity: 'warning',
                    message: `Database/fetch call without try-catch: "${match[0].trim()}"`,
                    line: lineNum,
                    suggestion: `Wrap in try-catch to prevent unhandled 500 errors`
                });
            }
        }
    }
    // 6. Check for accessing params without await (Next.js 15+ requires await params)
    const paramsAwaitPattern = /(?:const|let)\s*\{[^}]*\}\s*=\s*(?:props\.)?params\b/g;
    let paramMatch;
    while ((paramMatch = paramsAwaitPattern.exec(code)) !== null) {
        // Check if there's an "await" before params
        const lineStart = code.lastIndexOf('\n', paramMatch.index) + 1;
        const lineContent = code.slice(lineStart, paramMatch.index + paramMatch[0].length);
        if (!lineContent.includes('await')) {
            const lineNum = code.slice(0, paramMatch.index).split('\n').length;
            issues.push({
                severity: 'error',
                message: `Params destructured without await (Next.js 15+ requires await)`,
                line: lineNum,
                suggestion: `Use: const { slug } = await params;`
            });
        }
    }
    // 7. Check for searchParams without await (Next.js 15+)
    const searchParamsPattern = /(?:const|let)\s*\{[^}]*\}\s*=\s*(?:props\.)?searchParams\b/g;
    let spMatch;
    while ((spMatch = searchParamsPattern.exec(code)) !== null) {
        const lineStart = code.lastIndexOf('\n', spMatch.index) + 1;
        const lineContent = code.slice(lineStart, spMatch.index + spMatch[0].length);
        if (!lineContent.includes('await')) {
            const lineNum = code.slice(0, spMatch.index).split('\n').length;
            issues.push({
                severity: 'error',
                message: `searchParams destructured without await (Next.js 15+ requires await)`,
                line: lineNum,
                suggestion: `Use: const { page } = await searchParams;`
            });
        }
    }
    // 8. Check for 'use client' + async component (invalid combo)
    if (code.includes("'use client'") || code.includes('"use client"')) {
        const asyncDefaultMatch = /export\s+default\s+async\s+function/.test(code);
        if (asyncDefaultMatch) {
            issues.push({
                severity: 'critical',
                message: `"use client" with async default export - client components cannot be async`,
                suggestion: `Remove "use client" or make the component synchronous`
            });
        }
    }
    // 9. Check for server-only imports in client components
    if (code.includes("'use client'") || code.includes('"use client"')) {
        const serverOnlyImports = ['server-only', '@/lib/db', 'prisma', '@/lib/stack'];
        for (const soi of serverOnlyImports) {
            if (imports.some(i => i.includes(soi))) {
                const lineNum = lines.findIndex(l => l.includes(soi)) + 1;
                issues.push({
                    severity: 'critical',
                    message: `Server-only import "${soi}" in "use client" component`,
                    line: lineNum,
                    suggestion: `Move server logic to a Server Component or API route`
                });
            }
        }
    }
    // 10. Check for empty catch blocks that swallow errors silently
    const emptyCatchRegex = /catch\s*\([^)]*\)\s*\{\s*\}/g;
    let catchMatch;
    while ((catchMatch = emptyCatchRegex.exec(code)) !== null) {
        const lineNum = code.slice(0, catchMatch.index).split('\n').length;
        issues.push({
            severity: 'warning',
            message: `Empty catch block - errors are silently swallowed`,
            line: lineNum,
            suggestion: `Log the error or return an appropriate error response`
        });
    }
    return issues;
}
// ========================================
// COMMANDS
// ========================================
async function commandRoutes(projectPath) {
    console.log(`\n${BOLD}${CYAN}=== Truth Seeker: Route Analysis ===${RESET}`);
    console.log(`${DIM}Project: ${projectPath}${RESET}\n`);
    const appDir = path.join(projectPath, 'src', 'app');
    if (!existsSync(appDir)) {
        console.log(`${RED}Error: No src/app directory found at ${appDir}${RESET}`);
        return;
    }
    // Find all route/page files
    const routeFiles = await findFiles(appDir, /^(route|page|layout|loading|error|not-found)\.(ts|tsx|js|jsx)$/);
    const routes = [];
    let totalIssues = 0;
    let criticalCount = 0;
    let errorCount = 0;
    let warningCount = 0;
    for (const filePath of routeFiles) {
        const fileName = path.basename(filePath).replace(/\.(ts|tsx|js|jsx)$/, '');
        let type;
        switch (fileName) {
            case 'route':
                type = 'api';
                break;
            case 'page':
                type = 'page';
                break;
            case 'layout':
                type = 'layout';
                break;
            case 'loading':
                type = 'loading';
                break;
            case 'error':
                type = 'error';
                break;
            case 'not-found':
                type = 'not-found';
                break;
            default: type = 'page';
        }
        let code;
        try {
            code = readFileSync(filePath, 'utf-8');
        }
        catch {
            continue;
        }
        const relativePath = path.relative(projectPath, filePath);
        const routePath = getRoutePathFromFile(filePath, projectPath);
        const issues = analyzeRouteFile(filePath, code, type);
        // Also run runtime type pattern check on route files
        const runtimeResult = validateCodePatterns({ code, filename: relativePath });
        for (const issue of runtimeResult.issues) {
            if (issue.severity === 'critical') {
                issues.push({
                    severity: 'critical',
                    message: `Runtime type risk: ${issue.message}`,
                    line: issue.location?.line,
                    suggestion: issue.suggestion
                });
            }
        }
        routes.push({ filePath, relativePath, routePath, type, issues });
        totalIssues += issues.length;
        criticalCount += issues.filter(i => i.severity === 'critical').length;
        errorCount += issues.filter(i => i.severity === 'error').length;
        warningCount += issues.filter(i => i.severity === 'warning').length;
    }
    // Print results
    const routesWithIssues = routes.filter(r => r.issues.length > 0);
    const cleanRoutes = routes.filter(r => r.issues.length === 0);
    // Summary
    console.log(`${BOLD}Found ${routes.length} route files${RESET}`);
    console.log(`  ${GREEN}Clean: ${cleanRoutes.length}${RESET}`);
    console.log(`  ${RED}With issues: ${routesWithIssues.length}${RESET}`);
    console.log(`  ${RED}Critical: ${criticalCount}${RESET} | ${YELLOW}Error: ${errorCount}${RESET} | ${DIM}Warning: ${warningCount}${RESET}`);
    console.log('');
    // Print issues grouped by route
    for (const route of routesWithIssues) {
        const typeLabel = route.type === 'api' ? `${BLUE}API${RESET}` : `${CYAN}PAGE${RESET}`;
        console.log(`${BOLD}${route.routePath}${RESET} [${typeLabel}]`);
        console.log(`  ${DIM}${route.relativePath}${RESET}`);
        for (const issue of route.issues) {
            const severityColor = issue.severity === 'critical' ? RED : issue.severity === 'error' ? YELLOW : DIM;
            const severityLabel = issue.severity.toUpperCase().padEnd(8);
            const lineInfo = issue.line ? ` (line ${issue.line})` : '';
            console.log(`  ${severityColor}${severityLabel}${RESET} ${issue.message}${lineInfo}`);
            if (issue.suggestion) {
                console.log(`  ${DIM}         -> ${issue.suggestion}${RESET}`);
            }
        }
        console.log('');
    }
    // Print clean routes summary
    if (cleanRoutes.length > 0) {
        console.log(`${GREEN}${BOLD}Clean routes (${cleanRoutes.length}):${RESET}`);
        for (const route of cleanRoutes) {
            console.log(`  ${GREEN}OK${RESET} ${route.routePath} [${route.type}]`);
        }
        console.log('');
    }
}
async function commandHealth(projectPath) {
    console.log(`\n${BOLD}${CYAN}=== Truth Seeker: Health Check ===${RESET}`);
    console.log(`${DIM}Project: ${projectPath}${RESET}\n`);
    const checks = [];
    // 1. Check for .env and DATABASE_URL
    const envPath = path.join(projectPath, '.env');
    const envLocalPath = path.join(projectPath, '.env.local');
    let hasEnv = false;
    let hasDbUrl = false;
    let envDetails = [];
    for (const ep of [envPath, envLocalPath]) {
        if (existsSync(ep)) {
            hasEnv = true;
            try {
                const envContent = readFileSync(ep, 'utf-8');
                if (envContent.includes('DATABASE_URL')) {
                    hasDbUrl = true;
                    // Check if it's actually set (not empty)
                    const dbMatch = envContent.match(/DATABASE_URL\s*=\s*(.+)/);
                    if (dbMatch && dbMatch[1].trim()) {
                        envDetails.push(`DATABASE_URL found in ${path.basename(ep)}`);
                    }
                    else {
                        envDetails.push(`DATABASE_URL is empty in ${path.basename(ep)}`);
                        hasDbUrl = false;
                    }
                }
                // Check other critical env vars
                const criticalVars = ['NEXT_PUBLIC_APP_URL', 'ENCRYPTION_KEY'];
                for (const v of criticalVars) {
                    const varMatch = envContent.match(new RegExp(`${v}\\s*=\\s*(.+)`));
                    if (!varMatch || !varMatch[1].trim()) {
                        envDetails.push(`Missing or empty: ${v}`);
                    }
                }
            }
            catch { /* skip */ }
        }
    }
    checks.push({
        name: 'Environment Files',
        status: hasEnv ? (hasDbUrl ? 'pass' : 'warn') : 'fail',
        message: hasEnv
            ? (hasDbUrl ? 'Environment configured' : 'Env file found but DATABASE_URL missing/empty')
            : 'No .env or .env.local file found',
        details: envDetails.length > 0 ? envDetails : undefined
    });
    // 2. Check package.json for problematic dependencies
    const pkgPath = path.join(projectPath, 'package.json');
    const depIssues = [];
    if (existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            // Check for Puck remnants
            for (const dep of Object.keys(allDeps)) {
                if (dep.includes('puck') || dep.includes('@measured/')) {
                    depIssues.push(`Puck dependency found: ${dep} - may cause import errors if not properly configured`);
                }
            }
            // Check for version conflicts
            if (allDeps['next']) {
                const nextVersion = allDeps['next'].replace(/[\^~]/, '');
                const majorVersion = parseInt(nextVersion.split('.')[0]);
                if (majorVersion >= 15) {
                    depIssues.push(`Next.js ${allDeps['next']} - params/searchParams must be awaited in page components`);
                }
            }
        }
        catch { /* skip */ }
    }
    checks.push({
        name: 'Dependencies',
        status: depIssues.length === 0 ? 'pass' : 'warn',
        message: depIssues.length === 0 ? 'No problematic dependencies' : `${depIssues.length} dependency concern(s)`,
        details: depIssues.length > 0 ? depIssues : undefined
    });
    // 3. Check node_modules exists
    const nodeModulesExists = existsSync(path.join(projectPath, 'node_modules'));
    checks.push({
        name: 'Node Modules',
        status: nodeModulesExists ? 'pass' : 'fail',
        message: nodeModulesExists ? 'node_modules present' : 'node_modules missing - run npm install'
    });
    // 4. Check for TypeScript config
    const tsconfigPath = path.join(projectPath, 'tsconfig.json');
    let tsIssues = [];
    if (existsSync(tsconfigPath)) {
        try {
            const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
            if (!tsconfig.compilerOptions?.strict) {
                tsIssues.push('strict mode not enabled - consider enabling for better type safety');
            }
            if (!tsconfig.compilerOptions?.strictNullChecks && !tsconfig.compilerOptions?.strict) {
                tsIssues.push('strictNullChecks not enabled - null/undefined errors may slip through');
            }
        }
        catch { /* skip */ }
    }
    checks.push({
        name: 'TypeScript Config',
        status: existsSync(tsconfigPath) ? (tsIssues.length === 0 ? 'pass' : 'warn') : 'fail',
        message: existsSync(tsconfigPath) ? 'tsconfig.json found' : 'No tsconfig.json found',
        details: tsIssues.length > 0 ? tsIssues : undefined
    });
    // 5. Check Prisma schema
    const prismaSchemaPath = path.join(projectPath, 'prisma', 'schema.prisma');
    const prismaExists = existsSync(prismaSchemaPath);
    let prismaIssues = [];
    if (prismaExists) {
        // Check if prisma client is generated
        const prismaClientPath = path.join(projectPath, 'node_modules', '.prisma', 'client');
        if (!existsSync(prismaClientPath)) {
            prismaIssues.push('Prisma client not generated - run: npx prisma generate');
        }
    }
    checks.push({
        name: 'Prisma Setup',
        status: prismaExists ? (prismaIssues.length === 0 ? 'pass' : 'warn') : 'warn',
        message: prismaExists ? 'Prisma schema found' : 'No Prisma schema found',
        details: prismaIssues.length > 0 ? prismaIssues : undefined
    });
    // 6. Check for missing imports in key route files (spot check)
    const appDir = path.join(projectPath, 'src', 'app');
    let missingImports = [];
    if (existsSync(appDir)) {
        const routeFiles = await findFiles(appDir, /^(route|page)\.(ts|tsx|js|jsx)$/);
        // Check a sample of files for broken imports
        for (const rf of routeFiles) {
            try {
                const code = readFileSync(rf, 'utf-8');
                const imports = extractImports(code);
                for (const imp of imports) {
                    if (imp.startsWith('.') || imp.startsWith('@/')) {
                        let resolvedBase;
                        if (imp.startsWith('@/')) {
                            resolvedBase = path.join(projectPath, 'src', imp.slice(2));
                        }
                        else {
                            resolvedBase = path.join(path.dirname(rf), imp);
                        }
                        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
                        const found = extensions.some(ext => existsSync(resolvedBase + ext));
                        if (!found) {
                            const rel = path.relative(projectPath, rf);
                            missingImports.push(`${rel}: import "${imp}" not found`);
                        }
                    }
                }
            }
            catch { /* skip */ }
        }
    }
    checks.push({
        name: 'Import Resolution',
        status: missingImports.length === 0 ? 'pass' : 'fail',
        message: missingImports.length === 0
            ? 'All local imports resolve'
            : `${missingImports.length} broken import(s) found`,
        details: missingImports.length > 0 ? missingImports.slice(0, 20) : undefined
    });
    // 7. Check middleware.ts
    const middlewarePath = path.join(projectPath, 'src', 'middleware.ts');
    const middlewareAltPath = path.join(projectPath, 'middleware.ts');
    const mwPath = existsSync(middlewarePath) ? middlewarePath : existsSync(middlewareAltPath) ? middlewareAltPath : null;
    let mwIssues = [];
    if (mwPath) {
        try {
            const mwCode = readFileSync(mwPath, 'utf-8');
            if (!mwCode.includes('export function middleware') && !mwCode.includes('export default') && !mwCode.includes('export const middleware')) {
                mwIssues.push('No middleware export found');
            }
            if (!mwCode.includes('matcher') && !mwCode.includes('config')) {
                mwIssues.push('No route matcher config - middleware runs on ALL routes');
            }
        }
        catch { /* skip */ }
    }
    checks.push({
        name: 'Middleware',
        status: mwPath ? (mwIssues.length === 0 ? 'pass' : 'warn') : 'pass',
        message: mwPath ? 'Middleware found' : 'No middleware (OK)',
        details: mwIssues.length > 0 ? mwIssues : undefined
    });
    // 8. Check for common 500-error patterns across the project
    const errorPatterns = [];
    if (existsSync(appDir)) {
        const allTsFiles = await findFiles(appDir, /\.(ts|tsx)$/);
        for (const f of allTsFiles) {
            try {
                const code = readFileSync(f, 'utf-8');
                const rel = path.relative(projectPath, f);
                // Check for 'use server' in files that import client-side modules
                if (code.includes("'use server'")) {
                    const clientImports = ['useState', 'useEffect', 'useRef', 'useCallback', 'useMemo', 'useContext'];
                    for (const ci of clientImports) {
                        if (code.includes(ci)) {
                            errorPatterns.push(`${rel}: "use server" file imports client hook "${ci}"`);
                        }
                    }
                }
                // Check for top-level throw without catch
                if (/^throw\s+new\s+/m.test(code)) {
                    errorPatterns.push(`${rel}: Top-level throw statement`);
                }
            }
            catch { /* skip */ }
        }
    }
    checks.push({
        name: 'Error Patterns',
        status: errorPatterns.length === 0 ? 'pass' : 'warn',
        message: errorPatterns.length === 0
            ? 'No common error patterns detected'
            : `${errorPatterns.length} potential error pattern(s)`,
        details: errorPatterns.length > 0 ? errorPatterns.slice(0, 15) : undefined
    });
    // Print results
    console.log(`${BOLD}Health Check Results:${RESET}\n`);
    let passCount = 0;
    let failCount = 0;
    let warnCount = 0;
    for (const check of checks) {
        const icon = check.status === 'pass' ? `${GREEN}PASS${RESET}`
            : check.status === 'fail' ? `${RED}FAIL${RESET}`
                : `${YELLOW}WARN${RESET}`;
        console.log(`  ${icon}  ${BOLD}${check.name}${RESET}: ${check.message}`);
        if (check.details) {
            for (const detail of check.details) {
                console.log(`         ${DIM}${detail}${RESET}`);
            }
        }
        if (check.status === 'pass')
            passCount++;
        else if (check.status === 'fail')
            failCount++;
        else
            warnCount++;
    }
    console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${passCount} pass${RESET} | ${YELLOW}${warnCount} warn${RESET} | ${RED}${failCount} fail${RESET}\n`);
}
async function commandScan(projectPath) {
    console.log(`\n${BOLD}${CYAN}=== Truth Seeker: Full Scan ===${RESET}`);
    console.log(`${DIM}Project: ${projectPath}${RESET}\n`);
    // Run health check
    await commandHealth(projectPath);
    console.log(`${BOLD}${CYAN}--- Route Analysis ---${RESET}\n`);
    // Run routes
    await commandRoutes(projectPath);
    // Run runtime type analysis on key files
    console.log(`${BOLD}${CYAN}--- Runtime Type Analysis ---${RESET}\n`);
    const appDir = path.join(projectPath, 'src', 'app');
    if (!existsSync(appDir)) {
        console.log(`${RED}No src/app directory found${RESET}`);
        return;
    }
    const tsFiles = await findFiles(appDir, /\.(ts|tsx)$/);
    let totalRuntimeIssues = 0;
    let criticalFiles = [];
    for (const f of tsFiles) {
        try {
            const code = readFileSync(f, 'utf-8');
            const rel = path.relative(projectPath, f);
            const result = validateCodePatterns({ code, filename: rel });
            if (result.issues.length > 0) {
                const criticals = result.issues.filter(i => i.severity === 'critical').length;
                if (criticals > 0) {
                    criticalFiles.push({ file: rel, issues: criticals });
                }
                totalRuntimeIssues += result.issues.length;
            }
        }
        catch { /* skip */ }
    }
    if (criticalFiles.length > 0) {
        console.log(`${RED}${BOLD}Files with critical runtime type issues:${RESET}`);
        for (const cf of criticalFiles.sort((a, b) => b.issues - a.issues)) {
            console.log(`  ${RED}${cf.issues} critical${RESET} - ${cf.file}`);
        }
    }
    else {
        console.log(`${GREEN}No critical runtime type issues found${RESET}`);
    }
    console.log(`\n${BOLD}Total runtime type issues: ${totalRuntimeIssues}${RESET}\n`);
}
async function commandValidateSSR(projectPath) {
    console.log(`\n${BOLD}${CYAN}=== Truth Seeker: SSR Validation ===${RESET}`);
    console.log(`${DIM}Project: ${projectPath}${RESET}\n`);
    const appDir = path.join(projectPath, 'src', 'app');
    if (!existsSync(appDir)) {
        console.log(`${RED}No src/app directory found${RESET}`);
        return;
    }
    const pageFiles = await findFiles(appDir, /^page\.(ts|tsx|js|jsx)$/);
    console.log(`Found ${pageFiles.length} page components\n`);
    for (const pagePath of pageFiles) {
        const rel = path.relative(projectPath, pagePath);
        try {
            const code = readFileSync(pagePath, 'utf-8');
            // Check for server-side data fetching patterns
            const hasAsyncDefault = /export\s+default\s+async\s+function/.test(code);
            const hasUseClient = code.includes("'use client'") || code.includes('"use client"');
            const hasSuspense = code.includes('Suspense');
            const hasErrorBoundary = code.includes('ErrorBoundary') || code.includes('error.tsx');
            const issues = [];
            if (hasAsyncDefault && hasUseClient) {
                issues.push('async default export + "use client" = WILL CRASH');
            }
            if (hasAsyncDefault && !hasSuspense) {
                issues.push('async component without Suspense boundary');
            }
            const status = issues.length === 0 ? `${GREEN}OK${RESET}` : `${RED}ISSUES${RESET}`;
            console.log(`${status} ${rel}`);
            for (const issue of issues) {
                console.log(`    ${YELLOW}${issue}${RESET}`);
            }
        }
        catch {
            console.log(`${RED}ERROR${RESET} ${rel} - could not read file`);
        }
    }
}
async function commandValidateRuntimeTypes(projectPath) {
    console.log(`\n${BOLD}${CYAN}=== Truth Seeker: Runtime Type Validation ===${RESET}`);
    console.log(`${DIM}Project: ${projectPath}${RESET}\n`);
    const srcDir = path.join(projectPath, 'src');
    if (!existsSync(srcDir)) {
        console.log(`${RED}No src directory found${RESET}`);
        return;
    }
    const tsFiles = await findFiles(srcDir, /\.(ts|tsx)$/);
    console.log(`Scanning ${tsFiles.length} TypeScript files...\n`);
    let totalIssues = 0;
    let totalCritical = 0;
    const fileResults = [];
    for (const f of tsFiles) {
        try {
            const code = readFileSync(f, 'utf-8');
            const rel = path.relative(projectPath, f);
            const result = validateCodePatterns({ code, filename: rel });
            if (result.issues.length > 0) {
                const criticals = result.issues.filter(i => i.severity === 'critical').length;
                const errors = result.issues.filter(i => i.severity === 'error').length;
                const warnings = result.issues.filter(i => i.severity === 'warning').length;
                totalIssues += result.issues.length;
                totalCritical += criticals;
                if (criticals > 0 || errors > 0) {
                    fileResults.push({ file: rel, critical: criticals, errors, warnings });
                }
            }
        }
        catch { /* skip */ }
    }
    if (fileResults.length > 0) {
        console.log(`${BOLD}Files with type issues:${RESET}\n`);
        for (const fr of fileResults.sort((a, b) => b.critical - a.critical)) {
            const parts = [];
            if (fr.critical > 0)
                parts.push(`${RED}${fr.critical} critical${RESET}`);
            if (fr.errors > 0)
                parts.push(`${YELLOW}${fr.errors} error${RESET}`);
            if (fr.warnings > 0)
                parts.push(`${DIM}${fr.warnings} warning${RESET}`);
            console.log(`  ${parts.join(', ')} - ${fr.file}`);
        }
    }
    console.log(`\n${BOLD}Total: ${totalIssues} issues (${totalCritical} critical) across ${tsFiles.length} files${RESET}\n`);
}
// ========================================
// MAIN
// ========================================
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        printUsage();
        process.exit(1);
    }
    const command = args[0];
    // Handle case where first arg is a path (default to scan)
    let projectPath;
    let actualCommand;
    if (['scan', 'routes', 'health', 'validate-ssr', 'validate-runtime-types'].includes(command)) {
        actualCommand = command;
        projectPath = args[1] || process.cwd();
    }
    else {
        // First arg is the project path, default command is scan
        actualCommand = 'scan';
        projectPath = command;
    }
    // Resolve to absolute path
    projectPath = path.resolve(projectPath);
    if (!existsSync(projectPath)) {
        console.error(`${RED}Error: Project path does not exist: ${projectPath}${RESET}`);
        process.exit(1);
    }
    switch (actualCommand) {
        case 'scan':
            await commandScan(projectPath);
            break;
        case 'routes':
            await commandRoutes(projectPath);
            break;
        case 'health':
            await commandHealth(projectPath);
            break;
        case 'validate-ssr':
            await commandValidateSSR(projectPath);
            break;
        case 'validate-runtime-types':
            await commandValidateRuntimeTypes(projectPath);
            break;
        default:
            console.error(`${RED}Unknown command: ${actualCommand}${RESET}`);
            printUsage();
            process.exit(1);
    }
}
function printUsage() {
    console.log(`
${BOLD}Truth Seeker CLI${RESET} - Static analysis for Next.js projects

${BOLD}Usage:${RESET}
  truth-seeker <command> <project-path>
  truth-seeker <project-path>              # defaults to 'scan'

${BOLD}Commands:${RESET}
  scan                    Run all validators (health + routes + runtime types)
  routes                  Find all routes and analyze for 500-error risks
  health                  Check DB connectivity, env vars, missing imports, TS config
  validate-ssr            Check SSR pages for common rendering issues
  validate-runtime-types  Scan all TypeScript files for runtime type risks

${BOLD}Examples:${RESET}
  truth-seeker scan ./my-nextjs-app
  truth-seeker routes /path/to/project
  truth-seeker health .
`);
}
main().catch(err => {
    console.error(`${RED}Fatal error: ${err.message}${RESET}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map
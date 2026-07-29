/**
 * MCP Server backed by the Rust refactor-runtime binary.
 *
 * Delegates all heavy lifting to the compiled Rust binary via child_process,
 * eliminating ts-morph startup overhead (~17s → <1s per call on WSL).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs';
const execFileAsync = promisify(execFile);
// Resolve the Rust binary path relative to this file
const RUST_BINARY = (() => {
    // Check env override first
    if (process.env.REFACTOR_RUNTIME_BIN)
        return process.env.REFACTOR_RUNTIME_BIN;
    // Default: sibling rust project's release binary
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const candidates = [
        path.resolve(thisDir, '../../../../rust/target/release/refactor-runtime'),
        path.resolve(thisDir, '../../../../rust/target/debug/refactor-runtime'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c))
            return c;
    }
    // Fallback: assume it's on PATH
    return 'refactor-runtime';
})();
// 5 minute timeout for large projects
const EXEC_TIMEOUT = 300_000;
async function runRust(args) {
    try {
        const { stdout, stderr } = await execFileAsync(RUST_BINARY, args, {
            maxBuffer: 50 * 1024 * 1024, // 50MB
            timeout: EXEC_TIMEOUT,
        });
        if (stderr)
            console.error(stderr);
        return JSON.parse(stdout);
    }
    catch (err) {
        // If the process produced stdout before failing, try to parse it
        if (err.stdout) {
            try {
                return JSON.parse(err.stdout);
            }
            catch { }
        }
        throw new Error(err.stderr || err.message || String(err));
    }
}
const server = new McpServer({
    name: 'refactor-runtime',
    version: '0.2.0-rust',
});
// ─── refactor_scan ───
server.tool('refactor_scan', 'Scan a codebase and return structural analysis — file count, imports, exports, dependency stats', { projectRoot: z.string().describe('Path to the project root directory') }, async ({ projectRoot }) => {
    try {
        const result = await runRust(['scan', path.resolve(projectRoot), '--output', 'json']);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_move ───
server.tool('refactor_move', 'Move a file or folder and automatically rewrite all imports/exports. Supports single files, directories (folder move), and detects API route changes in Next.js projects.', {
    oldPath: z.string().describe('Current file or directory path'),
    newPath: z.string().describe('Target file or directory path'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ oldPath, newPath, dryRun }) => {
    try {
        const args = ['move', path.resolve(oldPath), path.resolve(newPath)];
        if (dryRun)
            args.push('--dry-run');
        const result = await runRust(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_move_bulk ───
server.tool('refactor_move_bulk', 'Process multiple file moves from a manifest and rewrite all affected imports', {
    manifest: z.object({
        moves: z.array(z.object({
            oldPath: z.string(),
            newPath: z.string(),
            timestamp: z.string(),
        })),
        projectRoot: z.string(),
        dryRun: z.boolean(),
    }).describe('Move manifest with list of operations'),
}, async ({ manifest }) => {
    try {
        // Write manifest to temp file, pass via --manifest
        const tmpPath = path.join('/tmp', `refactor-manifest-${Date.now()}.json`);
        fs.writeFileSync(tmpPath, JSON.stringify(manifest));
        const args = ['move', 'dummy', 'dummy', '--manifest', tmpPath];
        if (manifest.dryRun)
            args.push('--dry-run');
        const result = await runRust(args);
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_analyze_impact ───
server.tool('refactor_analyze_impact', 'Analyze the cascading impact of changes to a file — traces all downstream effects', {
    file: z.string().describe('File to analyze'),
    sinceCommit: z.string().optional().describe('Compare against this git commit'),
}, async ({ file, sinceCommit }) => {
    try {
        const args = ['impact', path.resolve(file), '--output', 'json'];
        if (sinceCommit)
            args.push('--since', sinceCommit);
        const result = await runRust(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_auto_fix ───
server.tool('refactor_auto_fix', 'Apply mechanical auto-fixes for cascading effects. Returns remaining tasks that need manual/AI attention', {
    impactReport: z.any().describe('Impact report from refactor_analyze_impact'),
    dryRun: z.boolean().optional().describe('Preview fixes without applying'),
}, async ({ impactReport, dryRun }) => {
    try {
        // For auto-fix, use the impact command with --auto-fix flag
        const file = impactReport?.reports?.[0]?.change?.file
            || impactReport?.change?.file
            || impactReport?.file;
        if (!file)
            throw new Error('Cannot determine file from impact report');
        const args = ['impact', path.resolve(file), '--output', 'json', '--auto-fix'];
        if (dryRun)
            args.push('--generate-tasks');
        const result = await runRust(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_dependency_graph ───
server.tool('refactor_dependency_graph', 'Get the full dependency graph for a codebase or specific entry point', {
    projectRoot: z.string().describe('Project root directory'),
    entryPoint: z.string().optional().describe('Optional entry point file'),
    maxDepth: z.number().optional().describe('Maximum traversal depth'),
}, async ({ projectRoot, entryPoint, maxDepth }) => {
    try {
        const args = ['analyze', path.resolve(projectRoot), '--output', 'json', '--circular', '--orphans'];
        if (maxDepth)
            args.push('--depth', String(maxDepth));
        const result = await runRust(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_dry_run ───
server.tool('refactor_dry_run', 'Preview all changes from a move or impact operation without executing', {
    operations: z.array(z.object({
        oldPath: z.string(),
        newPath: z.string(),
        timestamp: z.string(),
    })).describe('List of move operations to preview'),
}, async ({ operations }) => {
    try {
        if (operations.length === 0) {
            return { content: [{ type: 'text', text: JSON.stringify({ results: [], totalAffected: 0 }) }] };
        }
        // Use first operation as single move with --dry-run
        const op = operations[0];
        const args = ['move', path.resolve(op.oldPath), path.resolve(op.newPath), '--dry-run'];
        const result = await runRust(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_rollback ───
server.tool('refactor_rollback', 'Undo a previous refactoring operation using the audit log', {
    auditLogId: z.string().describe('Audit log ID to rollback'),
}, async ({ auditLogId }) => {
    try {
        const result = await runRust(['rollback', auditLogId]);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_scan_routes ───
server.tool('refactor_scan_routes', 'Scan a codebase for all Next.js route handlers and their API route URLs', {
    projectRoot: z.string().describe('Path to the project root directory'),
}, async ({ projectRoot }) => {
    try {
        // Scan and filter for route files from the JSON output
        const scanResult = await runRust(['scan', path.resolve(projectRoot), '--output', 'json']);
        const routes = [];
        for (const file of scanResult.files || []) {
            const rel = file.relative_path || file.path;
            // Detect Next.js route patterns
            const routeMatch = rel.match(/^src\/app\/(.+?)\/route\.(ts|js)x?$/);
            const pageMatch = rel.match(/^src\/app\/(.+?)\/page\.(ts|js)x?$/);
            if (routeMatch) {
                const routePath = '/' + routeMatch[1].replace(/\(.*?\)\/?/g, '').replace(/\[\.{3}(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1');
                routes.push({ file: rel, route: routePath });
            }
            else if (pageMatch) {
                const routePath = '/' + pageMatch[1].replace(/\(.*?\)\/?/g, '').replace(/\[\.{3}(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1');
                routes.push({ file: rel, route: routePath });
            }
        }
        routes.sort((a, b) => a.route.localeCompare(b.route));
        return { content: [{ type: 'text', text: JSON.stringify({ projectRoot, totalRoutes: routes.length, routes }, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_delete ───
server.tool('refactor_delete', 'Delete a file and auto-clean all imports referencing it', {
    file: z.string().describe('File to delete'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ file, dryRun }) => {
    try {
        // Rust CLI doesn't have delete yet — fall back to scan + manual
        const absFile = path.resolve(file);
        const projectRoot = findProjectRoot(absFile);
        const scanResult = await runRust(['scan', projectRoot, '--output', 'json']);
        // Find all files that import the target
        const relTarget = path.relative(projectRoot, absFile);
        const affectedFiles = [];
        for (const f of scanResult.files || []) {
            for (const imp of f.imports || []) {
                if (imp.resolved_path && path.resolve(imp.resolved_path) === absFile) {
                    affectedFiles.push({ path: f.relative_path, imports: imp.specifiers?.length || 1 });
                }
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify({
                        targetFile: relTarget,
                        affectedFiles,
                        totalImportsToRemove: affectedFiles.reduce((s, f) => s + f.imports, 0),
                        dryRun: dryRun ?? true,
                        note: dryRun ? 'Dry run — no changes applied' : 'Use the TS backend for actual delete operations',
                    }, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_rename ───
server.tool('refactor_rename', 'Rename an exported symbol across the entire codebase', {
    file: z.string().describe('File containing the export'),
    oldName: z.string().describe('Current export name'),
    newName: z.string().describe('New export name'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ file, oldName, newName, dryRun }) => {
    try {
        const absFile = path.resolve(file);
        const projectRoot = findProjectRoot(absFile);
        const scanResult = await runRust(['scan', projectRoot, '--output', 'json']);
        // Find all importers of the target symbol
        const affectedFiles = [];
        for (const f of scanResult.files || []) {
            for (const imp of f.imports || []) {
                if (imp.resolved_path && path.resolve(imp.resolved_path) === absFile) {
                    const matching = (imp.specifiers || []).filter((s) => s.name === oldName || s.alias === oldName);
                    if (matching.length > 0) {
                        affectedFiles.push({
                            path: f.relative_path,
                            rewrites: matching.map((s) => `${s.name} → ${newName}`),
                        });
                    }
                }
            }
        }
        return { content: [{ type: 'text', text: JSON.stringify({
                        oldName,
                        newName,
                        sourceFile: path.relative(projectRoot, absFile),
                        affectedFiles,
                        totalRewrites: affectedFiles.reduce((s, f) => s + f.rewrites.length, 0),
                        dryRun: dryRun ?? true,
                    }, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_dead_code ───
server.tool('refactor_dead_code', 'Find unreachable dead code from entry points', {
    projectRoot: z.string().describe('Project root directory'),
    entryPoints: z.array(z.string()).optional().describe('Entry point files'),
}, async ({ projectRoot, entryPoints }) => {
    try {
        const args = ['analyze', path.resolve(projectRoot), '--output', 'json', '--orphans'];
        if (entryPoints && entryPoints.length > 0) {
            args.push('--depth', '100');
        }
        const result = await runRust(args);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_ui_audit ───
server.tool('refactor_ui_audit', 'Detect UI issues: missing handlers, unused state, missing keys in React/JSX', {
    projectRoot: z.string().describe('Project root directory'),
}, async ({ projectRoot }) => {
    try {
        // UI audit requires enriched AST parsing — not yet in Rust
        // Return a helpful message pointing to the TS backend
        return { content: [{ type: 'text', text: JSON.stringify({
                        note: 'UI audit requires enriched AST parsing (JSX elements, symbol usages). Use the TypeScript MCP server for this tool, or run: node ts/dist/bin/refactor-runtime.js ui-audit ' + projectRoot,
                    }, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_deps_audit ───
server.tool('refactor_deps_audit', 'Find unused npm dependencies and undeclared imports', {
    projectRoot: z.string().describe('Project root directory'),
}, async ({ projectRoot }) => {
    try {
        // Deps audit: scan imports and compare against package.json
        const absRoot = path.resolve(projectRoot);
        const scanResult = await runRust(['scan', absRoot, '--output', 'json']);
        const pkgPath = path.join(absRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) {
            throw new Error('No package.json found at ' + pkgPath);
        }
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const declared = new Set([
            ...Object.keys(pkg.dependencies || {}),
            ...Object.keys(pkg.devDependencies || {}),
            ...Object.keys(pkg.peerDependencies || {}),
        ]);
        const usedPackages = new Set();
        for (const file of scanResult.files || []) {
            for (const imp of file.imports || []) {
                const src = imp.source;
                if (src && !src.startsWith('.') && !src.startsWith('/') && !src.startsWith('#')) {
                    // Extract package name (handle scoped packages)
                    const parts = src.split('/');
                    const pkgName = src.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
                    usedPackages.add(pkgName);
                }
            }
        }
        const unused = [...declared].filter(d => !usedPackages.has(d)).sort();
        const undeclared = [...usedPackages].filter(u => !declared.has(u) && !isBuiltin(u)).sort();
        return { content: [{ type: 'text', text: JSON.stringify({
                        totalDeclared: declared.size,
                        totalUsed: usedPackages.size,
                        unused,
                        undeclared,
                    }, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── refactor_env_audit ───
server.tool('refactor_env_audit', 'Detect env variable drift between code and .env files', {
    projectRoot: z.string().describe('Project root directory'),
    envFiles: z.array(z.string()).optional().describe('Env files to check'),
}, async ({ projectRoot, envFiles }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        const scanResult = await runRust(['scan', absRoot, '--output', 'json']);
        // Extract env vars from code (process.env.X patterns)
        const codeEnvVars = new Set();
        for (const file of scanResult.files || []) {
            const filePath = path.resolve(absRoot, file.relative_path || file.path);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                const matches = content.matchAll(/process\.env\.(\w+)/g);
                for (const m of matches)
                    codeEnvVars.add(m[1]);
                const metaMatches = content.matchAll(/import\.meta\.env\.(\w+)/g);
                for (const m of metaMatches)
                    codeEnvVars.add(m[1]);
            }
        }
        // Read env files
        const envFileList = envFiles?.map(f => path.resolve(absRoot, f))
            ?? ['.env', '.env.local', '.env.production', '.env.example']
                .map(f => path.join(absRoot, f))
                .filter(f => fs.existsSync(f));
        const definedVars = new Set();
        for (const ef of envFileList) {
            if (fs.existsSync(ef)) {
                const content = fs.readFileSync(ef, 'utf-8');
                const matches = content.matchAll(/^([A-Z_][A-Z0-9_]*)\s*=/gm);
                for (const m of matches)
                    definedVars.add(m[1]);
            }
        }
        const missingInEnv = [...codeEnvVars].filter(v => !definedVars.has(v)).sort();
        const unusedInCode = [...definedVars].filter(v => !codeEnvVars.has(v)).sort();
        return { content: [{ type: 'text', text: JSON.stringify({
                        envFilesChecked: envFileList.map(f => path.relative(absRoot, f)),
                        codeEnvVarCount: codeEnvVars.size,
                        definedInEnvFiles: definedVars.size,
                        missingInEnv,
                        unusedInCode,
                    }, null, 2) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
});
// ─── Helpers ───
function findProjectRoot(filePath) {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return path.dirname(filePath);
}
function isBuiltin(name) {
    const builtins = new Set([
        'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns',
        'events', 'fs', 'http', 'http2', 'https', 'net', 'os', 'path', 'perf_hooks',
        'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers',
        'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
        'node:assert', 'node:buffer', 'node:child_process', 'node:cluster',
        'node:crypto', 'node:dgram', 'node:dns', 'node:events', 'node:fs',
        'node:http', 'node:http2', 'node:https', 'node:net', 'node:os', 'node:path',
        'node:perf_hooks', 'node:process', 'node:querystring', 'node:readline',
        'node:stream', 'node:string_decoder', 'node:timers', 'node:tls', 'node:tty',
        'node:url', 'node:util', 'node:v8', 'node:vm', 'node:worker_threads', 'node:zlib',
    ]);
    return builtins.has(name);
}
// ─── Main ───
async function main() {
    console.error(`Refactor Runtime MCP server (Rust backend) starting...`);
    console.error(`Binary: ${RUST_BINARY}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Refactor Runtime MCP server (Rust backend) running on stdio');
}
main().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
});

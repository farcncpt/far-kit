/**
 * MCP Server backed by a persistent Rust refactor-runtime process.
 *
 * Spawns `refactor-runtime serve <projectRoot>` once and communicates via
 * JSON-line protocol over stdin/stdout. Graph stays in memory across calls.
 * Expected latency: <500ms per tool call after initial scan.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const execFileAsync = promisify(execFile);
// Resolve the Rust binary path relative to this file
const RUST_BINARY = (() => {
    if (process.env.REFACTOR_RUNTIME_BIN)
        return process.env.REFACTOR_RUNTIME_BIN;
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        // far-kit bundle layout: <server-root>/bin/refactor-runtime[.exe]
        path.resolve(thisDir, '../../../bin/refactor-runtime'),
        path.resolve(thisDir, '../../../../rust/target/release/refactor-runtime'),
        path.resolve(thisDir, '../../../../rust/target/debug/refactor-runtime'),
        path.resolve(thisDir, '../../../rust/target/release/refactor-runtime'),
        path.resolve(thisDir, '../../../rust/target/debug/refactor-runtime'),
    ];
    // On Windows, also try .exe variants
    const withExe = candidates.flatMap(c => [c, c + '.exe']);
    for (const c of withExe) {
        if (fs.existsSync(c))
            return c;
    }
    return 'refactor-runtime';
})();
// ─── Persistent Process Manager ───
let rustProcess = null;
let rustRL = null;
let currentProjectRoot = null;
let nextRequestId = 1;
const pendingRequests = new Map();
const COMMAND_TIMEOUT = 300_000; // 5 minutes
async function ensureProcess(projectRoot) {
    const absRoot = path.resolve(projectRoot);
    // If already running for this project root, nothing to do
    if (rustProcess && currentProjectRoot === absRoot && !rustProcess.killed) {
        return;
    }
    // Kill old process if project root changed or process died
    await killProcess();
    return new Promise((resolve, reject) => {
        console.error(`[mcp] Spawning: ${RUST_BINARY} serve ${absRoot}`);
        const proc = spawn(RUST_BINARY, ['serve', absRoot], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        rustProcess = proc;
        currentProjectRoot = absRoot;
        // Forward stderr for debug logging
        proc.stderr?.on('data', (data) => {
            console.error(`[rust] ${data.toString().trimEnd()}`);
        });
        proc.on('error', (err) => {
            console.error(`[mcp] Rust process error: ${err.message}`);
            rejectAllPending(err);
            rustProcess = null;
            currentProjectRoot = null;
        });
        proc.on('exit', (code, signal) => {
            console.error(`[mcp] Rust process exited: code=${code} signal=${signal}`);
            rejectAllPending(new Error(`Rust process exited unexpectedly (code=${code})`));
            rustProcess = null;
            currentProjectRoot = null;
            if (rustRL) {
                rustRL.close();
                rustRL = null;
            }
        });
        // Set up line reader on stdout
        const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
        rustRL = rl;
        let gotReady = false;
        rl.on('line', (line) => {
            line = line.trim();
            if (!line)
                return;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                console.error(`[mcp] Non-JSON from Rust stdout: ${line}`);
                return;
            }
            // Handle the initial ready signal
            if (!gotReady && parsed.ready === true) {
                gotReady = true;
                console.error('[mcp] Rust serve process ready');
                resolve();
                return;
            }
            // Handle responses to commands
            if (parsed.id !== undefined) {
                const pending = pendingRequests.get(parsed.id);
                if (pending) {
                    pendingRequests.delete(parsed.id);
                    if (parsed.error) {
                        pending.reject(new Error(parsed.error));
                    }
                    else {
                        pending.resolve(parsed.result);
                    }
                }
                return;
            }
        });
        rl.on('close', () => {
            if (!gotReady) {
                reject(new Error('Rust process closed stdout before sending ready signal'));
            }
        });
        // Timeout for initial ready
        setTimeout(() => {
            if (!gotReady) {
                killProcess();
                reject(new Error('Timeout waiting for Rust serve process to become ready'));
            }
        }, 60_000);
    });
}
async function sendCommand(command, args = {}) {
    if (!rustProcess || rustProcess.killed || !rustProcess.stdin) {
        throw new Error('Rust process not running');
    }
    const id = nextRequestId++;
    const request = JSON.stringify({ id, command, args }) + '\n';
    return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        rustProcess.stdin.write(request, (err) => {
            if (err) {
                pendingRequests.delete(id);
                reject(new Error(`Failed to write to Rust stdin: ${err.message}`));
            }
        });
        // Timeout per command
        setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error(`Command '${command}' timed out after ${COMMAND_TIMEOUT}ms`));
            }
        }, COMMAND_TIMEOUT);
    });
}
function rejectAllPending(err) {
    for (const [id, pending] of pendingRequests) {
        pending.reject(err);
    }
    pendingRequests.clear();
}
async function killProcess() {
    if (rustProcess && !rustProcess.killed) {
        rustProcess.stdin?.end();
        rustProcess.kill();
        // Wait briefly for exit
        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, 2000);
            rustProcess?.on('exit', () => { clearTimeout(timeout); resolve(); });
        });
    }
    rustProcess = null;
    currentProjectRoot = null;
    if (rustRL) {
        rustRL.close();
        rustRL = null;
    }
}
// ─── Fallback: one-shot exec for commands that don't use the serve protocol ───
async function runRustOneShot(args) {
    try {
        const { stdout, stderr } = await execFileAsync(RUST_BINARY, args, {
            maxBuffer: 50 * 1024 * 1024,
            timeout: COMMAND_TIMEOUT,
        });
        if (stderr)
            console.error(stderr);
        return JSON.parse(stdout);
    }
    catch (err) {
        if (err.stdout) {
            try {
                return JSON.parse(err.stdout);
            }
            catch { }
        }
        throw new Error(err.stderr || err.message || String(err));
    }
}
// ─── Helpers ───
function toolResult(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function toolError(err) {
    return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
    };
}
// Detect the project root from a file path
function findProjectRoot(filePath) {
    let dir = path.dirname(path.resolve(filePath));
    while (true) {
        if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return path.dirname(path.resolve(filePath));
}
// ─── MCP Server Setup ───
const server = new McpServer({
    name: 'refactor-runtime',
    version: '0.3.0',
});
// ─── refactor_scan ───
server.tool('refactor_scan', 'Scan a codebase and return structural analysis — file count, imports, exports, dependency stats', { projectRoot: z.string().describe('Path to the project root directory') }, async ({ projectRoot }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('scan', {});
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_move ───
server.tool('refactor_move', 'Move a file or folder and automatically rewrite all imports/exports. Supports single files, directories (folder move), and detects API route changes in Next.js projects.', {
    oldPath: z.string().describe('Current file or directory path'),
    newPath: z.string().describe('Target file or directory path'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ oldPath, newPath, dryRun }) => {
    try {
        const projRoot = findProjectRoot(oldPath);
        await ensureProcess(projRoot);
        const result = await sendCommand('move', {
            oldPath: path.resolve(oldPath),
            newPath: path.resolve(newPath),
            dryRun: dryRun ?? true,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
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
        const absRoot = path.resolve(manifest.projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('move_bulk', {
            moves: manifest.moves.map(m => ({
                old_path: path.resolve(m.oldPath),
                new_path: path.resolve(m.newPath),
                timestamp: m.timestamp,
            })),
            project_root: absRoot,
            dry_run: manifest.dryRun,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_analyze_impact ───
server.tool('refactor_analyze_impact', 'Analyze the cascading impact of changes to a file — traces all downstream effects', {
    file: z.string().describe('File to analyze'),
    sinceCommit: z.string().optional().describe('Compare against this git commit'),
}, async ({ file, sinceCommit }) => {
    try {
        const projRoot = findProjectRoot(file);
        await ensureProcess(projRoot);
        const result = await sendCommand('impact', {
            file: path.resolve(file),
            since: sinceCommit,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_auto_fix ───
server.tool('refactor_auto_fix', 'Apply mechanical auto-fixes for cascading effects. Returns remaining tasks that need manual/AI attention', {
    impactReport: z.any().describe('Impact report from refactor_analyze_impact'),
    dryRun: z.boolean().optional().describe('Preview fixes without applying'),
}, async ({ impactReport, dryRun }) => {
    try {
        const file = impactReport?.reports?.[0]?.change?.file
            || impactReport?.change?.file
            || impactReport?.file;
        if (!file)
            throw new Error('Cannot determine file from impact report');
        const projRoot = findProjectRoot(file);
        await ensureProcess(projRoot);
        const result = await sendCommand('auto_fix', {
            file: path.resolve(file),
            autoFix: true,
            generateTasks: dryRun ?? false,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_dependency_graph ───
server.tool('refactor_dependency_graph', 'Get the full dependency graph for a codebase or specific entry point', {
    projectRoot: z.string().describe('Project root directory'),
    entryPoint: z.string().optional().describe('Optional entry point file'),
    maxDepth: z.number().optional().describe('Maximum traversal depth'),
}, async ({ projectRoot, entryPoint, maxDepth }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('analyze', {
            circular: true,
            orphans: true,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
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
            return toolResult({ results: [], totalAffected: 0 });
        }
        const op = operations[0];
        const projRoot = findProjectRoot(op.oldPath);
        await ensureProcess(projRoot);
        const result = await sendCommand('move', {
            oldPath: path.resolve(op.oldPath),
            newPath: path.resolve(op.newPath),
            dryRun: true,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_rollback ───
// Rollback uses one-shot exec since it doesn't use the graph
server.tool('refactor_rollback', 'Undo a previous refactoring operation using the audit log', {
    auditLogId: z.string().describe('Audit log ID to rollback'),
}, async ({ auditLogId }) => {
    try {
        const result = await runRustOneShot(['rollback', auditLogId, '--output', 'json']);
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_scan_routes ───
server.tool('refactor_scan_routes', 'Scan a codebase for all Next.js route handlers and their API route URLs. Useful for understanding the route map before moves.', {
    projectRoot: z.string().describe('Path to the project root directory'),
}, async ({ projectRoot }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('scan_routes', {});
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_delete ───
server.tool('refactor_delete', 'Delete a file and auto-clean all imports referencing it', {
    file: z.string().describe('File to delete'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ file, dryRun }) => {
    try {
        const projRoot = findProjectRoot(file);
        await ensureProcess(projRoot);
        const result = await sendCommand('delete', {
            file: path.resolve(file),
            dryRun: dryRun ?? true,
        });
        // After a non-dry-run delete, rescan to update the graph
        if (!dryRun) {
            await sendCommand('rescan', {}).catch(() => { });
        }
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
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
        const projRoot = findProjectRoot(file);
        await ensureProcess(projRoot);
        const result = await sendCommand('rename', {
            file: path.resolve(file),
            oldName,
            newName,
            dryRun: dryRun ?? true,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_dead_code ───
server.tool('refactor_dead_code', 'Find unreachable dead code from entry points', {
    projectRoot: z.string().describe('Project root directory'),
    entryPoints: z.array(z.string()).optional().describe('Entry point files (relative to project root)'),
}, async ({ projectRoot, entryPoints }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const resolvedEntryPoints = entryPoints?.map(ep => path.resolve(absRoot, ep));
        const result = await sendCommand('dead_code', {
            entryPoints: resolvedEntryPoints,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_ui_audit ───
server.tool('refactor_ui_audit', 'Detect UI issues: missing handlers, unused state, missing keys in React/JSX', {
    projectRoot: z.string().describe('Project root directory'),
}, async ({ projectRoot }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('ui_audit', {});
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_deps_audit ───
server.tool('refactor_deps_audit', 'Find unused npm dependencies and undeclared imports', {
    projectRoot: z.string().describe('Project root directory'),
}, async ({ projectRoot }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('deps_audit', {});
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── refactor_env_audit ───
server.tool('refactor_env_audit', 'Detect env variable drift between code and .env files', {
    projectRoot: z.string().describe('Project root directory'),
    envFiles: z.array(z.string()).optional().describe('Env files to check (relative to project root)'),
}, async ({ projectRoot, envFiles }) => {
    try {
        const absRoot = path.resolve(projectRoot);
        await ensureProcess(absRoot);
        const result = await sendCommand('env_audit', {
            envFiles,
        });
        return toolResult(result);
    }
    catch (err) {
        return toolError(err);
    }
});
// ─── Clean shutdown ───
process.on('SIGTERM', async () => {
    await killProcess();
    process.exit(0);
});
process.on('SIGINT', async () => {
    await killProcess();
    process.exit(0);
});
process.on('exit', () => {
    if (rustProcess && !rustProcess.killed) {
        rustProcess.stdin?.end();
        rustProcess.kill();
    }
});
// ─── Main ───
async function main() {
    console.error(`Refactor Runtime MCP server (persistent Rust backend) starting...`);
    console.error(`Binary: ${RUST_BINARY}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Refactor Runtime MCP server (persistent Rust backend) running on stdio');
}
main().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
});
//# sourceMappingURL=server-rust.js.map
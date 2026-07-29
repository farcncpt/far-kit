import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { refactorScan, refactorMove, refactorMoveBulk, refactorAnalyzeImpact, refactorAutoFix, refactorDependencyGraph, refactorDryRun, refactorRollback, refactorScanRoutes, refactorDelete, refactorRename, refactorDeadCode, refactorUIAudit, refactorDepsAudit, refactorEnvAudit, } from './tools.js';
const server = new McpServer({
    name: 'refactor-runtime',
    version: '0.1.0',
});
// refactor_scan
server.tool('refactor_scan', 'Scan a codebase and return structural analysis — file count, imports, exports, dependency stats', { projectRoot: z.string().describe('Path to the project root directory') }, async ({ projectRoot }) => {
    try {
        const result = await refactorScan({ projectRoot });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_move
server.tool('refactor_move', 'Move a file or folder and automatically rewrite all imports/exports. Supports single files, directories (folder move), and detects API route changes in Next.js projects.', {
    oldPath: z.string().describe('Current file or directory path'),
    newPath: z.string().describe('Target file or directory path'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ oldPath, newPath, dryRun }) => {
    try {
        const result = await refactorMove({ oldPath, newPath, dryRun });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_move_bulk
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
        const result = await refactorMoveBulk({ manifest });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_analyze_impact
server.tool('refactor_analyze_impact', 'Analyze the cascading impact of changes to a file — traces all downstream effects', {
    file: z.string().describe('File to analyze'),
    sinceCommit: z.string().optional().describe('Compare against this git commit'),
}, async ({ file, sinceCommit }) => {
    try {
        const result = await refactorAnalyzeImpact({ file, sinceCommit });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_auto_fix
server.tool('refactor_auto_fix', 'Apply mechanical auto-fixes for cascading effects. Returns remaining tasks that need manual/AI attention', {
    impactReport: z.any().describe('Impact report from refactor_analyze_impact'),
    dryRun: z.boolean().optional().describe('Preview fixes without applying'),
}, async ({ impactReport, dryRun }) => {
    try {
        const result = await refactorAutoFix({ impactReport, dryRun });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_dependency_graph
server.tool('refactor_dependency_graph', 'Get the full dependency graph for a codebase or specific entry point', {
    projectRoot: z.string().describe('Project root directory'),
    entryPoint: z.string().optional().describe('Optional entry point file'),
    maxDepth: z.number().optional().describe('Maximum traversal depth'),
}, async ({ projectRoot, entryPoint, maxDepth }) => {
    try {
        const result = await refactorDependencyGraph({ projectRoot, entryPoint, maxDepth });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_dry_run
server.tool('refactor_dry_run', 'Preview all changes from a move or impact operation without executing', {
    operations: z.array(z.object({
        oldPath: z.string(),
        newPath: z.string(),
        timestamp: z.string(),
    })).describe('List of move operations to preview'),
}, async ({ operations }) => {
    try {
        const result = await refactorDryRun({ operations });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_rollback
server.tool('refactor_rollback', 'Undo a previous refactoring operation using the audit log', {
    auditLogId: z.string().describe('Audit log ID to rollback'),
}, async ({ auditLogId }) => {
    try {
        const result = await refactorRollback({ auditLogId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_scan_routes
server.tool('refactor_scan_routes', 'Scan a codebase for all Next.js route handlers and their API route URLs. Useful for understanding the route map before moves.', {
    projectRoot: z.string().describe('Path to the project root directory'),
}, async ({ projectRoot }) => {
    try {
        const result = await refactorScanRoutes({ projectRoot });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_delete
server.tool('refactor_delete', 'Delete a file and auto-clean all imports referencing it', {
    file: z.string().describe('File to delete'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ file, dryRun }) => {
    try {
        const result = await refactorDelete({ file, dryRun });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_rename
server.tool('refactor_rename', 'Rename an exported symbol across the entire codebase', {
    file: z.string().describe('File containing the export'),
    oldName: z.string().describe('Current export name'),
    newName: z.string().describe('New export name'),
    dryRun: z.boolean().optional().describe('Preview changes without applying'),
}, async ({ file, oldName, newName, dryRun }) => {
    try {
        const result = await refactorRename({ file, oldName, newName, dryRun });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_dead_code
server.tool('refactor_dead_code', 'Find unreachable dead code from entry points', {
    projectRoot: z.string().describe('Project root directory'),
    entryPoints: z.array(z.string()).optional().describe('Entry point files (relative to project root)'),
}, async ({ projectRoot, entryPoints }) => {
    try {
        const result = await refactorDeadCode({ projectRoot, entryPoints });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_ui_audit
server.tool('refactor_ui_audit', 'Detect UI issues: missing handlers, unused state, missing keys in React/JSX', {
    projectRoot: z.string().describe('Project root directory'),
}, async ({ projectRoot }) => {
    try {
        const result = await refactorUIAudit({ projectRoot });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_deps_audit
server.tool('refactor_deps_audit', 'Find unused npm dependencies and undeclared imports', {
    projectRoot: z.string().describe('Project root directory'),
}, async ({ projectRoot }) => {
    try {
        const result = await refactorDepsAudit({ projectRoot });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
// refactor_env_audit
server.tool('refactor_env_audit', 'Detect env variable drift between code and .env files', {
    projectRoot: z.string().describe('Project root directory'),
    envFiles: z.array(z.string()).optional().describe('Env files to check (relative to project root)'),
}, async ({ projectRoot, envFiles }) => {
    try {
        const result = await refactorEnvAudit({ projectRoot, envFiles });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Refactor Runtime MCP server running on stdio');
}
main().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map
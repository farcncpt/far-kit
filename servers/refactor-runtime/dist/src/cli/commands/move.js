import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { computeMove, computeBulkMoves, computeFolderMove } from '../../move/mover.js';
import { applyRewrites, moveFile } from '../../move/rewriter.js';
import { applyRouteRewrites } from '../../move/route-scanner.js';
import { AuditLogger } from '../../audit/logger.js';
import { formatMoveResult, formatFolderMoveResult } from '../output.js';
export const moveCommand = new Command('move')
    .description('Move a file or folder and rewrite all imports')
    .argument('[oldPath]', 'Source file or directory path')
    .argument('[newPath]', 'Destination file or directory path')
    .option('--dry-run', 'Preview changes without applying', false)
    .option('--manifest <file>', 'Bulk moves from JSON manifest')
    .option('--audit-log <dir>', 'Write audit log to directory')
    .option('-o, --output <format>', 'Output format: table, json, csv', 'table')
    .action(async (oldPath, newPath, opts) => {
    let projectRoot;
    if (opts.manifest) {
        // Bulk moves from manifest
        const manifestPath = path.resolve(opts.manifest);
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw);
        const operations = manifest.moves;
        projectRoot = path.resolve(manifest.projectRoot);
        const config = loadProjectConfig(projectRoot);
        const scanResult = await scanProject(config);
        const graph = buildGraph(scanResult.files, projectRoot);
        const auditLogger = opts.auditLog
            ? new AuditLogger(path.resolve(opts.auditLog), projectRoot)
            : undefined;
        if (opts.dryRun) {
            console.log('[DRY RUN] No files will be modified.\n');
        }
        const results = computeBulkMoves(operations, graph, config);
        for (const result of results) {
            applyRewrites(result, { dryRun: opts.dryRun, auditLogger });
            applyRouteRewrites(result.routeChanges, { dryRun: opts.dryRun });
            if (!opts.dryRun) {
                moveFile(result.operation.oldPath, result.operation.newPath, {
                    dryRun: opts.dryRun,
                    auditLogger,
                });
            }
            console.log(formatMoveResult(result, opts.output));
            console.log('');
        }
        if (auditLogger) {
            const logPath = auditLogger.save();
            auditLogger.saveCSV();
            console.log(`\nAudit log saved: ${logPath}`);
        }
    }
    else if (oldPath && newPath) {
        const absOld = path.resolve(oldPath);
        const absNew = path.resolve(newPath);
        projectRoot = findProjectRoot(absOld);
        const config = loadProjectConfig(projectRoot);
        const scanResult = await scanProject(config);
        const graph = buildGraph(scanResult.files, projectRoot);
        const auditLogger = opts.auditLog
            ? new AuditLogger(path.resolve(opts.auditLog), projectRoot)
            : undefined;
        if (opts.dryRun) {
            console.log('[DRY RUN] No files will be modified.\n');
        }
        // Check if oldPath is a directory → folder move
        if (fs.existsSync(absOld) && fs.statSync(absOld).isDirectory()) {
            const folderResult = computeFolderMove(absOld, absNew, graph, config);
            if (folderResult.operations.length === 0) {
                console.log(`No source files found under ${absOld}`);
                return;
            }
            // Apply rewrites for each file move
            for (const result of folderResult.results) {
                applyRewrites(result, { dryRun: opts.dryRun, auditLogger });
            }
            // Apply route rewrites
            applyRouteRewrites(folderResult.routeChanges, { dryRun: opts.dryRun });
            // Physically move files (in reverse depth order to avoid parent-before-child issues)
            if (!opts.dryRun) {
                for (const op of folderResult.operations) {
                    moveFile(op.oldPath, op.newPath, { dryRun: opts.dryRun, auditLogger });
                }
                // Clean up empty directories left behind
                cleanEmptyDirs(absOld);
            }
            console.log(formatFolderMoveResult(folderResult, opts.output));
        }
        else {
            // Single file move
            const operation = {
                oldPath: absOld,
                newPath: absNew,
                timestamp: new Date().toISOString(),
            };
            const result = computeMove(operation, graph, config);
            applyRewrites(result, { dryRun: opts.dryRun, auditLogger });
            applyRouteRewrites(result.routeChanges, { dryRun: opts.dryRun });
            if (!opts.dryRun) {
                moveFile(absOld, absNew, { dryRun: opts.dryRun, auditLogger });
            }
            console.log(formatMoveResult(result, opts.output));
        }
        if (auditLogger) {
            const logPath = auditLogger.save();
            auditLogger.saveCSV();
            console.log(`\nAudit log saved: ${logPath}`);
        }
    }
    else {
        console.error('Error: Provide either <oldPath> <newPath> or --manifest <file>');
        process.exit(1);
    }
});
function findProjectRoot(filePath) {
    let dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json')) ||
            fs.existsSync(path.join(dir, 'tsconfig.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
}
/**
 * Remove empty directories left behind after a folder move.
 */
function cleanEmptyDirs(dirPath) {
    if (!fs.existsSync(dirPath))
        return;
    try {
        const entries = fs.readdirSync(dirPath);
        // Recursively clean subdirectories first
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry);
            if (fs.statSync(fullPath).isDirectory()) {
                cleanEmptyDirs(fullPath);
            }
        }
        // Remove this directory if now empty
        const remaining = fs.readdirSync(dirPath);
        if (remaining.length === 0) {
            fs.rmdirSync(dirPath);
        }
    }
    catch {
        // Ignore errors during cleanup
    }
}
//# sourceMappingURL=move.js.map
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { computeDelete } from '../../delete/deleter.js';
import { applyDeleteRewrites } from '../../delete/rewriter.js';
import { formatDeleteResult } from '../output.js';
export const deleteCommand = new Command('delete')
    .description('Delete a file and auto-clean all imports')
    .argument('<file>', 'File to delete')
    .option('--dry-run', 'Preview changes without applying', false)
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .action(async (file, opts) => {
    const absFile = path.resolve(file);
    if (!fs.existsSync(absFile)) {
        console.error(`Error: File not found: ${absFile}`);
        process.exit(1);
    }
    const projectRoot = findProjectRoot(absFile);
    const config = loadProjectConfig(projectRoot);
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, projectRoot);
    if (opts.dryRun) {
        console.log('[DRY RUN] No files will be modified.\n');
    }
    const result = computeDelete(absFile, graph);
    console.log(formatDeleteResult(result, opts.output));
    if (!opts.dryRun) {
        applyDeleteRewrites(result, { dryRun: false });
        if (fs.existsSync(absFile)) {
            fs.unlinkSync(absFile);
        }
        console.log(`\nFile deleted: ${absFile}`);
    }
});
function findProjectRoot(filePath) {
    let dir = path.dirname(filePath);
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'package.json')) ||
            fs.existsSync(path.join(dir, 'tsconfig.json'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return path.dirname(filePath);
}
//# sourceMappingURL=delete.js.map
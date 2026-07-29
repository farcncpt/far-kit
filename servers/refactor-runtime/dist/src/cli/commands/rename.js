import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { computeRename } from '../../rename/renamer.js';
import { formatRenameResult } from '../output.js';
export const renameCommand = new Command('rename')
    .description('Rename an exported symbol across the codebase')
    .argument('<file>', 'File containing the export')
    .argument('<oldName>', 'Current export name')
    .argument('<newName>', 'New export name')
    .option('--dry-run', 'Preview changes without applying', false)
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .action(async (file, oldName, newName, opts) => {
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
    const result = computeRename(absFile, oldName, newName, graph, config);
    console.log(formatRenameResult(result, opts.output));
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
//# sourceMappingURL=rename.js.map
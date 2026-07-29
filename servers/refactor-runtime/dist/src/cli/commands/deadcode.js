import { Command } from 'commander';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { findDeadCode } from '../../deadcode/analyzer.js';
import { formatDeadCodeResult } from '../output.js';
export const deadcodeCommand = new Command('dead-code')
    .description('Find unreachable dead code')
    .argument('<path>', 'Project root')
    .option('--entry-points <files...>', 'Entry point files')
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .action(async (projectPath, opts) => {
    const absRoot = path.resolve(projectPath);
    const config = loadProjectConfig(absRoot);
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, absRoot);
    const entryPoints = opts.entryPoints?.map((ep) => path.resolve(absRoot, ep)) ?? [];
    const result = findDeadCode(graph, entryPoints);
    console.log(formatDeadCodeResult(result, opts.output));
});
//# sourceMappingURL=deadcode.js.map
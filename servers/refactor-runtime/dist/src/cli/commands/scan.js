import { Command } from 'commander';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { formatScanResult } from '../output.js';
export const scanCommand = new Command('scan')
    .description('Scan codebase and report structure')
    .argument('<path>', 'Path to project root')
    .option('-o, --output <format>', 'Output format: table, json, csv', 'table')
    .action(async (projectPath, opts) => {
    const absPath = path.resolve(projectPath);
    const config = loadProjectConfig(absPath);
    const result = await scanProject(config);
    console.log(formatScanResult(result.stats, opts.output));
});
//# sourceMappingURL=scan.js.map
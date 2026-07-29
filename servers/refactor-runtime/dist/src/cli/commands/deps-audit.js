import { Command } from 'commander';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { auditDeps } from '../../deps-audit/auditor.js';
import { formatDepsAuditResult } from '../output.js';
export const depsAuditCommand = new Command('deps-audit')
    .description('Find unused npm dependencies and undeclared imports')
    .argument('<path>', 'Project root')
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .action(async (projectPath, opts) => {
    const absRoot = path.resolve(projectPath);
    const config = loadProjectConfig(absRoot);
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, absRoot);
    const packageJsonPath = path.join(absRoot, 'package.json');
    const result = await auditDeps(graph, config, packageJsonPath);
    console.log(formatDepsAuditResult(result, opts.output));
});
//# sourceMappingURL=deps-audit.js.map
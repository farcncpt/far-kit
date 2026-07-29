import { Command } from 'commander';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { parseFile } from '../../core/parser.js';
import { auditUI } from '../../ui-audit/auditor.js';
import { formatUIAuditResult } from '../output.js';
export const uiAuditCommand = new Command('ui-audit')
    .description('Detect UI issues in React/JSX components')
    .argument('<path>', 'Project root')
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .action(async (projectPath, opts) => {
    const absRoot = path.resolve(projectPath);
    const config = loadProjectConfig(absRoot);
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, absRoot);
    // Build enriched files map
    const enrichedFiles = new Map();
    for (const [filePath, fileInfo] of graph.nodes) {
        if (fileInfo.language !== 'css') {
            const enriched = parseFile(filePath, config, ['jsxElements', 'symbolUsages', 'callSites']);
            enrichedFiles.set(filePath, enriched);
        }
    }
    const result = auditUI(graph, config, enrichedFiles);
    console.log(formatUIAuditResult(result, opts.output));
});
//# sourceMappingURL=ui-audit.js.map
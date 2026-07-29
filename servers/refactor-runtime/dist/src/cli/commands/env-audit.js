import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { parseFile } from '../../core/parser.js';
import { auditEnv } from '../../env-audit/auditor.js';
import { formatEnvAuditResult } from '../output.js';
export const envAuditCommand = new Command('env-audit')
    .description('Detect env variable drift between code and .env files')
    .argument('<path>', 'Project root')
    .option('--env-files <files...>', 'Env files to check')
    .option('-o, --output <format>', 'Output format: table, json', 'table')
    .action(async (projectPath, opts) => {
    const absRoot = path.resolve(projectPath);
    const config = loadProjectConfig(absRoot);
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, absRoot);
    const envFiles = opts.envFiles?.map((f) => path.resolve(absRoot, f))
        ?? ['.env', '.env.local', '.env.production', '.env.example']
            .map((f) => path.join(absRoot, f))
            .filter((f) => fs.existsSync(f));
    // Build enriched files map with envReferences
    const enrichedFiles = new Map();
    for (const [filePath, fileInfo] of graph.nodes) {
        if (fileInfo.language !== 'css') {
            const enriched = parseFile(filePath, config, ['envReferences']);
            enrichedFiles.set(filePath, enriched);
        }
    }
    const result = auditEnv(graph, config, envFiles, enrichedFiles);
    console.log(formatEnvAuditResult(result, opts.output));
});
//# sourceMappingURL=env-audit.js.map
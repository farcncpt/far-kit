import { Command } from 'commander';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph, analyzeGraph } from '../../core/graph.js';
import { formatAnalysisResult } from '../output.js';
export const analyzeCommand = new Command('analyze')
    .description('Full dependency graph analysis')
    .argument('<path>', 'Path to project root')
    .option('--circular', 'Check for circular dependencies')
    .option('--orphans', 'Find orphaned modules')
    .option('--depth <n>', 'Max traversal depth', '10')
    .option('-o, --output <format>', 'Output format: table, json, csv, dot', 'table')
    .action(async (projectPath, opts) => {
    const absPath = path.resolve(projectPath);
    const config = loadProjectConfig(absPath);
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, absPath);
    const analysis = analyzeGraph(graph);
    if (opts.output === 'dot') {
        console.log(formatAsDot(analysis));
        return;
    }
    // Filter output based on flags
    if (opts.circular && !opts.orphans) {
        if (analysis.circularDeps.length === 0) {
            console.log('No circular dependencies found.');
        }
        else {
            console.log(`Found ${analysis.circularDeps.length} circular dependency chain(s):\n`);
            for (const cycle of analysis.circularDeps) {
                console.log(`  ${cycle.join(' -> ')}`);
            }
        }
        return;
    }
    if (opts.orphans && !opts.circular) {
        if (analysis.orphans.length === 0) {
            console.log('No orphaned files found.');
        }
        else {
            console.log(`Found ${analysis.orphans.length} orphaned file(s):\n`);
            for (const orphan of analysis.orphans) {
                console.log(`  ${orphan}`);
            }
        }
        return;
    }
    console.log(formatAnalysisResult(analysis, opts.output));
});
function formatAsDot(analysis) {
    const lines = ['digraph dependencies {'];
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box, style=filled, fillcolor="#e8e8e8"];');
    lines.push('');
    const { graph } = analysis;
    for (const [file, deps] of graph.edges) {
        const fromLabel = path.basename(file);
        for (const dep of deps) {
            const toLabel = path.basename(dep);
            lines.push(`  "${fromLabel}" -> "${toLabel}";`);
        }
    }
    lines.push('}');
    return lines.join('\n');
}
//# sourceMappingURL=analyze.js.map
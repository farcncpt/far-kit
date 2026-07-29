import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProjectConfig } from '../../config/loader.js';
import { scanProject } from '../../core/scanner.js';
import { buildGraph } from '../../core/graph.js';
import { detectChanges } from '../../impact/detector.js';
import { traceCascade } from '../../impact/tracer.js';
import { applyAutoFixes } from '../../impact/auto-fixer.js';
import { generateTasks, formatTasksAsMarkdown, formatTasksAsJSON } from '../../impact/task-generator.js';
import { AuditLogger } from '../../audit/logger.js';
import { formatImpactReport } from '../output.js';
import { execSync } from 'node:child_process';
export const impactCommand = new Command('impact')
    .description('Analyze impact of changes in a file')
    .argument('<file>', 'File to analyze')
    .option('--since <commit>', 'Compare against git commit')
    .option('--auto-fix', 'Apply mechanical fixes', false)
    .option('--generate-tasks', 'Output task list', false)
    .option('--audit-log <dir>', 'Write audit log to directory')
    .option('-o, --output <format>', 'Output format: table, json, csv', 'table')
    .action(async (file, opts) => {
    const absFile = path.resolve(file);
    if (!fs.existsSync(absFile)) {
        console.error(`File not found: ${absFile}`);
        process.exit(1);
    }
    // Find project root
    const projectRoot = findProjectRoot(absFile);
    const config = loadProjectConfig(projectRoot);
    // Get old content
    let oldContent;
    if (opts.since) {
        try {
            const relativePath = path.relative(projectRoot, absFile);
            oldContent = execSync(`git show ${opts.since}:${relativePath}`, { cwd: projectRoot, encoding: 'utf-8' });
        }
        catch {
            console.error(`Failed to get file from commit ${opts.since}`);
            process.exit(1);
        }
    }
    else {
        // Compare against git HEAD
        try {
            const relativePath = path.relative(projectRoot, absFile);
            oldContent = execSync(`git show HEAD:${relativePath}`, { cwd: projectRoot, encoding: 'utf-8' });
        }
        catch {
            console.error('No git history available. Use --since to specify a commit or ensure file is tracked.');
            process.exit(1);
        }
    }
    const newContent = fs.readFileSync(absFile, 'utf-8');
    // Detect changes
    const changes = detectChanges(oldContent, newContent, absFile);
    if (changes.length === 0) {
        console.log('No structural changes detected.');
        return;
    }
    // Scan project and build graph
    const scanResult = await scanProject(config);
    const graph = buildGraph(scanResult.files, projectRoot);
    const auditLogger = opts.auditLog
        ? new AuditLogger(path.resolve(opts.auditLog), projectRoot)
        : undefined;
    // Trace cascade for each change
    for (const change of changes) {
        const effects = traceCascade(change, graph);
        const tasks = generateTasks({
            change,
            effects,
            autoFixed: 0,
            needsReview: effects.filter((e) => !e.autoFixable).length,
            tasks: [],
        });
        const report = {
            change,
            effects,
            autoFixed: 0,
            needsReview: effects.filter((e) => !e.autoFixable).length,
            tasks,
        };
        if (opts.autoFix) {
            const fixResult = applyAutoFixes(report, { auditLogger });
            report.autoFixed = fixResult.totalFixed;
            report.needsReview = fixResult.totalSkipped;
            console.log(`Auto-fixed ${fixResult.totalFixed} effects, ${fixResult.totalSkipped} need review`);
        }
        if (opts.generateTasks) {
            const taskList = generateTasks(report);
            report.tasks = taskList;
            if (opts.output === 'json') {
                console.log(formatTasksAsJSON(taskList));
            }
            else {
                console.log(formatTasksAsMarkdown(taskList));
            }
        }
        else {
            console.log(formatImpactReport(report, opts.output));
        }
        console.log('');
    }
    if (auditLogger) {
        const logPath = auditLogger.save();
        console.log(`Audit log saved: ${logPath}`);
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
//# sourceMappingURL=impact.js.map
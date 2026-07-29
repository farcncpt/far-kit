import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadProjectConfig } from '../config/loader.js';
import { scanProject } from '../core/scanner.js';
import { buildGraph, analyzeGraph, getTransitiveDependents } from '../core/graph.js';
import { computeMove, computeBulkMoves, computeFolderMove } from '../move/mover.js';
import { applyRewrites, moveFile } from '../move/rewriter.js';
import { applyRouteRewrites } from '../move/route-scanner.js';
import { detectChanges } from '../impact/detector.js';
import { traceCascade } from '../impact/tracer.js';
import { applyAutoFixes } from '../impact/auto-fixer.js';
import { generateTasks } from '../impact/task-generator.js';
import { AuditLogger, findAuditLog } from '../audit/logger.js';
import { rollback } from '../audit/rollback.js';
import { computeDelete } from '../delete/deleter.js';
import { applyDeleteRewrites } from '../delete/rewriter.js';
import { computeRename } from '../rename/renamer.js';
import { findDeadCode } from '../deadcode/analyzer.js';
import { auditUI } from '../ui-audit/auditor.js';
import { auditDeps } from '../deps-audit/auditor.js';
import { auditEnv } from '../env-audit/auditor.js';
import { parseFile } from '../core/parser.js';
// Cache for scanned projects
const projectCache = new Map();
async function getProjectData(projectRoot) {
    const absRoot = path.resolve(projectRoot);
    if (!projectCache.has(absRoot)) {
        const config = loadProjectConfig(absRoot);
        const scanResult = await scanProject(config);
        const graph = buildGraph(scanResult.files, absRoot);
        projectCache.set(absRoot, { config, scanResult, graph });
    }
    return projectCache.get(absRoot);
}
function invalidateCache(projectRoot) {
    projectCache.delete(path.resolve(projectRoot));
}
export async function refactorScan(params) {
    const absRoot = path.resolve(params.projectRoot);
    const config = loadProjectConfig(absRoot);
    const scanResult = await scanProject(config);
    return {
        stats: scanResult.stats,
        files: scanResult.files.map((f) => ({
            path: f.relativePath,
            language: f.language,
            imports: f.imports.length,
            exports: f.exports.length,
        })),
    };
}
export async function refactorMove(params) {
    const absOld = path.resolve(params.oldPath);
    const absNew = path.resolve(params.newPath);
    const projectRoot = findProjectRoot(absOld);
    const { config, graph } = await getProjectData(projectRoot);
    const dryRun = params.dryRun ?? false;
    const auditLogger = new AuditLogger(path.join(projectRoot, '.refactor-audit'), projectRoot);
    // Check if it's a folder move
    if (fs.existsSync(absOld) && fs.statSync(absOld).isDirectory()) {
        const folderResult = computeFolderMove(absOld, absNew, graph, config);
        for (const result of folderResult.results) {
            applyRewrites(result, { dryRun, auditLogger });
        }
        applyRouteRewrites(folderResult.routeChanges, { dryRun });
        if (!dryRun) {
            for (const op of folderResult.operations) {
                moveFile(op.oldPath, op.newPath, { dryRun, auditLogger });
            }
            auditLogger.save();
            invalidateCache(projectRoot);
        }
        return {
            type: 'folder',
            oldDir: folderResult.oldDir,
            newDir: folderResult.newDir,
            filesMoved: folderResult.filesMoved,
            totalFilesUpdated: folderResult.totalFilesUpdated,
            routeChanges: folderResult.routeChanges,
            results: folderResult.results.map((r) => ({
                operation: r.operation,
                affectedFiles: r.affectedFiles,
                routeChanges: r.routeChanges,
                totalFilesUpdated: r.totalFilesUpdated,
            })),
            dryRun,
            auditId: dryRun ? undefined : auditLogger.auditId,
        };
    }
    // Single file move
    const operation = {
        oldPath: absOld,
        newPath: absNew,
        timestamp: new Date().toISOString(),
    };
    const result = computeMove(operation, graph, config);
    applyRewrites(result, { dryRun, auditLogger });
    applyRouteRewrites(result.routeChanges, { dryRun });
    if (!dryRun) {
        moveFile(absOld, absNew, { dryRun, auditLogger });
        auditLogger.save();
        invalidateCache(projectRoot);
    }
    return {
        type: 'file',
        operation: result.operation,
        affectedFiles: result.affectedFiles,
        routeChanges: result.routeChanges,
        totalFilesUpdated: result.totalFilesUpdated,
        dryRun,
        auditId: dryRun ? undefined : auditLogger.auditId,
    };
}
export async function refactorMoveBulk(params) {
    const projectRoot = path.resolve(params.manifest.projectRoot);
    const { config, graph } = await getProjectData(projectRoot);
    const dryRun = params.manifest.dryRun;
    const auditLogger = new AuditLogger(path.join(projectRoot, '.refactor-audit'), projectRoot);
    const results = computeBulkMoves(params.manifest.moves, graph, config);
    for (const result of results) {
        applyRewrites(result, { dryRun, auditLogger });
        applyRouteRewrites(result.routeChanges, { dryRun });
        if (!dryRun) {
            moveFile(result.operation.oldPath, result.operation.newPath, {
                dryRun,
                auditLogger,
            });
        }
    }
    if (!dryRun) {
        auditLogger.save();
        invalidateCache(projectRoot);
    }
    return {
        results: results.map((r) => ({
            operation: r.operation,
            affectedFiles: r.affectedFiles.length,
            routeChanges: r.routeChanges,
            totalFilesUpdated: r.totalFilesUpdated,
        })),
        dryRun,
        auditId: dryRun ? undefined : auditLogger.auditId,
    };
}
export async function refactorAnalyzeImpact(params) {
    const absFile = path.resolve(params.file);
    const projectRoot = findProjectRoot(absFile);
    const { config, graph } = await getProjectData(projectRoot);
    let oldContent;
    if (params.sinceCommit) {
        const { execSync } = await import('node:child_process');
        const relativePath = path.relative(projectRoot, absFile);
        oldContent = execSync(`git show ${params.sinceCommit}:${relativePath}`, {
            cwd: projectRoot,
            encoding: 'utf-8',
        });
    }
    else {
        const { execSync } = await import('node:child_process');
        const relativePath = path.relative(projectRoot, absFile);
        oldContent = execSync(`git show HEAD:${relativePath}`, {
            cwd: projectRoot,
            encoding: 'utf-8',
        });
    }
    const newContent = fs.readFileSync(absFile, 'utf-8');
    const changes = detectChanges(oldContent, newContent, absFile);
    const reports = [];
    for (const change of changes) {
        const effects = traceCascade(change, graph);
        const tasks = generateTasks({
            change,
            effects,
            autoFixed: 0,
            needsReview: effects.filter((e) => !e.autoFixable).length,
            tasks: [],
        });
        reports.push({
            change,
            effects,
            autoFixed: 0,
            needsReview: effects.filter((e) => !e.autoFixable).length,
            tasks,
        });
    }
    return { reports };
}
export async function refactorAutoFix(params) {
    const dryRun = params.dryRun ?? false;
    const firstFile = params.impactReport.effects[0]?.file;
    const projectRoot = firstFile ? findProjectRoot(path.resolve(firstFile)) : '.';
    const auditLogger = new AuditLogger(path.join(projectRoot, '.refactor-audit'), projectRoot);
    const result = applyAutoFixes(params.impactReport, { dryRun, auditLogger });
    if (!dryRun) {
        auditLogger.save();
    }
    return {
        totalFixed: result.totalFixed,
        totalSkipped: result.totalSkipped,
        fixed: result.fixed.map((f) => ({
            file: f.effect.file,
            line: f.effect.line,
            appliedFix: f.appliedFix,
        })),
        remainingTasks: generateTasks(params.impactReport),
        dryRun,
    };
}
export async function refactorDependencyGraph(params) {
    const absRoot = path.resolve(params.projectRoot);
    const { graph } = await getProjectData(absRoot);
    const analysis = analyzeGraph(graph);
    if (params.entryPoint) {
        const absEntry = path.resolve(params.entryPoint);
        const dependents = getTransitiveDependents(graph, absEntry, params.maxDepth);
        return {
            entryPoint: absEntry,
            dependents: [...dependents.entries()].map(([p, d]) => ({
                file: path.relative(absRoot, p),
                depth: d,
            })),
            stats: analysis.stats,
        };
    }
    return {
        stats: analysis.stats,
        circularDeps: analysis.circularDeps.map((c) => c.map((p) => path.relative(absRoot, p))),
        orphans: analysis.orphans.map((p) => path.relative(absRoot, p)),
    };
}
export async function refactorDryRun(params) {
    if (params.operations.length === 0) {
        return { results: [], totalAffected: 0 };
    }
    const firstOp = params.operations[0];
    const projectRoot = findProjectRoot(path.resolve(firstOp.oldPath));
    const { config, graph } = await getProjectData(projectRoot);
    const results = computeBulkMoves(params.operations, graph, config);
    return {
        results: results.map((r) => ({
            operation: r.operation,
            affectedFiles: r.affectedFiles,
            routeChanges: r.routeChanges,
            totalFilesUpdated: r.totalFilesUpdated,
        })),
        totalAffected: results.reduce((sum, r) => sum + r.totalFilesUpdated, 0),
    };
}
export async function refactorRollback(params) {
    // Search common audit log directories
    const searchDirs = [
        path.resolve('.refactor-audit'),
        path.resolve(process.cwd(), '.refactor-audit'),
    ];
    let auditLog = null;
    for (const dir of searchDirs) {
        auditLog = findAuditLog(dir, params.auditLogId);
        if (auditLog)
            break;
    }
    if (!auditLog) {
        throw new Error(`Audit log not found: ${params.auditLogId}`);
    }
    const result = rollback(auditLog);
    return {
        auditId: result.auditId,
        totalActions: result.totalActions,
        successful: result.successful,
        failed: result.failed,
    };
}
export async function refactorScanRoutes(params) {
    const absRoot = path.resolve(params.projectRoot);
    const { config, graph } = await getProjectData(absRoot);
    const { deriveRoute } = await import('../move/route-scanner.js');
    const routes = [];
    for (const filePath of graph.nodes.keys()) {
        const route = deriveRoute(filePath, absRoot);
        if (route) {
            routes.push({
                file: path.relative(absRoot, filePath),
                route,
            });
        }
    }
    // Sort by route for readability
    routes.sort((a, b) => a.route.localeCompare(b.route));
    return {
        projectRoot: absRoot,
        totalRoutes: routes.length,
        routes,
    };
}
export async function refactorDelete(params) {
    const absFile = path.resolve(params.file);
    const projectRoot = findProjectRoot(absFile);
    const { config, graph } = await getProjectData(projectRoot);
    const result = computeDelete(absFile, graph);
    if (!params.dryRun) {
        applyDeleteRewrites(result, { dryRun: false });
        // Actually delete the file
        if (fs.existsSync(absFile)) {
            fs.unlinkSync(absFile);
        }
        invalidateCache(projectRoot);
    }
    return {
        targetFile: path.relative(projectRoot, result.targetFile),
        affectedFiles: result.affectedFiles.map(af => ({
            path: path.relative(projectRoot, af.path),
            importsToRemove: af.importsToRemove,
        })),
        reExportBreaks: result.reExportBreaks,
        totalImportsRemoved: result.totalImportsRemoved,
        dryRun: params.dryRun ?? true,
    };
}
export async function refactorRename(params) {
    const absFile = path.resolve(params.file);
    const projectRoot = findProjectRoot(absFile);
    const { config, graph } = await getProjectData(projectRoot);
    const result = computeRename(absFile, params.oldName, params.newName, graph, config);
    return {
        oldName: result.oldName,
        newName: result.newName,
        sourceFile: path.relative(projectRoot, result.sourceFile),
        affectedFiles: result.affectedFiles.map(af => ({
            path: path.relative(projectRoot, af.path),
            rewrites: af.rewrites,
        })),
        dynamicAccessWarnings: result.dynamicAccessWarnings,
        totalRewrites: result.totalRewrites,
        dryRun: params.dryRun ?? true,
    };
}
export async function refactorDeadCode(params) {
    const absRoot = path.resolve(params.projectRoot);
    const { config, graph } = await getProjectData(absRoot);
    const entryPoints = params.entryPoints?.map(ep => path.resolve(absRoot, ep)) ?? [];
    const result = findDeadCode(graph, entryPoints);
    return {
        entryPoints: result.entryPoints.map(ep => path.relative(absRoot, ep)),
        reachableFiles: result.reachableFiles,
        deadFiles: result.deadFiles.map(df => ({
            ...df,
            path: path.relative(absRoot, df.path),
        })),
        deadExports: result.deadExports.map(de => ({
            ...de,
            file: path.relative(absRoot, de.file),
        })),
        totalDeadLines: result.totalDeadLines,
    };
}
export async function refactorUIAudit(params) {
    const absRoot = path.resolve(params.projectRoot);
    const { config, graph } = await getProjectData(absRoot);
    // Build enriched files map
    const enrichedFiles = new Map();
    for (const [filePath, fileInfo] of graph.nodes) {
        if (fileInfo.language !== 'css') {
            const enriched = parseFile(filePath, config, ['jsxElements', 'symbolUsages', 'callSites']);
            enrichedFiles.set(filePath, enriched);
        }
    }
    const result = auditUI(graph, config, enrichedFiles);
    return result;
}
export async function refactorDepsAudit(params) {
    const absRoot = path.resolve(params.projectRoot);
    const { config, graph } = await getProjectData(absRoot);
    const packageJsonPath = path.join(absRoot, 'package.json');
    const result = await auditDeps(graph, config, packageJsonPath);
    return result;
}
export async function refactorEnvAudit(params) {
    const absRoot = path.resolve(params.projectRoot);
    const { config, graph } = await getProjectData(absRoot);
    const envFiles = params.envFiles?.map(f => path.resolve(absRoot, f))
        ?? ['.env', '.env.local', '.env.production', '.env.example'].map(f => path.join(absRoot, f)).filter(f => fs.existsSync(f));
    // Build enriched files map with envReferences
    const enrichedFiles = new Map();
    for (const [filePath, fileInfo] of graph.nodes) {
        if (fileInfo.language !== 'css') {
            const enriched = parseFile(filePath, config, ['envReferences']);
            enrichedFiles.set(filePath, enriched);
        }
    }
    const result = auditEnv(graph, config, envFiles, enrichedFiles);
    return result;
}
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
//# sourceMappingURL=tools.js.map
/**
 * Format scan results for display.
 */
export function formatScanResult(stats, format = 'table') {
    switch (format) {
        case 'json':
            return JSON.stringify(stats, null, 2);
        case 'csv':
            return formatScanCSV(stats);
        case 'table':
        default:
            return formatScanTable(stats);
    }
}
function formatScanTable(stats) {
    const lines = [];
    lines.push('Scan Results');
    lines.push('='.repeat(40));
    lines.push(`Total files: ${stats.totalFiles}`);
    lines.push(`Total imports: ${stats.totalImports}`);
    lines.push(`Total exports: ${stats.totalExports}`);
    lines.push('');
    lines.push('Files by language:');
    for (const [lang, count] of Object.entries(stats.byLanguage)) {
        lines.push(`  ${lang}: ${count}`);
    }
    return lines.join('\n');
}
function formatScanCSV(stats) {
    const lines = ['metric,value'];
    lines.push(`total_files,${stats.totalFiles}`);
    lines.push(`total_imports,${stats.totalImports}`);
    lines.push(`total_exports,${stats.totalExports}`);
    for (const [lang, count] of Object.entries(stats.byLanguage)) {
        lines.push(`files_${lang},${count}`);
    }
    return lines.join('\n');
}
/**
 * Format move result for display.
 */
export function formatMoveResult(result, format = 'table') {
    switch (format) {
        case 'json':
            return JSON.stringify(result, null, 2);
        case 'csv':
            return formatMoveCSV(result);
        case 'table':
        default:
            return formatMoveTable(result);
    }
}
function formatMoveTable(result) {
    const lines = [];
    lines.push(`Move: ${result.operation.oldPath} -> ${result.operation.newPath}`);
    lines.push(`Files affected: ${result.totalFilesUpdated}`);
    lines.push('');
    if (result.affectedFiles.length > 0) {
        lines.push('Affected imports:');
        lines.push(`${'File'.padEnd(50)} ${'Old Import'.padEnd(30)} ${'New Import'.padEnd(30)} Applied`);
        lines.push('-'.repeat(115));
        for (const af of result.affectedFiles) {
            const file = truncate(af.path, 48);
            lines.push(`${file.padEnd(50)} ${af.oldImport.padEnd(30)} ${af.newImport.padEnd(30)} ${af.applied ? 'Yes' : 'No'}`);
        }
    }
    else {
        lines.push('No imports affected.');
    }
    if (result.routeChanges.length > 0) {
        lines.push('');
        lines.push(`Route changes: ${result.routeChanges.length}`);
        lines.push(`${'File'.padEnd(50)} ${'Old Route'.padEnd(25)} ${'New Route'.padEnd(25)} Applied`);
        lines.push('-'.repeat(105));
        for (const rc of result.routeChanges) {
            lines.push(`${truncate(rc.file, 48).padEnd(50)} ${rc.oldRoute.padEnd(25)} ${rc.newRoute.padEnd(25)} ${rc.applied ? 'Yes' : 'No'}`);
        }
    }
    return lines.join('\n');
}
function formatMoveCSV(result) {
    const lines = ['file,old_import,new_import,line,applied'];
    for (const af of result.affectedFiles) {
        lines.push(`"${af.path}","${af.oldImport}","${af.newImport}",${af.line},${af.applied}`);
    }
    return lines.join('\n');
}
/**
 * Format folder move result for display.
 */
export function formatFolderMoveResult(result, format = 'table') {
    switch (format) {
        case 'json':
            return JSON.stringify({
                oldDir: result.oldDir,
                newDir: result.newDir,
                filesMoved: result.filesMoved,
                totalFilesUpdated: result.totalFilesUpdated,
                routeChanges: result.routeChanges,
                results: result.results.map((r) => ({
                    operation: r.operation,
                    affectedFiles: r.affectedFiles,
                    routeChanges: r.routeChanges,
                    totalFilesUpdated: r.totalFilesUpdated,
                })),
            }, null, 2);
        case 'csv':
            return formatFolderMoveCSV(result);
        case 'table':
        default:
            return formatFolderMoveTable(result);
    }
}
function formatFolderMoveTable(result) {
    const lines = [];
    lines.push(`Folder Move: ${result.oldDir} -> ${result.newDir}`);
    lines.push(`Files moved: ${result.filesMoved}`);
    lines.push(`External files updated: ${result.totalFilesUpdated}`);
    lines.push('');
    // List moved files
    lines.push('Moved files:');
    for (const op of result.operations) {
        lines.push(`  ${op.oldPath} -> ${op.newPath}`);
    }
    lines.push('');
    // Aggregate all affected imports (excluding internal ones that cancel out)
    const allAffected = [];
    for (const r of result.results) {
        allAffected.push(...r.affectedFiles);
    }
    if (allAffected.length > 0) {
        lines.push('Import rewrites:');
        lines.push(`${'File'.padEnd(50)} ${'Old Import'.padEnd(30)} ${'New Import'.padEnd(30)} Applied`);
        lines.push('-'.repeat(115));
        for (const af of allAffected) {
            lines.push(`${truncate(af.path, 48).padEnd(50)} ${af.oldImport.padEnd(30)} ${af.newImport.padEnd(30)} ${af.applied ? 'Yes' : 'No'}`);
        }
    }
    else {
        lines.push('No import rewrites needed.');
    }
    if (result.routeChanges.length > 0) {
        lines.push('');
        lines.push(`Route changes: ${result.routeChanges.length}`);
        lines.push(`${'File'.padEnd(50)} ${'Old Route'.padEnd(25)} ${'New Route'.padEnd(25)} Applied`);
        lines.push('-'.repeat(105));
        for (const rc of result.routeChanges) {
            lines.push(`${truncate(rc.file, 48).padEnd(50)} ${rc.oldRoute.padEnd(25)} ${rc.newRoute.padEnd(25)} ${rc.applied ? 'Yes' : 'No'}`);
        }
    }
    return lines.join('\n');
}
function formatFolderMoveCSV(result) {
    const lines = ['type,file,old_value,new_value,line,applied'];
    for (const r of result.results) {
        for (const af of r.affectedFiles) {
            lines.push(`"import","${af.path}","${af.oldImport}","${af.newImport}",${af.line},${af.applied}`);
        }
    }
    for (const rc of result.routeChanges) {
        lines.push(`"route","${rc.file}","${rc.oldRoute}","${rc.newRoute}",${rc.line},${rc.applied}`);
    }
    return lines.join('\n');
}
/**
 * Format analysis result for display.
 */
export function formatAnalysisResult(analysis, format = 'table') {
    switch (format) {
        case 'json':
            return JSON.stringify({
                stats: analysis.stats,
                circularDeps: analysis.circularDeps,
                orphans: analysis.orphans,
            }, null, 2);
        case 'csv':
            return formatAnalysisCSV(analysis);
        case 'table':
        default:
            return formatAnalysisTable(analysis);
    }
}
function formatAnalysisTable(analysis) {
    const lines = [];
    lines.push('Dependency Graph Analysis');
    lines.push('='.repeat(40));
    lines.push(`Total files: ${analysis.stats.totalNodes}`);
    lines.push(`Total edges: ${analysis.stats.totalEdges}`);
    lines.push(`Average dependencies: ${analysis.stats.avgDependencies}`);
    lines.push(`Most dependencies: ${analysis.stats.maxDependencies.file} (${analysis.stats.maxDependencies.count})`);
    lines.push(`Most dependents: ${analysis.stats.maxDependents.file} (${analysis.stats.maxDependents.count})`);
    if (analysis.circularDeps.length > 0) {
        lines.push('');
        lines.push(`Circular dependencies: ${analysis.circularDeps.length}`);
        for (const cycle of analysis.circularDeps.slice(0, 10)) {
            lines.push(`  ${cycle.map((p) => truncate(p, 40)).join(' -> ')}`);
        }
        if (analysis.circularDeps.length > 10) {
            lines.push(`  ... and ${analysis.circularDeps.length - 10} more`);
        }
    }
    if (analysis.orphans.length > 0) {
        lines.push('');
        lines.push(`Orphaned files: ${analysis.orphans.length}`);
        for (const orphan of analysis.orphans.slice(0, 20)) {
            lines.push(`  ${orphan}`);
        }
        if (analysis.orphans.length > 20) {
            lines.push(`  ... and ${analysis.orphans.length - 20} more`);
        }
    }
    return lines.join('\n');
}
function formatAnalysisCSV(analysis) {
    const lines = ['metric,value'];
    lines.push(`total_files,${analysis.stats.totalNodes}`);
    lines.push(`total_edges,${analysis.stats.totalEdges}`);
    lines.push(`avg_dependencies,${analysis.stats.avgDependencies}`);
    lines.push(`circular_deps,${analysis.circularDeps.length}`);
    lines.push(`orphans,${analysis.orphans.length}`);
    return lines.join('\n');
}
/**
 * Format impact report for display.
 */
export function formatImpactReport(report, format = 'table') {
    switch (format) {
        case 'json':
            return JSON.stringify(report, null, 2);
        case 'csv':
            return formatImpactCSV(report);
        case 'table':
        default:
            return formatImpactTable(report);
    }
}
function formatImpactTable(report) {
    const lines = [];
    lines.push('Impact Analysis');
    lines.push('='.repeat(40));
    lines.push(`Change: ${report.change.entity} (${report.change.changeType})`);
    lines.push(`File: ${report.change.file}`);
    lines.push(`Total effects: ${report.effects.length}`);
    lines.push(`Auto-fixed: ${report.autoFixed}`);
    lines.push(`Needs review: ${report.needsReview}`);
    lines.push(`Tasks: ${report.tasks.length}`);
    if (report.effects.length > 0) {
        lines.push('');
        lines.push('Effects:');
        lines.push(`${'File'.padEnd(45)} ${'Depth'.padEnd(6)} ${'Class'.padEnd(22)} ${'Auto-Fix'.padEnd(9)} Description`);
        lines.push('-'.repeat(120));
        for (const effect of report.effects) {
            lines.push(`${truncate(effect.file, 43).padEnd(45)} ${String(effect.depth).padEnd(6)} ${effect.classification.padEnd(22)} ${(effect.autoFixable ? 'Yes' : 'No').padEnd(9)} ${truncate(effect.description, 60)}`);
        }
    }
    return lines.join('\n');
}
function formatImpactCSV(report) {
    const lines = ['file,line,depth,classification,auto_fixable,description'];
    for (const effect of report.effects) {
        lines.push(`"${effect.file}",${effect.line},${effect.depth},"${effect.classification}",${effect.autoFixable},"${effect.description.replace(/"/g, '""')}"`);
    }
    return lines.join('\n');
}
/**
 * Format delete result for display.
 */
export function formatDeleteResult(result, format = 'table') {
    if (format === 'json')
        return JSON.stringify(result, null, 2);
    const lines = [];
    lines.push(`Delete: ${result.targetFile}`);
    lines.push(`Total imports removed: ${result.totalImportsRemoved}`);
    lines.push(`Affected files: ${result.affectedFiles.length}`);
    if (result.affectedFiles.length > 0) {
        lines.push('');
        lines.push(`${'File'.padEnd(50)} ${'Specifiers'.padEnd(30)} Lines`);
        lines.push('-'.repeat(90));
        for (const af of result.affectedFiles) {
            const specifiers = af.importsToRemove.map((i) => i.specifier).join(', ');
            const lineNums = af.importsToRemove.map((i) => i.line).join(', ');
            lines.push(`${truncate(af.path, 48).padEnd(50)} ${truncate(specifiers, 28).padEnd(30)} ${lineNums}`);
        }
    }
    if (result.reExportBreaks.length > 0) {
        lines.push('');
        lines.push(`Re-export breaks: ${result.reExportBreaks.length}`);
        for (const brk of result.reExportBreaks) {
            lines.push(`  ${brk.file}:${brk.line} — re-exports '${brk.symbol}'`);
        }
    }
    return lines.join('\n');
}
/**
 * Format rename result for display.
 */
export function formatRenameResult(result, format = 'table') {
    if (format === 'json')
        return JSON.stringify(result, null, 2);
    const lines = [];
    lines.push(`Rename: '${result.oldName}' -> '${result.newName}'`);
    lines.push(`Source file: ${result.sourceFile}`);
    lines.push(`Total rewrites: ${result.totalRewrites}`);
    lines.push(`Affected files: ${result.affectedFiles.length}`);
    if (result.affectedFiles.length > 0) {
        lines.push('');
        lines.push(`${'File'.padEnd(50)} Rewrites`);
        lines.push('-'.repeat(60));
        for (const af of result.affectedFiles) {
            lines.push(`${truncate(af.path, 48).padEnd(50)} ${af.rewrites.length}`);
        }
    }
    if (result.dynamicAccessWarnings.length > 0) {
        lines.push('');
        lines.push(`Dynamic access warnings: ${result.dynamicAccessWarnings.length}`);
        for (const w of result.dynamicAccessWarnings) {
            lines.push(`  ${w.file}:${w.line} — ${w.context}`);
        }
    }
    return lines.join('\n');
}
/**
 * Format dead code result for display.
 */
export function formatDeadCodeResult(result, format = 'table') {
    if (format === 'json')
        return JSON.stringify(result, null, 2);
    const lines = [];
    lines.push('Dead Code Analysis');
    lines.push('='.repeat(40));
    lines.push(`Entry points: ${result.entryPoints.length}`);
    lines.push(`Reachable files: ${result.reachableFiles}`);
    lines.push(`Dead files: ${result.deadFiles.length}`);
    lines.push(`Dead exports: ${result.deadExports.length}`);
    lines.push(`Total dead lines: ${result.totalDeadLines}`);
    if (result.deadFiles.length > 0) {
        lines.push('');
        lines.push('Dead files:');
        lines.push(`${'File'.padEnd(50)} ${'Confidence'.padEnd(14)} ${'Lines'.padEnd(7)} Reason`);
        lines.push('-'.repeat(100));
        for (const df of result.deadFiles) {
            lines.push(`${truncate(df.path, 48).padEnd(50)} ${df.confidence.padEnd(14)} ${String(df.lineCount).padEnd(7)} ${truncate(df.reason, 40)}`);
        }
    }
    if (result.deadExports.length > 0) {
        lines.push('');
        lines.push('Dead exports:');
        lines.push(`${'File'.padEnd(45)} ${'Export'.padEnd(25)} Line`);
        lines.push('-'.repeat(80));
        for (const de of result.deadExports) {
            lines.push(`${truncate(de.file, 43).padEnd(45)} ${de.exportName.padEnd(25)} ${de.line}`);
        }
    }
    return lines.join('\n');
}
/**
 * Format UI audit result for display.
 */
export function formatUIAuditResult(result, format = 'table') {
    if (format === 'json')
        return JSON.stringify(result, null, 2);
    const lines = [];
    lines.push('UI Audit');
    lines.push('='.repeat(40));
    lines.push(`Components scanned: ${result.totalComponentsScanned}`);
    lines.push(`Total findings: ${result.findings.length}`);
    lines.push('');
    lines.push('Summary:');
    lines.push(`  Missing handlers:      ${result.summary.missingHandlers}`);
    lines.push(`  Unconnected handlers:  ${result.summary.unconnectedHandlers}`);
    lines.push(`  Unused state:          ${result.summary.unusedState}`);
    lines.push(`  Missing keys:          ${result.summary.missingKeys}`);
    lines.push(`  Dead components:       ${result.summary.deadComponents}`);
    if (result.findings.length > 0) {
        lines.push('');
        lines.push(`${'File'.padEnd(40)} ${'Type'.padEnd(20)} ${'Sev'.padEnd(10)} Description`);
        lines.push('-'.repeat(110));
        for (const f of result.findings) {
            lines.push(`${truncate(f.file, 38).padEnd(40)} ${f.type.padEnd(20)} ${f.severity.padEnd(10)} ${truncate(f.description, 50)}`);
        }
    }
    return lines.join('\n');
}
/**
 * Format deps audit result for display.
 */
export function formatDepsAuditResult(result, format = 'table') {
    if (format === 'json')
        return JSON.stringify(result, null, 2);
    const lines = [];
    lines.push('Dependency Audit');
    lines.push('='.repeat(40));
    lines.push(`Declared: ${result.totalDeclared}`);
    lines.push(`Used: ${result.totalUsed}`);
    lines.push(`Unused: ${result.unusedDeps.length}`);
    lines.push(`Undeclared: ${result.undeclaredDeps.length}`);
    if (result.unusedDeps.length > 0) {
        lines.push('');
        lines.push('Unused dependencies:');
        for (const dep of result.unusedDeps) {
            lines.push(`  ${dep.name}${dep.isDev ? ' (dev)' : ''}`);
        }
    }
    if (result.undeclaredDeps.length > 0) {
        lines.push('');
        lines.push('Undeclared dependencies:');
        for (const dep of result.undeclaredDeps) {
            lines.push(`  ${dep.name} — used in: ${dep.usedIn.slice(0, 3).join(', ')}${dep.usedIn.length > 3 ? ` (+${dep.usedIn.length - 3} more)` : ''}`);
        }
    }
    return lines.join('\n');
}
/**
 * Format env audit result for display.
 */
export function formatEnvAuditResult(result, format = 'table') {
    if (format === 'json')
        return JSON.stringify(result, null, 2);
    const lines = [];
    lines.push('Env Audit');
    lines.push('='.repeat(40));
    lines.push(`Declared: ${result.totalDeclared}`);
    lines.push(`Referenced: ${result.totalReferenced}`);
    lines.push(`Stale: ${result.staleVars.length}`);
    lines.push(`Missing: ${result.missingVars.length}`);
    lines.push(`No default: ${result.noDefaultVars.length}`);
    lines.push(`Inconsistent: ${result.inconsistentVars.length}`);
    if (result.staleVars.length > 0) {
        lines.push('');
        lines.push('Stale variables (in .env but not in code):');
        for (const v of result.staleVars) {
            lines.push(`  ${v.name} — declared in: ${v.declaredIn.join(', ')}`);
        }
    }
    if (result.missingVars.length > 0) {
        lines.push('');
        lines.push('Missing variables (in code but not in .env):');
        for (const v of result.missingVars) {
            lines.push(`  ${v.name} — used in: ${v.usedIn.map((u) => `${u.file}:${u.line}`).join(', ')}`);
        }
    }
    if (result.noDefaultVars.length > 0) {
        lines.push('');
        lines.push('Variables without defaults:');
        for (const v of result.noDefaultVars) {
            lines.push(`  ${v.name}`);
        }
    }
    if (result.inconsistentVars.length > 0) {
        lines.push('');
        lines.push('Inconsistent variables:');
        for (const v of result.inconsistentVars) {
            lines.push(`  ${v.name} — present in: ${v.presentIn.join(', ')} | missing from: ${v.missingFrom.join(', ')}`);
        }
    }
    return lines.join('\n');
}
function truncate(str, maxLen) {
    if (str.length <= maxLen)
        return str;
    return str.slice(0, maxLen - 3) + '...';
}
//# sourceMappingURL=output.js.map
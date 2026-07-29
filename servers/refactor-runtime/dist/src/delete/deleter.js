import * as path from 'node:path';
/**
 * Compute the impact of deleting a file from the project.
 * Returns which files are affected and what imports need to be removed.
 * Does NOT actually modify files on disk.
 */
export function computeDelete(targetFile, graph) {
    const affectedFiles = [];
    const reExportBreaks = [];
    let totalImportsRemoved = 0;
    // Find all files that import the target file
    const dependents = graph.reverseEdges.get(targetFile) || new Set();
    for (const depPath of dependents) {
        const fileInfo = graph.nodes.get(depPath);
        if (!fileInfo)
            continue;
        const importsToRemove = [];
        for (const imp of fileInfo.imports) {
            if (imp.resolvedPath !== targetFile)
                continue;
            // Check if this is a re-export (the importing file re-exports from target)
            const isReExport = fileInfo.exports.some((exp) => exp.type === 're-export' && exp.reExportSource === imp.source);
            if (isReExport) {
                // Track re-export breaks: downstream consumers of this re-export will break
                for (const spec of imp.specifiers) {
                    reExportBreaks.push({
                        file: depPath,
                        symbol: spec.alias || spec.name,
                        line: imp.line,
                    });
                }
            }
            // Determine if entire import line can be removed
            // An import line imports only from the target, so full removal
            const fullLineRemoval = true;
            for (const spec of imp.specifiers) {
                importsToRemove.push({
                    line: imp.line,
                    specifier: spec.alias || spec.name,
                    fullLineRemoval,
                });
            }
            // If it's a namespace or side-effect import with no specifiers
            if (imp.specifiers.length === 0) {
                importsToRemove.push({
                    line: imp.line,
                    specifier: imp.source,
                    fullLineRemoval: true,
                });
            }
        }
        if (importsToRemove.length > 0) {
            totalImportsRemoved += importsToRemove.length;
            affectedFiles.push({
                path: depPath,
                importsToRemove,
                applied: false,
            });
        }
    }
    const tasks = generateDeleteTasks(targetFile, affectedFiles, reExportBreaks, graph);
    return {
        targetFile,
        affectedFiles,
        reExportBreaks,
        totalImportsRemoved,
        tasks,
    };
}
function generateDeleteTasks(targetFile, affectedFiles, reExportBreaks, graph) {
    const tasks = [];
    let taskNum = 1;
    for (const affected of affectedFiles) {
        const relativePath = path.relative(graph.projectRoot, affected.path);
        tasks.push({
            id: `delete-${taskNum++}`,
            file: affected.path,
            line: affected.importsToRemove[0]?.line || 0,
            severity: 'high',
            classification: 'mechanical_auto',
            description: `Remove ${affected.importsToRemove.length} import(s) from ${relativePath} that reference deleted file`,
            context: {
                changedEntity: path.basename(targetFile),
                changeType: 'removed',
                callingCode: affected.importsToRemove.map((i) => i.specifier).join(', '),
                suggestedApproach: 'Remove the import statement(s) and any usages of the imported symbols',
            },
            cascadeDepth: 1,
        });
    }
    for (const brk of reExportBreaks) {
        const relativePath = path.relative(graph.projectRoot, brk.file);
        tasks.push({
            id: `delete-${taskNum++}`,
            file: brk.file,
            line: brk.line,
            severity: 'critical',
            classification: 'logic_simple',
            description: `Re-export of '${brk.symbol}' in ${relativePath} will break — downstream consumers need updating`,
            context: {
                changedEntity: brk.symbol,
                changeType: 'removed',
                callingCode: `export { ${brk.symbol} } from '...'`,
                suggestedApproach: 'Remove the re-export and update downstream consumers',
            },
            cascadeDepth: 2,
        });
    }
    return tasks;
}
//# sourceMappingURL=deleter.js.map
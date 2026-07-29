import * as path from 'node:path';
import { computeRelativeImport, isPathAlias, toPathAlias } from '../core/resolver.js';
import { scanForRouteUsages, deriveRoute } from './route-scanner.js';
/**
 * Compute all affected files and new import paths for a file move operation.
 * Does NOT actually modify files — that's rewriter.ts.
 */
export function computeMove(operation, graph, config) {
    const { oldPath, newPath } = operation;
    const affectedFiles = [];
    // Find all files that import the moved file
    const dependents = graph.reverseEdges.get(oldPath) || new Set();
    for (const depPath of dependents) {
        const fileInfo = graph.nodes.get(depPath);
        if (!fileInfo)
            continue;
        for (const imp of fileInfo.imports) {
            if (imp.resolvedPath !== oldPath)
                continue;
            const oldImport = imp.source;
            let newImport;
            if (isPathAlias(oldImport, config)) {
                // Rewrite as path alias
                const alias = toPathAlias(newPath, config);
                newImport = alias || computeRelativeImport(depPath, newPath);
            }
            else {
                // Rewrite as relative import
                newImport = computeRelativeImport(depPath, newPath);
            }
            affectedFiles.push({
                path: depPath,
                oldImport,
                newImport,
                line: imp.line,
                applied: false,
            });
        }
    }
    // Also update imports WITHIN the moved file itself
    const movedFileInfo = graph.nodes.get(oldPath);
    if (movedFileInfo) {
        for (const imp of movedFileInfo.imports) {
            // Skip external/node_module imports
            if (!imp.resolvedPath.startsWith('/') && !imp.resolvedPath.startsWith('\\'))
                continue;
            if (!imp.source.startsWith('.'))
                continue; // Only rewrite relative imports
            const oldImport = imp.source;
            const newImport = computeRelativeImport(newPath, imp.resolvedPath);
            if (oldImport !== newImport) {
                affectedFiles.push({
                    path: newPath, // The file itself (at its new location)
                    oldImport,
                    newImport,
                    line: imp.line,
                    applied: false,
                });
            }
        }
    }
    // Detect API route changes
    const routeChanges = detectRouteChanges(operation, graph, config);
    return {
        operation,
        affectedFiles,
        routeChanges,
        totalFilesUpdated: new Set(affectedFiles.map((f) => f.path)).size,
    };
}
/**
 * Compute moves for a batch of operations.
 * Handles cross-references between moved files correctly.
 */
export function computeBulkMoves(operations, graph, config) {
    // Build a mapping of old paths to new paths for cross-referencing
    const moveMap = new Map();
    for (const op of operations) {
        moveMap.set(op.oldPath, op.newPath);
    }
    // Build reverse map: new path → old path (for graph lookups)
    const reverseMoveMap = new Map();
    for (const op of operations) {
        reverseMoveMap.set(op.newPath, op.oldPath);
    }
    const results = [];
    for (const op of operations) {
        const result = computeMove(op, graph, config);
        // For bulk moves, also update imports that reference OTHER moved files
        for (const affected of result.affectedFiles) {
            // Use the old path for graph lookup when the file is being moved
            const lookupPath = reverseMoveMap.get(affected.path) || affected.path;
            const resolvedTarget = findResolvedTarget(affected.oldImport, lookupPath, graph);
            if (resolvedTarget && moveMap.has(resolvedTarget) && resolvedTarget !== op.oldPath) {
                const newTarget = moveMap.get(resolvedTarget);
                const fromFile = moveMap.get(affected.path) || affected.path;
                if (isPathAlias(affected.oldImport, config)) {
                    const alias = toPathAlias(newTarget, config);
                    affected.newImport = alias || computeRelativeImport(fromFile, newTarget);
                }
                else {
                    affected.newImport = computeRelativeImport(fromFile, newTarget);
                }
            }
        }
        // Filter out no-op rewrites (where correction made old === new)
        result.affectedFiles = result.affectedFiles.filter((af) => af.oldImport !== af.newImport);
        result.totalFilesUpdated = new Set(result.affectedFiles.map((f) => f.path)).size;
        results.push(result);
    }
    return results;
}
/**
 * Expand a folder move into individual file move operations.
 * Enumerates all source files under oldDir and maps them to newDir.
 */
export function expandFolderMove(oldDir, newDir, graph) {
    const absOldDir = path.resolve(oldDir);
    const absNewDir = path.resolve(newDir);
    const operations = [];
    const timestamp = new Date().toISOString();
    // Find all files in the graph that live under oldDir
    for (const filePath of graph.nodes.keys()) {
        if (filePath.startsWith(absOldDir + path.sep) || filePath.startsWith(absOldDir + '/')) {
            const relativePart = filePath.slice(absOldDir.length); // includes leading separator
            const newFilePath = absNewDir + relativePart;
            operations.push({
                oldPath: filePath,
                newPath: newFilePath,
                timestamp,
            });
        }
    }
    return operations;
}
/**
 * Compute a full folder move with all import rewrites and route changes.
 */
export function computeFolderMove(oldDir, newDir, graph, config) {
    const absOldDir = path.resolve(oldDir);
    const absNewDir = path.resolve(newDir);
    const operations = expandFolderMove(absOldDir, absNewDir, graph);
    const results = computeBulkMoves(operations, graph, config);
    // Aggregate route changes across all individual moves
    const allRouteChanges = [];
    for (const result of results) {
        allRouteChanges.push(...result.routeChanges);
    }
    // Count unique files affected across all operations
    const allAffectedPaths = new Set();
    for (const result of results) {
        for (const af of result.affectedFiles) {
            allAffectedPaths.add(af.path);
        }
    }
    return {
        oldDir: absOldDir,
        newDir: absNewDir,
        filesMoved: operations.length,
        operations,
        results,
        routeChanges: allRouteChanges,
        totalFilesUpdated: allAffectedPaths.size,
    };
}
/**
 * Detect if a moved file is a route handler and find all references to its route.
 */
function detectRouteChanges(operation, graph, config) {
    const oldRoute = deriveRoute(operation.oldPath, config.projectRoot);
    const newRoute = deriveRoute(operation.newPath, config.projectRoot);
    // Not a route file, or route didn't change
    if (!oldRoute || !newRoute || oldRoute === newRoute) {
        return [];
    }
    // Scan all project files for references to the old route
    const allFiles = [...graph.nodes.keys()];
    return scanForRouteUsages(allFiles, oldRoute, newRoute);
}
function findResolvedTarget(importSource, fromFile, graph) {
    const fileInfo = graph.nodes.get(fromFile);
    if (!fileInfo)
        return undefined;
    const imp = fileInfo.imports.find((i) => i.source === importSource);
    return imp?.resolvedPath;
}
//# sourceMappingURL=mover.js.map
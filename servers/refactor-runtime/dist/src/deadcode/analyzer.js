import * as fs from 'node:fs';
/**
 * Analyze a dependency graph to find dead (unreachable) files and unused exports.
 *
 * @param graph - The full dependency graph
 * @param entryPoints - Files known to be entry points (e.g., pages, API routes, main)
 */
export function findDeadCode(graph, entryPoints) {
    // 1. BFS from entry points to find all reachable files
    const reachable = new Set();
    const queue = [...entryPoints];
    while (queue.length > 0) {
        const current = queue.shift();
        if (reachable.has(current))
            continue;
        if (!graph.nodes.has(current))
            continue;
        reachable.add(current);
        const deps = graph.edges.get(current) || new Set();
        for (const dep of deps) {
            if (!reachable.has(dep)) {
                queue.push(dep);
            }
        }
    }
    // 2. Find dead files — files in the graph but not reachable from any entry point
    const deadFiles = [];
    let totalDeadLines = 0;
    for (const [filePath, fileInfo] of graph.nodes) {
        if (reachable.has(filePath))
            continue;
        const lineCount = countFileLines(filePath);
        totalDeadLines += lineCount;
        // Determine confidence
        const hasExports = fileInfo.exports.length > 0;
        const hasSideEffects = detectSideEffects(filePath);
        let confidence;
        let reason;
        if (hasSideEffects) {
            confidence = 'side-effect';
            reason = 'File may have side effects (top-level statements); verify before removing';
        }
        else if (!hasExports) {
            confidence = 'possible';
            reason = 'File has no exports and is not imported by any reachable file';
        }
        else {
            confidence = 'definite';
            reason = 'File exports are not imported by any reachable file';
        }
        deadFiles.push({
            path: filePath,
            confidence,
            reason,
            lineCount,
        });
    }
    // 3. Find dead exports — exports in reachable files that no one imports
    const deadExports = findDeadExports(graph, reachable);
    return {
        entryPoints,
        reachableFiles: reachable.size,
        deadFiles,
        deadExports,
        totalDeadLines,
    };
}
/**
 * Find exports that exist in reachable files but are never imported by anyone.
 */
function findDeadExports(graph, reachable) {
    // Build a set of all (file, exportName) pairs that are actually imported by reachable files
    const usedExports = new Set(); // "filePath::exportName"
    for (const importerPath of reachable) {
        const fileInfo = graph.nodes.get(importerPath);
        if (!fileInfo)
            continue;
        for (const imp of fileInfo.imports) {
            const resolvedPath = imp.resolvedPath;
            if (!graph.nodes.has(resolvedPath))
                continue;
            for (const spec of imp.specifiers) {
                if (spec.isNamespace) {
                    // Namespace import uses everything — mark all exports as used
                    const targetFile = graph.nodes.get(resolvedPath);
                    if (targetFile) {
                        for (const exp of targetFile.exports) {
                            usedExports.add(`${resolvedPath}::${exp.name}`);
                        }
                    }
                }
                else if (spec.isDefault) {
                    usedExports.add(`${resolvedPath}::default`);
                }
                else {
                    usedExports.add(`${resolvedPath}::${spec.name}`);
                }
            }
            // Side-effect import (no specifiers) — doesn't use any specific export
        }
    }
    const deadExports = [];
    for (const filePath of reachable) {
        const fileInfo = graph.nodes.get(filePath);
        if (!fileInfo)
            continue;
        for (const exp of fileInfo.exports) {
            // Skip re-exports (they're pass-through)
            if (exp.type === 're-export')
                continue;
            // Skip wildcard exports
            if (exp.name === '*')
                continue;
            const key = exp.isDefault
                ? `${filePath}::default`
                : `${filePath}::${exp.name}`;
            if (!usedExports.has(key)) {
                deadExports.push({
                    file: filePath,
                    exportName: exp.name,
                    line: exp.line,
                    confidence: 'possible', // Could be used dynamically or be an entry point export
                });
            }
        }
    }
    return deadExports;
}
/**
 * Count lines in a file.
 */
function countFileLines(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.split('\n').length;
    }
    catch {
        return 0;
    }
}
/**
 * Simple heuristic to detect if a file has top-level side effects.
 * Looks for top-level function calls, assignments to globals, etc.
 */
function detectSideEffects(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines, comments, imports, exports, type declarations
            if (!trimmed ||
                trimmed.startsWith('//') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('import ') ||
                trimmed.startsWith('export ') ||
                trimmed.startsWith('interface ') ||
                trimmed.startsWith('type ') ||
                trimmed.startsWith('enum ') ||
                trimmed.startsWith('declare ') ||
                trimmed.startsWith('function ') ||
                trimmed.startsWith('class ') ||
                trimmed.startsWith('const ') ||
                trimmed.startsWith('let ') ||
                trimmed.startsWith('var ') ||
                trimmed.startsWith('}') ||
                trimmed.startsWith('{')) {
                continue;
            }
            // If we find a line that looks like a function call at top level
            // (not inside a function/class body), it might be a side effect
            if (trimmed.match(/^\w+[\.(]/) && !trimmed.startsWith('export ')) {
                return true;
            }
        }
    }
    catch {
        // Can't read file — assume no side effects
    }
    return false;
}
//# sourceMappingURL=analyzer.js.map
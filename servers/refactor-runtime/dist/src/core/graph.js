/**
 * Build a dependency graph from a list of parsed files.
 */
export function buildGraph(files, projectRoot) {
    const nodes = new Map();
    const edges = new Map();
    const reverseEdges = new Map();
    // Index all files by path
    for (const file of files) {
        nodes.set(file.path, file);
        edges.set(file.path, new Set());
        reverseEdges.set(file.path, new Set());
    }
    // Build edges from imports
    for (const file of files) {
        for (const imp of file.imports) {
            const resolved = imp.resolvedPath;
            // Only add edges to files within the project
            if (nodes.has(resolved)) {
                edges.get(file.path).add(resolved);
                reverseEdges.get(resolved).add(file.path);
            }
        }
    }
    return { nodes, edges, reverseEdges, projectRoot };
}
/**
 * Find all files that import from a given file (direct dependents).
 */
export function getDependents(graph, filePath) {
    return [...(graph.reverseEdges.get(filePath) || [])];
}
/**
 * Find all files that a given file imports (direct dependencies).
 */
export function getDependencies(graph, filePath) {
    return [...(graph.edges.get(filePath) || [])];
}
/**
 * Get all transitive dependents (files that directly or indirectly import this file).
 */
export function getTransitiveDependents(graph, filePath, maxDepth = Infinity) {
    const visited = new Map(); // path -> depth
    const queue = [
        { path: filePath, depth: 0 },
    ];
    while (queue.length > 0) {
        const { path: current, depth } = queue.shift();
        if (visited.has(current) || depth > maxDepth)
            continue;
        visited.set(current, depth);
        const dependents = graph.reverseEdges.get(current) || new Set();
        for (const dep of dependents) {
            if (!visited.has(dep)) {
                queue.push({ path: dep, depth: depth + 1 });
            }
        }
    }
    visited.delete(filePath); // Don't include the file itself
    return visited;
}
/**
 * Detect circular dependencies in the graph.
 */
export function detectCircularDeps(graph) {
    const cycles = [];
    const visited = new Set();
    const stack = new Set();
    function dfs(node, path) {
        if (stack.has(node)) {
            // Found a cycle - extract it from path
            const cycleStart = path.indexOf(node);
            if (cycleStart !== -1) {
                cycles.push(path.slice(cycleStart));
            }
            return;
        }
        if (visited.has(node))
            return;
        visited.add(node);
        stack.add(node);
        path.push(node);
        const deps = graph.edges.get(node) || new Set();
        for (const dep of deps) {
            dfs(dep, [...path]);
        }
        stack.delete(node);
    }
    for (const node of graph.nodes.keys()) {
        if (!visited.has(node)) {
            dfs(node, []);
        }
    }
    return cycles;
}
/**
 * Find orphaned files (files with no imports and no exports used by others).
 */
export function findOrphans(graph) {
    const orphans = [];
    for (const [filePath, fileInfo] of graph.nodes) {
        const dependents = graph.reverseEdges.get(filePath) || new Set();
        const dependencies = graph.edges.get(filePath) || new Set();
        // A file is an orphan if nothing imports it and it doesn't import anything
        // (likely a dead file)
        if (dependents.size === 0 && dependencies.size === 0) {
            orphans.push(filePath);
        }
    }
    return orphans;
}
/**
 * Full dependency graph analysis.
 */
export function analyzeGraph(graph) {
    const circularDeps = detectCircularDeps(graph);
    const orphans = findOrphans(graph);
    let totalEdges = 0;
    let maxDeps = { file: '', count: 0 };
    let maxDependents = { file: '', count: 0 };
    for (const [file, deps] of graph.edges) {
        totalEdges += deps.size;
        if (deps.size > maxDeps.count) {
            maxDeps = { file, count: deps.size };
        }
    }
    for (const [file, deps] of graph.reverseEdges) {
        if (deps.size > maxDependents.count) {
            maxDependents = { file, count: deps.size };
        }
    }
    const totalNodes = graph.nodes.size;
    const avgDependencies = totalNodes > 0 ? totalEdges / totalNodes : 0;
    return {
        graph,
        circularDeps,
        orphans,
        stats: {
            totalNodes,
            totalEdges,
            avgDependencies: Math.round(avgDependencies * 100) / 100,
            maxDependencies: maxDeps,
            maxDependents,
        },
    };
}
//# sourceMappingURL=graph.js.map
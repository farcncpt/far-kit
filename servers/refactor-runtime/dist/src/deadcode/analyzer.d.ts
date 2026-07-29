import type { DependencyGraph, DeadCodeResult } from '../core/types.js';
/**
 * Analyze a dependency graph to find dead (unreachable) files and unused exports.
 *
 * @param graph - The full dependency graph
 * @param entryPoints - Files known to be entry points (e.g., pages, API routes, main)
 */
export declare function findDeadCode(graph: DependencyGraph, entryPoints: string[]): DeadCodeResult;
//# sourceMappingURL=analyzer.d.ts.map
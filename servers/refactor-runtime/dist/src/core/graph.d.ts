import type { DependencyGraph, FileInfo, AnalysisResult } from './types.js';
/**
 * Build a dependency graph from a list of parsed files.
 */
export declare function buildGraph(files: FileInfo[], projectRoot: string): DependencyGraph;
/**
 * Find all files that import from a given file (direct dependents).
 */
export declare function getDependents(graph: DependencyGraph, filePath: string): string[];
/**
 * Find all files that a given file imports (direct dependencies).
 */
export declare function getDependencies(graph: DependencyGraph, filePath: string): string[];
/**
 * Get all transitive dependents (files that directly or indirectly import this file).
 */
export declare function getTransitiveDependents(graph: DependencyGraph, filePath: string, maxDepth?: number): Map<string, number>;
/**
 * Detect circular dependencies in the graph.
 */
export declare function detectCircularDeps(graph: DependencyGraph): string[][];
/**
 * Find orphaned files (files with no imports and no exports used by others).
 */
export declare function findOrphans(graph: DependencyGraph): string[];
/**
 * Full dependency graph analysis.
 */
export declare function analyzeGraph(graph: DependencyGraph): AnalysisResult;
//# sourceMappingURL=graph.d.ts.map
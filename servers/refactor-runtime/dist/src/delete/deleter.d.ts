import type { DependencyGraph, DeleteResult } from '../core/types.js';
/**
 * Compute the impact of deleting a file from the project.
 * Returns which files are affected and what imports need to be removed.
 * Does NOT actually modify files on disk.
 */
export declare function computeDelete(targetFile: string, graph: DependencyGraph): DeleteResult;
//# sourceMappingURL=deleter.d.ts.map
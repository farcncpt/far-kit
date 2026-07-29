import type { DependencyGraph, MoveOperation, MoveResult, ProjectConfig, FolderMoveResult } from '../core/types.js';
/**
 * Compute all affected files and new import paths for a file move operation.
 * Does NOT actually modify files — that's rewriter.ts.
 */
export declare function computeMove(operation: MoveOperation, graph: DependencyGraph, config: ProjectConfig): MoveResult;
/**
 * Compute moves for a batch of operations.
 * Handles cross-references between moved files correctly.
 */
export declare function computeBulkMoves(operations: MoveOperation[], graph: DependencyGraph, config: ProjectConfig): MoveResult[];
/**
 * Expand a folder move into individual file move operations.
 * Enumerates all source files under oldDir and maps them to newDir.
 */
export declare function expandFolderMove(oldDir: string, newDir: string, graph: DependencyGraph): MoveOperation[];
/**
 * Compute a full folder move with all import rewrites and route changes.
 */
export declare function computeFolderMove(oldDir: string, newDir: string, graph: DependencyGraph, config: ProjectConfig): FolderMoveResult;
//# sourceMappingURL=mover.d.ts.map
import type { DependencyGraph, RenameResult } from '../core/types.js';
import type { ProjectConfig } from '../core/types.js';
/**
 * Compute the impact of renaming an exported symbol in a source file.
 * Scans all dependents for usages of the old name and produces rewrite plans.
 * Does NOT modify files on disk.
 */
export declare function computeRename(sourceFile: string, oldName: string, newName: string, graph: DependencyGraph, config: ProjectConfig): RenameResult;
//# sourceMappingURL=renamer.d.ts.map
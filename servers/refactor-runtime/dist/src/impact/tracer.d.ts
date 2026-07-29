import type { ChangeInfo, CascadeEffect, DependencyGraph } from '../core/types.js';
/**
 * Trace the cascade of a change through the dependency graph.
 * For each downstream file that imports the changed entity, determine the impact.
 */
export declare function traceCascade(change: ChangeInfo, graph: DependencyGraph, maxDepth?: number): CascadeEffect[];
//# sourceMappingURL=tracer.d.ts.map
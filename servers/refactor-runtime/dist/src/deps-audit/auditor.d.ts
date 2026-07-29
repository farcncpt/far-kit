import type { DependencyGraph, ProjectConfig, DepsAuditResult } from '../core/types.js';
/**
 * Audit package.json dependencies against actual imports in the codebase.
 */
export declare function auditDeps(graph: DependencyGraph, config: ProjectConfig, packageJsonPath: string): Promise<DepsAuditResult>;
//# sourceMappingURL=auditor.d.ts.map
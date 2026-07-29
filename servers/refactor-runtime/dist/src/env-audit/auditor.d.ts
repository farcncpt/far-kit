import type { DependencyGraph, ProjectConfig, FileInfo, EnvAuditResult } from '../core/types.js';
/**
 * Audit environment variables: find stale, missing, no-default, and inconsistent vars.
 */
export declare function auditEnv(graph: DependencyGraph, config: ProjectConfig, envFiles: string[], enrichedFiles: Map<string, FileInfo>): EnvAuditResult;
//# sourceMappingURL=auditor.d.ts.map
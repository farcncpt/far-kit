import type { DependencyGraph, ProjectConfig, FileInfo, UIAuditResult } from '../core/types.js';
/**
 * Audit UI components for common issues:
 * - Interactive elements missing event handlers
 * - Missing key props in array rendering
 * - Dead (never-imported) components
 * - Unused state variables
 */
export declare function auditUI(graph: DependencyGraph, config: ProjectConfig, enrichedFiles: Map<string, FileInfo>): UIAuditResult;
//# sourceMappingURL=auditor.d.ts.map
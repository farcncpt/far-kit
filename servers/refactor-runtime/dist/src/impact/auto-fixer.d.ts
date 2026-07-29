import type { CascadeEffect, ImpactReport } from '../core/types.js';
import { AuditLogger } from '../audit/logger.js';
export interface AutoFixResult {
    fixed: FixedEffect[];
    skipped: CascadeEffect[];
    totalFixed: number;
    totalSkipped: number;
}
export interface FixedEffect {
    effect: CascadeEffect;
    appliedFix: string;
}
/**
 * Apply mechanical auto-fixes from an impact report.
 * Only fixes effects classified as 'mechanical_auto'.
 */
export declare function applyAutoFixes(report: ImpactReport, options?: {
    dryRun?: boolean;
    auditLogger?: AuditLogger;
}): AutoFixResult;
//# sourceMappingURL=auto-fixer.d.ts.map
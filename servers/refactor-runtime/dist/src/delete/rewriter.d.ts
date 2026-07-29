import type { DeleteResult } from '../core/types.js';
import { AuditLogger } from '../audit/logger.js';
/**
 * Apply delete rewrites: remove import lines that reference the deleted file.
 */
export declare function applyDeleteRewrites(result: DeleteResult, options?: {
    dryRun?: boolean;
    auditLogger?: AuditLogger;
}): ApplyDeleteResult;
export interface ApplyDeleteResult {
    changes: DeleteAppliedChange[];
    totalFilesChanged: number;
    dryRun: boolean;
}
export interface DeleteAppliedChange {
    file: string;
    success: boolean;
    error?: string;
    linesRemoved: number;
    contentChanged?: boolean;
}
//# sourceMappingURL=rewriter.d.ts.map
import type { MoveResult } from '../core/types.js';
import { AuditLogger } from '../audit/logger.js';
/**
 * Apply import rewrites from a MoveResult to actual files on disk.
 */
export declare function applyRewrites(result: MoveResult, options?: {
    dryRun?: boolean;
    auditLogger?: AuditLogger;
}): ApplyResult;
/**
 * Physically move a file from oldPath to newPath.
 */
export declare function moveFile(oldPath: string, newPath: string, options?: {
    dryRun?: boolean;
    auditLogger?: AuditLogger;
}): void;
export interface ApplyResult {
    changes: AppliedChange[];
    totalFilesChanged: number;
    dryRun: boolean;
}
export interface AppliedChange {
    file: string;
    success: boolean;
    error?: string;
    rewrites: RewriteDetail[];
    contentChanged?: boolean;
}
export interface RewriteDetail {
    oldImport: string;
    newImport: string;
    line: number;
    applied: boolean;
}
//# sourceMappingURL=rewriter.d.ts.map
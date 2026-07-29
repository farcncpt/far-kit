import type { AuditLog, AuditEntry } from '../core/types.js';
/**
 * Rollback an operation using its audit log.
 * Processes entries in reverse order to undo changes.
 */
export declare function rollback(auditLog: AuditLog, options?: {
    dryRun?: boolean;
}): RollbackResult;
export interface RollbackResult {
    auditId: string;
    totalActions: number;
    successful: number;
    failed: number;
    actions: RollbackAction[];
    dryRun: boolean;
}
export interface RollbackAction {
    entry: AuditEntry;
    success: boolean;
    reason?: string;
    dryRun?: boolean;
}
//# sourceMappingURL=rollback.d.ts.map
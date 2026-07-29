import type { AuditEntry, AuditLog } from '../core/types.js';
/**
 * Audit logger that records all write operations for rollback support.
 */
export declare class AuditLogger {
    private entries;
    private id;
    private logDir;
    private projectRoot;
    constructor(logDir: string, projectRoot: string);
    get auditId(): string;
    log(entry: AuditEntry): void;
    /**
     * Write the audit log to disk as JSON.
     */
    save(): string;
    /**
     * Write the audit log to disk as CSV.
     */
    saveCSV(): string;
    getEntries(): AuditEntry[];
}
/**
 * Load an audit log from disk.
 */
export declare function loadAuditLog(logPath: string): AuditLog;
/**
 * Find an audit log by ID in a directory.
 */
export declare function findAuditLog(logDir: string, auditId: string): AuditLog | null;
//# sourceMappingURL=logger.d.ts.map
import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * Audit logger that records all write operations for rollback support.
 */
export class AuditLogger {
    entries = [];
    id;
    logDir;
    projectRoot;
    constructor(logDir, projectRoot) {
        this.id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.logDir = logDir;
        this.projectRoot = projectRoot;
        fs.mkdirSync(logDir, { recursive: true });
    }
    get auditId() {
        return this.id;
    }
    log(entry) {
        this.entries.push(entry);
    }
    /**
     * Write the audit log to disk as JSON.
     */
    save() {
        const logPath = path.join(this.logDir, `${this.id}.json`);
        const auditLog = {
            id: this.id,
            entries: this.entries,
            projectRoot: this.projectRoot,
            createdAt: new Date().toISOString(),
        };
        fs.writeFileSync(logPath, JSON.stringify(auditLog, null, 2), 'utf-8');
        return logPath;
    }
    /**
     * Write the audit log to disk as CSV.
     */
    saveCSV() {
        const logPath = path.join(this.logDir, `${this.id}.csv`);
        const header = 'timestamp,operation,file,line,rollbackable\n';
        const rows = this.entries
            .map((e) => `${e.timestamp},${e.operation},"${e.file}",${e.line},${e.rollbackable}`)
            .join('\n');
        fs.writeFileSync(logPath, header + rows, 'utf-8');
        return logPath;
    }
    getEntries() {
        return [...this.entries];
    }
}
/**
 * Load an audit log from disk.
 */
export function loadAuditLog(logPath) {
    const raw = fs.readFileSync(logPath, 'utf-8');
    return JSON.parse(raw);
}
/**
 * Find an audit log by ID in a directory.
 */
export function findAuditLog(logDir, auditId) {
    const logPath = path.join(logDir, `${auditId}.json`);
    if (!fs.existsSync(logPath))
        return null;
    return loadAuditLog(logPath);
}
//# sourceMappingURL=logger.js.map
import { Command } from 'commander';
import * as path from 'node:path';
import { findAuditLog } from '../../audit/logger.js';
import { rollback } from '../../audit/rollback.js';
export const rollbackCommand = new Command('rollback')
    .description('Undo a previous operation using audit log')
    .argument('<auditLogId>', 'Audit log ID to rollback')
    .option('--log-dir <dir>', 'Directory containing audit logs', '.refactor-audit')
    .option('--dry-run', 'Preview rollback without applying', false)
    .action((auditLogId, opts) => {
    const logDir = path.resolve(opts.logDir);
    const auditLog = findAuditLog(logDir, auditLogId);
    if (!auditLog) {
        console.error(`Audit log not found: ${auditLogId}`);
        console.error(`Searched in: ${logDir}`);
        process.exit(1);
    }
    if (opts.dryRun) {
        console.log('[DRY RUN] No files will be modified.\n');
    }
    const result = rollback(auditLog, { dryRun: opts.dryRun });
    console.log(`Rollback: ${result.auditId}`);
    console.log(`Total actions: ${result.totalActions}`);
    console.log(`Successful: ${result.successful}`);
    console.log(`Failed: ${result.failed}`);
    if (result.failed > 0) {
        console.log('\nFailed actions:');
        for (const action of result.actions.filter((a) => !a.success)) {
            console.log(`  ${action.entry.operation} ${action.entry.file}: ${action.reason}`);
        }
    }
});
//# sourceMappingURL=rollback.js.map
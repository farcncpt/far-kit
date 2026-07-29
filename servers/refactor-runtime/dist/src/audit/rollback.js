import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * Rollback an operation using its audit log.
 * Processes entries in reverse order to undo changes.
 */
export function rollback(auditLog, options = {}) {
    const { dryRun = false } = options;
    const results = [];
    // Process entries in reverse order
    const reversedEntries = [...auditLog.entries].reverse();
    for (const entry of reversedEntries) {
        if (!entry.rollbackable) {
            results.push({
                entry,
                success: false,
                reason: 'Entry is not rollbackable',
            });
            continue;
        }
        switch (entry.operation) {
            case 'rewrite': {
                // Restore original file content
                if (!dryRun) {
                    try {
                        fs.writeFileSync(entry.file, entry.oldContent, 'utf-8');
                        results.push({ entry, success: true });
                    }
                    catch (err) {
                        results.push({
                            entry,
                            success: false,
                            reason: `Failed to restore: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
                else {
                    results.push({ entry, success: true, dryRun: true });
                }
                break;
            }
            case 'move': {
                // oldContent contains "moved to: <newPath>" and newContent contains the file content
                const match = entry.oldContent.match(/^moved to: (.+)$/);
                if (match) {
                    const newPath = match[1];
                    if (!dryRun) {
                        try {
                            // Move back from newPath to entry.file (the original path)
                            if (fs.existsSync(newPath)) {
                                const destDir = path.dirname(entry.file);
                                fs.mkdirSync(destDir, { recursive: true });
                                fs.renameSync(newPath, entry.file);
                                results.push({ entry, success: true });
                            }
                            else {
                                // File at new path doesn't exist, try to recreate from content
                                const destDir = path.dirname(entry.file);
                                fs.mkdirSync(destDir, { recursive: true });
                                fs.writeFileSync(entry.file, entry.newContent, 'utf-8');
                                results.push({ entry, success: true });
                            }
                        }
                        catch (err) {
                            results.push({
                                entry,
                                success: false,
                                reason: `Failed to move back: ${err instanceof Error ? err.message : String(err)}`,
                            });
                        }
                    }
                    else {
                        results.push({ entry, success: true, dryRun: true });
                    }
                }
                break;
            }
            case 'auto-fix': {
                // Restore the original content
                if (!dryRun) {
                    try {
                        fs.writeFileSync(entry.file, entry.oldContent, 'utf-8');
                        results.push({ entry, success: true });
                    }
                    catch (err) {
                        results.push({
                            entry,
                            success: false,
                            reason: `Failed to rollback auto-fix: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
                else {
                    results.push({ entry, success: true, dryRun: true });
                }
                break;
            }
        }
    }
    return {
        auditId: auditLog.id,
        totalActions: results.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        actions: results,
        dryRun,
    };
}
//# sourceMappingURL=rollback.js.map
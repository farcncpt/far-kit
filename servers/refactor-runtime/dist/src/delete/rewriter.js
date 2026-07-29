import * as fs from 'node:fs';
/**
 * Apply delete rewrites: remove import lines that reference the deleted file.
 */
export function applyDeleteRewrites(result, options = {}) {
    const { dryRun = false, auditLogger } = options;
    const changes = [];
    for (const affected of result.affectedFiles) {
        if (!fs.existsSync(affected.path)) {
            changes.push({
                file: affected.path,
                success: false,
                error: `File not found: ${affected.path}`,
                linesRemoved: 0,
            });
            continue;
        }
        const originalContent = fs.readFileSync(affected.path, 'utf-8');
        const lines = originalContent.split('\n');
        // Collect unique line numbers to remove (1-based)
        const linesToRemove = new Set();
        for (const imp of affected.importsToRemove) {
            if (imp.fullLineRemoval) {
                linesToRemove.add(imp.line);
            }
        }
        // Remove lines (convert to 0-based index)
        const newLines = lines.filter((_, idx) => !linesToRemove.has(idx + 1));
        const newContent = newLines.join('\n');
        if (newContent !== originalContent && !dryRun) {
            fs.writeFileSync(affected.path, newContent, 'utf-8');
            affected.applied = true;
            if (auditLogger) {
                auditLogger.log({
                    timestamp: new Date().toISOString(),
                    operation: 'rewrite',
                    file: affected.path,
                    oldContent: originalContent,
                    newContent,
                    line: 0,
                    rollbackable: true,
                });
            }
        }
        changes.push({
            file: affected.path,
            success: true,
            linesRemoved: linesToRemove.size,
            contentChanged: newContent !== originalContent,
        });
    }
    return {
        changes,
        totalFilesChanged: changes.filter((c) => c.contentChanged).length,
        dryRun,
    };
}
//# sourceMappingURL=rewriter.js.map
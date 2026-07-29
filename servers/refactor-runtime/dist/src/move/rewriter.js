import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * Apply import rewrites from a MoveResult to actual files on disk.
 */
export function applyRewrites(result, options = {}) {
    const { dryRun = false, auditLogger } = options;
    const changes = [];
    // Group affected files by path
    const byFile = new Map();
    for (const affected of result.affectedFiles) {
        const existing = byFile.get(affected.path) || [];
        existing.push(affected);
        byFile.set(affected.path, existing);
    }
    for (const [filePath, rewrites] of byFile) {
        // For the moved file at newPath, read from oldPath if it hasn't been moved yet
        const readPath = filePath === result.operation.newPath
            ? (fs.existsSync(filePath) ? filePath : result.operation.oldPath)
            : filePath;
        if (!fs.existsSync(readPath)) {
            changes.push({
                file: filePath,
                success: false,
                error: `File not found: ${readPath}`,
                rewrites: [],
            });
            continue;
        }
        const originalContent = fs.readFileSync(readPath, 'utf-8');
        let newContent = originalContent;
        const appliedRewrites = [];
        for (const rewrite of rewrites) {
            const { oldImport, newImport, line } = rewrite;
            if (oldImport === newImport)
                continue;
            // Replace the import string in the file content
            // We match the full import specifier (in quotes) to avoid partial matches
            const patterns = [
                `'${oldImport}'`,
                `"${oldImport}"`,
                `\`${oldImport}\``,
            ];
            let replaced = false;
            for (const pattern of patterns) {
                const replacement = pattern[0] + newImport + pattern[0];
                if (newContent.includes(pattern)) {
                    newContent = newContent.replace(pattern, replacement);
                    replaced = true;
                    appliedRewrites.push({
                        oldImport,
                        newImport,
                        line,
                        applied: true,
                    });
                    rewrite.applied = true;
                    break;
                }
            }
            if (!replaced) {
                appliedRewrites.push({
                    oldImport,
                    newImport,
                    line,
                    applied: false,
                });
            }
        }
        if (newContent !== originalContent && !dryRun) {
            fs.writeFileSync(filePath, newContent, 'utf-8');
            if (auditLogger) {
                auditLogger.log({
                    timestamp: new Date().toISOString(),
                    operation: 'rewrite',
                    file: filePath,
                    oldContent: originalContent,
                    newContent,
                    line: 0,
                    rollbackable: true,
                });
            }
        }
        changes.push({
            file: filePath,
            success: true,
            rewrites: appliedRewrites,
            contentChanged: newContent !== originalContent,
        });
    }
    return {
        changes,
        totalFilesChanged: changes.filter((c) => c.contentChanged).length,
        dryRun,
    };
}
/**
 * Physically move a file from oldPath to newPath.
 */
export function moveFile(oldPath, newPath, options = {}) {
    const { dryRun = false, auditLogger } = options;
    if (dryRun)
        return;
    // Ensure destination directory exists
    const destDir = path.dirname(newPath);
    fs.mkdirSync(destDir, { recursive: true });
    // Read original content for audit
    const content = fs.readFileSync(oldPath, 'utf-8');
    // Move the file
    fs.renameSync(oldPath, newPath);
    if (auditLogger) {
        auditLogger.log({
            timestamp: new Date().toISOString(),
            operation: 'move',
            file: oldPath,
            oldContent: `moved to: ${newPath}`,
            newContent: content,
            line: 0,
            rollbackable: true,
        });
    }
}
//# sourceMappingURL=rewriter.js.map
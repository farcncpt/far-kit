import * as fs from 'node:fs';
/**
 * Apply mechanical auto-fixes from an impact report.
 * Only fixes effects classified as 'mechanical_auto'.
 */
export function applyAutoFixes(report, options = {}) {
    const { dryRun = false, auditLogger } = options;
    const fixed = [];
    const skipped = [];
    for (const effect of report.effects) {
        if (!effect.autoFixable || effect.classification !== 'mechanical_auto') {
            skipped.push(effect);
            continue;
        }
        if (!effect.suggestedFix) {
            skipped.push(effect);
            continue;
        }
        const result = applyFix(effect, report, dryRun, auditLogger);
        if (result) {
            fixed.push({ effect, appliedFix: result });
        }
        else {
            skipped.push(effect);
        }
    }
    return {
        fixed,
        skipped,
        totalFixed: fixed.length,
        totalSkipped: skipped.length,
    };
}
function applyFix(effect, report, dryRun, auditLogger) {
    const { change } = report;
    try {
        const content = fs.readFileSync(effect.file, 'utf-8');
        let newContent = content;
        switch (change.changeType) {
            case 'renamed': {
                // Simple find-replace of the old name with new name
                const oldName = change.entity;
                const newName = change.newSignature || '';
                if (newName && content.includes(oldName)) {
                    newContent = replaceEntityName(content, oldName, newName);
                }
                break;
            }
            case 'param_removed': {
                // This is harder to do generically — skip for now unless we have a clear pattern
                break;
            }
            case 'interface_field_removed': {
                // Remove the field from object literals
                const fieldName = change.entity.split('.').pop();
                if (fieldName) {
                    // Remove "fieldName: value," or "fieldName: value" from object literals
                    const pattern = new RegExp(`\\s*${escapeRegex(fieldName)}\\s*:.*?,?\\n?`, 'g');
                    newContent = content.replace(pattern, '\n');
                }
                break;
            }
            case 'param_added_optional':
            case 'return_type_narrowed': {
                // No changes needed for these
                return 'No changes needed — compatible';
            }
            default:
                return null;
        }
        if (newContent !== content) {
            if (!dryRun) {
                fs.writeFileSync(effect.file, newContent, 'utf-8');
                if (auditLogger) {
                    auditLogger.log({
                        timestamp: new Date().toISOString(),
                        operation: 'auto-fix',
                        file: effect.file,
                        oldContent: content,
                        newContent,
                        line: effect.line,
                        rollbackable: true,
                    });
                }
            }
            return `Applied ${change.changeType} fix`;
        }
        return null;
    }
    catch {
        return null;
    }
}
function replaceEntityName(content, oldName, newName) {
    // Use word boundary matching to avoid partial replacements
    const regex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');
    return content.replace(regex, newName);
}
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=auto-fixer.js.map
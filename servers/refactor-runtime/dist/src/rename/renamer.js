import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * Compute the impact of renaming an exported symbol in a source file.
 * Scans all dependents for usages of the old name and produces rewrite plans.
 * Does NOT modify files on disk.
 */
export function computeRename(sourceFile, oldName, newName, graph, config) {
    const affectedFiles = [];
    const dynamicAccessWarnings = [];
    let totalRewrites = 0;
    // 1. Rewrite the export in the source file itself
    const sourceRewrites = computeSourceFileRewrites(sourceFile, oldName, newName);
    if (sourceRewrites.length > 0) {
        totalRewrites += sourceRewrites.length;
        affectedFiles.push({
            path: sourceFile,
            rewrites: sourceRewrites,
            applied: false,
        });
    }
    // 2. Find all files that import from the source file
    const dependents = graph.reverseEdges.get(sourceFile) || new Set();
    for (const depPath of dependents) {
        const fileInfo = graph.nodes.get(depPath);
        if (!fileInfo)
            continue;
        const rewrites = [];
        for (const imp of fileInfo.imports) {
            if (imp.resolvedPath !== sourceFile)
                continue;
            for (const spec of imp.specifiers) {
                // Named import that matches the old name
                if (spec.name === oldName && !spec.isNamespace && !spec.isDefault) {
                    if (spec.alias) {
                        // import { oldName as alias } — only rename the specifier, not the alias
                        rewrites.push({
                            line: imp.line,
                            oldText: `${oldName} as ${spec.alias}`,
                            newText: `${newName} as ${spec.alias}`,
                        });
                    }
                    else {
                        // import { oldName } — rename to { newName }
                        rewrites.push({
                            line: imp.line,
                            oldText: oldName,
                            newText: newName,
                        });
                        // Also need to rename all usages of oldName in this file's body
                        const bodyRewrites = findUsagesInFile(depPath, oldName, newName, imp.line);
                        rewrites.push(...bodyRewrites);
                    }
                }
                // Default import where source exported default with oldName
                if (spec.isDefault && spec.alias === oldName) {
                    // import oldName from '...' → no rename needed in import (alias is local choice)
                    // But if they used the same name, they might want to update it too
                    // We don't force this — it's a local name decision
                }
            }
        }
        // Check for re-exports
        for (const exp of fileInfo.exports) {
            if (exp.type === 're-export' && exp.name === oldName) {
                // This file re-exports the renamed symbol
                rewrites.push({
                    line: exp.line,
                    oldText: oldName,
                    newText: newName,
                });
            }
        }
        // Scan for dynamic access patterns: obj["oldName"] or obj[variable]
        const dynamicWarnings = findDynamicAccess(depPath, oldName);
        dynamicAccessWarnings.push(...dynamicWarnings);
        if (rewrites.length > 0) {
            totalRewrites += rewrites.length;
            affectedFiles.push({
                path: depPath,
                rewrites,
                applied: false,
            });
        }
    }
    const tasks = generateRenameTasks(sourceFile, oldName, newName, affectedFiles, dynamicAccessWarnings, graph);
    return {
        oldName,
        newName,
        sourceFile,
        affectedFiles,
        dynamicAccessWarnings,
        totalRewrites,
        tasks,
    };
}
/**
 * Compute rewrites needed in the source file where the export is defined.
 */
function computeSourceFileRewrites(filePath, oldName, newName) {
    if (!fs.existsSync(filePath))
        return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const rewrites = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        // Match export declarations: export function oldName, export const oldName, etc.
        // Use word boundary matching to avoid partial matches
        const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`);
        if (pattern.test(line)) {
            // Check if this is an export or declaration line
            if (line.includes('export ') ||
                line.includes(`function ${oldName}`) ||
                line.includes(`const ${oldName}`) ||
                line.includes(`let ${oldName}`) ||
                line.includes(`class ${oldName}`) ||
                line.includes(`interface ${oldName}`) ||
                line.includes(`type ${oldName}`)) {
                rewrites.push({
                    line: lineNum,
                    oldText: oldName,
                    newText: newName,
                });
            }
        }
    }
    return rewrites;
}
/**
 * Find usages of a symbol name in a file's body (after imports).
 * Returns rewrites for each usage found.
 */
function findUsagesInFile(filePath, oldName, newName, importLine) {
    if (!fs.existsSync(filePath))
        return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const rewrites = [];
    const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`);
    for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        if (lineNum === importLine)
            continue; // Skip the import line itself
        const line = lines[i];
        // Skip import/export lines
        if (line.trimStart().startsWith('import ') || line.trimStart().startsWith('export '))
            continue;
        if (pattern.test(line)) {
            rewrites.push({
                line: lineNum,
                oldText: oldName,
                newText: newName,
            });
        }
    }
    return rewrites;
}
/**
 * Find dynamic property access patterns that might reference the old name.
 * e.g., obj["oldName"], someMap.get("oldName")
 */
function findDynamicAccess(filePath, oldName) {
    if (!fs.existsSync(filePath))
        return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const warnings = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check for string literal references: ["oldName"], ("oldName"), 'oldName'
        if (line.includes(`["${oldName}"]`) ||
            line.includes(`['${oldName}']`) ||
            line.includes(`("${oldName}")`) ||
            line.includes(`('${oldName}')`)) {
            warnings.push({
                file: filePath,
                line: i + 1,
                context: line.trim(),
            });
        }
    }
    return warnings;
}
function generateRenameTasks(sourceFile, oldName, newName, affectedFiles, dynamicWarnings, graph) {
    const tasks = [];
    let taskNum = 1;
    for (const affected of affectedFiles) {
        const relativePath = path.relative(graph.projectRoot, affected.path);
        tasks.push({
            id: `rename-${taskNum++}`,
            file: affected.path,
            line: affected.rewrites[0]?.line || 0,
            severity: 'medium',
            classification: 'mechanical_auto',
            description: `Rename '${oldName}' to '${newName}' in ${relativePath} (${affected.rewrites.length} occurrence(s))`,
            context: {
                changedEntity: oldName,
                changeType: 'renamed',
                callingCode: affected.rewrites[0]?.oldText || oldName,
                suggestedApproach: `Replace all occurrences of '${oldName}' with '${newName}'`,
            },
            cascadeDepth: affected.path === sourceFile ? 0 : 1,
        });
    }
    for (const warning of dynamicWarnings) {
        const relativePath = path.relative(graph.projectRoot, warning.file);
        tasks.push({
            id: `rename-${taskNum++}`,
            file: warning.file,
            line: warning.line,
            severity: 'high',
            classification: 'logic_simple',
            description: `Dynamic access to '${oldName}' in ${relativePath} may need manual update`,
            context: {
                changedEntity: oldName,
                changeType: 'renamed',
                callingCode: warning.context,
                suggestedApproach: `Check if string literal '${oldName}' refers to the renamed symbol and update if so`,
            },
            cascadeDepth: 1,
        });
    }
    return tasks;
}
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=renamer.js.map
import { getTransitiveDependents } from '../core/graph.js';
import { classifyEffect } from './classifier.js';
import * as fs from 'node:fs';
/**
 * Trace the cascade of a change through the dependency graph.
 * For each downstream file that imports the changed entity, determine the impact.
 */
export function traceCascade(change, graph, maxDepth = 10) {
    const effects = [];
    const dependents = getTransitiveDependents(graph, change.file, maxDepth);
    for (const [depPath, depth] of dependents) {
        const fileInfo = graph.nodes.get(depPath);
        if (!fileInfo)
            continue;
        // Check if this file imports the changed entity
        const relevantImports = fileInfo.imports.filter((imp) => imp.resolvedPath === change.file);
        if (relevantImports.length === 0)
            continue;
        // Check if any import specifier matches the changed entity
        const entityName = change.entity.includes('.')
            ? change.entity.split('.')[0] // For interface fields, check the interface name
            : change.entity;
        const usesEntity = relevantImports.some((imp) => {
            // Namespace imports always match
            if (imp.specifiers.some((s) => s.isNamespace))
                return true;
            // Star re-exports always match
            if (imp.specifiers.length === 0 && imp.type === 'static')
                return true;
            // Check named imports
            return imp.specifiers.some((s) => s.name === entityName || s.name === 'default');
        });
        if (!usesEntity)
            continue;
        // Find the calling code in the dependent file
        const callingCode = findUsageInFile(depPath, entityName);
        const classification = classifyEffect(change, callingCode, depth);
        effects.push({
            file: depPath,
            line: findUsageLine(depPath, entityName),
            depth,
            classification: classification.classification,
            description: classification.description,
            callingCode,
            suggestedFix: classification.suggestedFix,
            autoFixable: classification.autoFixable,
        });
    }
    // Sort by depth (closest first) then by file
    effects.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
    return effects;
}
function findUsageInFile(filePath, entityName) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            // Skip import lines
            if (line.trim().startsWith('import '))
                continue;
            // Look for usage of the entity
            if (line.includes(entityName)) {
                return line.trim();
            }
        }
        return '';
    }
    catch {
        return '';
    }
}
function findUsageLine(filePath, entityName) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().startsWith('import '))
                continue;
            if (lines[i].includes(entityName)) {
                return i + 1;
            }
        }
        return 0;
    }
    catch {
        return 0;
    }
}
//# sourceMappingURL=tracer.js.map
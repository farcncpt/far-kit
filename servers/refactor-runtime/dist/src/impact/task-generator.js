/**
 * Generate structured task items from cascade effects that need manual attention.
 */
export function generateTasks(report) {
    const tasks = [];
    let taskCounter = 0;
    for (const effect of report.effects) {
        // Skip auto-fixed effects
        if (effect.autoFixable && effect.classification === 'mechanical_auto') {
            continue;
        }
        taskCounter++;
        tasks.push({
            id: `task-${String(taskCounter).padStart(3, '0')}`,
            file: effect.file,
            line: effect.line,
            severity: classificationToSeverity(effect.classification, effect.depth),
            classification: effect.classification,
            description: effect.description,
            context: {
                changedEntity: report.change.entity,
                changeType: report.change.changeType,
                callingCode: effect.callingCode,
                suggestedApproach: effect.suggestedFix || 'Review and update manually',
            },
            cascadeDepth: effect.depth,
        });
    }
    // Sort by severity then depth
    tasks.sort((a, b) => {
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        const sa = severityOrder[a.severity];
        const sb = severityOrder[b.severity];
        if (sa !== sb)
            return sa - sb;
        return a.cascadeDepth - b.cascadeDepth;
    });
    return tasks;
}
function classificationToSeverity(classification, depth) {
    switch (classification) {
        case 'architectural':
            return 'critical';
        case 'logic_complex':
            return depth <= 1 ? 'critical' : 'high';
        case 'logic_simple':
            return depth <= 1 ? 'high' : 'medium';
        case 'mechanical_confirm':
            return depth <= 1 ? 'medium' : 'low';
        case 'mechanical_auto':
            return 'low';
    }
}
/**
 * Format tasks as a markdown checklist for human consumption.
 */
export function formatTasksAsMarkdown(tasks) {
    const lines = ['# Impact Tasks\n'];
    const bySeverity = groupBy(tasks, (t) => t.severity);
    for (const severity of ['critical', 'high', 'medium', 'low']) {
        const group = bySeverity.get(severity);
        if (!group || group.length === 0)
            continue;
        lines.push(`## ${severity.toUpperCase()} (${group.length})\n`);
        for (const task of group) {
            lines.push(`- [ ] **${task.id}** \`${task.file}:${task.line}\``);
            lines.push(`  - ${task.description}`);
            if (task.context.callingCode) {
                lines.push(`  - Code: \`${task.context.callingCode}\``);
            }
            lines.push(`  - Approach: ${task.context.suggestedApproach}`);
            lines.push(`  - Cascade depth: ${task.cascadeDepth}\n`);
        }
    }
    return lines.join('\n');
}
/**
 * Format tasks as JSON for machine consumption.
 */
export function formatTasksAsJSON(tasks) {
    return JSON.stringify({ tasks }, null, 2);
}
function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
        const key = keyFn(item);
        const group = map.get(key) || [];
        group.push(item);
        map.set(key, group);
    }
    return map;
}
//# sourceMappingURL=task-generator.js.map
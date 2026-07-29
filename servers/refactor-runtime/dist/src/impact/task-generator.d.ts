import type { ImpactReport, TaskItem } from '../core/types.js';
/**
 * Generate structured task items from cascade effects that need manual attention.
 */
export declare function generateTasks(report: ImpactReport): TaskItem[];
/**
 * Format tasks as a markdown checklist for human consumption.
 */
export declare function formatTasksAsMarkdown(tasks: TaskItem[]): string;
/**
 * Format tasks as JSON for machine consumption.
 */
export declare function formatTasksAsJSON(tasks: TaskItem[]): string;
//# sourceMappingURL=task-generator.d.ts.map
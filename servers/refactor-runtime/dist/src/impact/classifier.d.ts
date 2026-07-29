import type { ChangeInfo, Classification } from '../core/types.js';
export interface ClassificationResult {
    classification: Classification;
    description: string;
    suggestedFix?: string;
    autoFixable: boolean;
}
/**
 * Classify the impact of a change on a specific piece of calling code.
 */
export declare function classifyEffect(change: ChangeInfo, callingCode: string, depth: number): ClassificationResult;
//# sourceMappingURL=classifier.d.ts.map
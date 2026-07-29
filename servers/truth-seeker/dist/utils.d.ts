export interface Suggestion {
    value: string;
    confidence: number;
    distance: number;
}
/**
 * Returns a list of suggestions from candidates that are similar to the target string.
 * Uses Levenshtein distance to calculate similarity.
 */
export declare function getSuggestions(target: string, candidates: string[], limit?: number): Suggestion[];

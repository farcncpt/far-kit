import Levenshtein from "fast-levenshtein";
/**
 * Returns a list of suggestions from candidates that are similar to the target string.
 * Uses Levenshtein distance to calculate similarity.
 */
export function getSuggestions(target, candidates, limit = 3) {
    const suggestions = candidates.map(candidate => {
        const distance = Levenshtein.get(target, candidate);
        // Calculate confidence: 1 - (distance / max_length)
        // This is a simple heuristic.
        const maxLength = Math.max(target.length, candidate.length);
        const confidence = maxLength === 0 ? 1 : 1 - (distance / maxLength);
        return {
            value: candidate,
            confidence: parseFloat(confidence.toFixed(2)),
            distance
        };
    });
    // Filter for reasonable matches (e.g., confidence > 0.4) and sort by confidence
    return suggestions
        .filter(s => s.confidence > 0.4)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, limit);
}
//# sourceMappingURL=utils.js.map
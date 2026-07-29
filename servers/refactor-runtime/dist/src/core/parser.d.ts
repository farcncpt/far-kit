import type { FileInfo, ProjectConfig } from './types.js';
/**
 * Reset the shared project (useful for testing).
 */
export declare function resetParser(): void;
export type EnrichmentType = 'symbolUsages' | 'jsxElements' | 'envReferences' | 'callSites';
/**
 * Parse a single file and extract imports/exports.
 */
export declare function parseFile(filePath: string, config: ProjectConfig, enrichments?: EnrichmentType[]): FileInfo;
//# sourceMappingURL=parser.d.ts.map
import type { ScanStats, MoveResult, AnalysisResult, ImpactReport, FolderMoveResult, DeleteResult, RenameResult, DeadCodeResult, UIAuditResult, DepsAuditResult, EnvAuditResult } from '../core/types.js';
type OutputFormat = 'table' | 'json' | 'csv';
/**
 * Format scan results for display.
 */
export declare function formatScanResult(stats: ScanStats, format?: OutputFormat): string;
/**
 * Format move result for display.
 */
export declare function formatMoveResult(result: MoveResult, format?: OutputFormat): string;
/**
 * Format folder move result for display.
 */
export declare function formatFolderMoveResult(result: FolderMoveResult, format?: OutputFormat): string;
/**
 * Format analysis result for display.
 */
export declare function formatAnalysisResult(analysis: AnalysisResult, format?: OutputFormat): string;
/**
 * Format impact report for display.
 */
export declare function formatImpactReport(report: ImpactReport, format?: OutputFormat): string;
/**
 * Format delete result for display.
 */
export declare function formatDeleteResult(result: DeleteResult, format?: OutputFormat): string;
/**
 * Format rename result for display.
 */
export declare function formatRenameResult(result: RenameResult, format?: OutputFormat): string;
/**
 * Format dead code result for display.
 */
export declare function formatDeadCodeResult(result: DeadCodeResult, format?: OutputFormat): string;
/**
 * Format UI audit result for display.
 */
export declare function formatUIAuditResult(result: UIAuditResult, format?: OutputFormat): string;
/**
 * Format deps audit result for display.
 */
export declare function formatDepsAuditResult(result: DepsAuditResult, format?: OutputFormat): string;
/**
 * Format env audit result for display.
 */
export declare function formatEnvAuditResult(result: EnvAuditResult, format?: OutputFormat): string;
export {};
//# sourceMappingURL=output.d.ts.map
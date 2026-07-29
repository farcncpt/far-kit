import type { RouteChange } from '../core/types.js';
/**
 * Derive the URL route from a filesystem path.
 * Returns undefined if the file is not a Next.js route handler.
 *
 * Examples:
 *   src/app/api/puck/route.ts       → /api/puck
 *   src/app/editor/[pageId]/page.tsx → /editor/[pageId]
 *   app/api/health/route.ts         → /api/health
 */
export declare function deriveRoute(filePath: string, projectRoot: string): string | undefined;
/**
 * Scan files for string literals that reference an API route URL.
 * Returns all matches with line numbers and context.
 */
export declare function scanForRouteUsages(files: string[], oldRoute: string, newRoute: string): RouteChange[];
/**
 * Apply route rewrites to files on disk.
 */
export declare function applyRouteRewrites(routeChanges: RouteChange[], options?: {
    dryRun?: boolean;
}): void;
//# sourceMappingURL=route-scanner.d.ts.map
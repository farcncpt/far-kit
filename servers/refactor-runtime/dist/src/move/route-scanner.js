import * as fs from 'node:fs';
import * as path from 'node:path';
/**
 * Next.js route handler filenames that define API/page routes.
 */
const ROUTE_FILES = new Set([
    'route.ts', 'route.tsx', 'route.js', 'route.jsx',
    'page.ts', 'page.tsx', 'page.js', 'page.jsx',
]);
/**
 * Derive the URL route from a filesystem path.
 * Returns undefined if the file is not a Next.js route handler.
 *
 * Examples:
 *   src/app/api/puck/route.ts       → /api/puck
 *   src/app/editor/[pageId]/page.tsx → /editor/[pageId]
 *   app/api/health/route.ts         → /api/health
 */
export function deriveRoute(filePath, projectRoot) {
    const filename = path.basename(filePath);
    if (!ROUTE_FILES.has(filename))
        return undefined;
    // Get the path relative to the project root
    const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    // Find the app directory segment
    const appIndex = findAppDirIndex(rel);
    if (appIndex === -1)
        return undefined;
    // Extract the route path between "app/" and the filename
    const parts = rel.split('/');
    const routeParts = parts.slice(appIndex + 1, -1); // skip "app" and filename
    // Filter out route group directories (parentheses)
    const filteredParts = routeParts.filter((p) => !p.startsWith('('));
    if (filteredParts.length === 0)
        return '/';
    return '/' + filteredParts.join('/');
}
/**
 * Find the index of the "app" directory in a relative path.
 * Handles both "app/..." and "src/app/...".
 */
function findAppDirIndex(relPath) {
    const parts = relPath.split('/');
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'app')
            return i;
    }
    return -1;
}
/**
 * Scan files for string literals that reference an API route URL.
 * Returns all matches with line numbers and context.
 */
export function scanForRouteUsages(files, oldRoute, newRoute) {
    const changes = [];
    for (const filePath of files) {
        if (!fs.existsSync(filePath))
            continue;
        let content;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            continue;
        }
        // Skip binary files or very large files
        if (content.length > 5_000_000)
            continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Look for the old route in string literals (single, double, or backtick quotes)
            // Match patterns like: '/api/puck', "/api/puck", `/api/puck`, `/api/puck/agent`
            const matches = findRouteInLine(line, oldRoute);
            for (const match of matches) {
                changes.push({
                    file: filePath,
                    line: i + 1,
                    oldRoute: match.matchedRoute,
                    newRoute: match.matchedRoute.replace(oldRoute, newRoute),
                    context: line.trim(),
                    applied: false,
                });
            }
        }
    }
    return changes;
}
/**
 * Find occurrences of a route path within string literals on a single line.
 */
function findRouteInLine(line, route) {
    const matches = [];
    // Look for the route inside quoted strings
    // Pattern: quote char + chars + route + optional more path + quote char
    const quoteChars = ["'", '"', '`'];
    for (const q of quoteChars) {
        let searchFrom = 0;
        while (searchFrom < line.length) {
            const start = line.indexOf(q, searchFrom);
            if (start === -1)
                break;
            const end = line.indexOf(q, start + 1);
            if (end === -1)
                break;
            const stringContent = line.slice(start + 1, end);
            // Check if the string starts with the route or contains the full route segment
            if (stringContent === route || stringContent.startsWith(route + '/') || stringContent.startsWith(route + '?')) {
                matches.push({ matchedRoute: stringContent });
            }
            searchFrom = end + 1;
        }
    }
    return matches;
}
/**
 * Apply route rewrites to files on disk.
 */
export function applyRouteRewrites(routeChanges, options = {}) {
    const { dryRun = false } = options;
    if (dryRun)
        return;
    // Group by file
    const byFile = new Map();
    for (const change of routeChanges) {
        const existing = byFile.get(change.file) || [];
        existing.push(change);
        byFile.set(change.file, existing);
    }
    for (const [filePath, changes] of byFile) {
        if (!fs.existsSync(filePath))
            continue;
        let content = fs.readFileSync(filePath, 'utf-8');
        let modified = false;
        for (const change of changes) {
            // Replace old route with new route in string literals
            const patterns = [
                `'${change.oldRoute}'`,
                `"${change.oldRoute}"`,
                `\`${change.oldRoute}\``,
            ];
            const replacements = [
                `'${change.newRoute}'`,
                `"${change.newRoute}"`,
                `\`${change.newRoute}\``,
            ];
            for (let i = 0; i < patterns.length; i++) {
                if (content.includes(patterns[i])) {
                    content = content.replace(patterns[i], replacements[i]);
                    change.applied = true;
                    modified = true;
                }
            }
        }
        if (modified) {
            fs.writeFileSync(filePath, content, 'utf-8');
        }
    }
}
//# sourceMappingURL=route-scanner.js.map
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePathAlias } from '../config/loader.js';
const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];
/**
 * Resolve an import path to an absolute file path.
 *
 * Handles:
 * - Relative imports: ./foo, ../bar
 * - Path aliases: @/lib/auth
 * - Barrel files: ./utils -> ./utils/index.ts
 * - Extension-less imports: ./foo -> ./foo.ts
 * - Node modules (returns the source string as-is)
 */
export function resolveImportPath(source, fromDir, config) {
    // Node built-in modules
    if (source.startsWith('node:') || isNodeBuiltin(source)) {
        return source;
    }
    // Try path alias first
    const aliasResolved = resolvePathAlias(source, config);
    if (aliasResolved) {
        const resolved = resolveFilePath(aliasResolved);
        if (resolved)
            return resolved;
    }
    // Relative imports
    if (source.startsWith('.')) {
        const absolute = path.resolve(fromDir, source);
        const resolved = resolveFilePath(absolute);
        if (resolved)
            return resolved;
        return absolute; // Return best guess even if file doesn't exist
    }
    // Bare specifiers (node_modules packages)
    return source;
}
/**
 * Try to resolve a file path, checking extensions and index files.
 * Handles the TypeScript convention where source uses .js extensions
 * but actual files are .ts.
 */
function resolveFilePath(basePath) {
    // Exact match
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
        return basePath;
    }
    // If path ends with .js/.jsx, try replacing with .ts/.tsx (TS module resolution)
    const ext = path.extname(basePath);
    if (ext === '.js' || ext === '.jsx') {
        const tsExt = ext === '.js' ? '.ts' : '.tsx';
        const withTsExt = basePath.slice(0, -ext.length) + tsExt;
        if (fs.existsSync(withTsExt) && fs.statSync(withTsExt).isFile()) {
            return withTsExt;
        }
        // Also try .tsx for .js
        if (ext === '.js') {
            const withTsx = basePath.slice(0, -ext.length) + '.tsx';
            if (fs.existsSync(withTsx) && fs.statSync(withTsx).isFile()) {
                return withTsx;
            }
        }
    }
    // Try adding extensions
    for (const addExt of TS_EXTENSIONS) {
        const withExt = basePath + addExt;
        if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
            return withExt;
        }
    }
    // Try as directory with index file
    if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
        for (const addExt of TS_EXTENSIONS) {
            const indexPath = path.join(basePath, `index${addExt}`);
            if (fs.existsSync(indexPath)) {
                return indexPath;
            }
        }
    }
    // If path ends with .js, strip extension and try directory/index
    if (ext === '.js' || ext === '.jsx') {
        const withoutExt = basePath.slice(0, -ext.length);
        if (fs.existsSync(withoutExt) && fs.statSync(withoutExt).isDirectory()) {
            for (const addExt of TS_EXTENSIONS) {
                const indexPath = path.join(withoutExt, `index${addExt}`);
                if (fs.existsSync(indexPath)) {
                    return indexPath;
                }
            }
        }
    }
    return null;
}
/**
 * Compute a relative import path from one file to another.
 * Returns a path like "./foo" or "../bar/baz" (without extension).
 */
export function computeRelativeImport(fromFile, toFile) {
    const fromDir = path.dirname(fromFile);
    let rel = path.relative(fromDir, toFile);
    // Remove extension
    const ext = path.extname(rel);
    if (TS_EXTENSIONS.includes(ext)) {
        rel = rel.slice(0, -ext.length);
    }
    // Remove /index suffix (barrel imports)
    if (rel.endsWith('/index') || rel.endsWith('\\index')) {
        rel = rel.slice(0, -6);
    }
    // Ensure starts with ./ or ../
    if (!rel.startsWith('.')) {
        rel = './' + rel;
    }
    // Normalize to forward slashes
    return rel.replace(/\\/g, '/');
}
/**
 * Check if a source string refers to a path alias.
 */
export function isPathAlias(source, config) {
    for (const pattern of Object.keys(config.pathAliases)) {
        const prefix = pattern.replace('/*', '/');
        if (source.startsWith(prefix) || source === pattern.replace('/*', '')) {
            return true;
        }
    }
    return false;
}
/**
 * Convert an absolute path back to a path alias string.
 * Returns undefined if no alias matches.
 */
export function toPathAlias(absolutePath, config) {
    for (const [pattern, targets] of Object.entries(config.pathAliases)) {
        const target = targets[0];
        const targetDir = target.replace('/*', '').replace('./', '');
        const targetAbsolute = path.join(config.projectRoot, targetDir);
        if (absolutePath.startsWith(targetAbsolute)) {
            const rest = absolutePath.slice(targetAbsolute.length + 1);
            const prefix = pattern.replace('/*', '/');
            // Remove extension and /index
            let clean = rest;
            const ext = path.extname(clean);
            if (TS_EXTENSIONS.includes(ext)) {
                clean = clean.slice(0, -ext.length);
            }
            if (clean.endsWith('/index') || clean.endsWith('\\index')) {
                clean = clean.slice(0, -6);
            }
            return prefix + clean.replace(/\\/g, '/');
        }
    }
    return undefined;
}
const NODE_BUILTINS = new Set([
    'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
    'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
    'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
    'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
    'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads',
    'zlib',
]);
function isNodeBuiltin(source) {
    const base = source.split('/')[0];
    return NODE_BUILTINS.has(base);
}
//# sourceMappingURL=resolver.js.map
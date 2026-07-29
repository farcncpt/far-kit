import * as fs from 'node:fs';
import * as path from 'node:path';
const DEFAULT_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
const DEFAULT_EXCLUDE = [
    'node_modules/**',
    'dist/**',
    'build/**',
    '.git/**',
    'coverage/**',
    '*.d.ts',
];
export function loadProjectConfig(projectRoot) {
    const tsConfigPath = findTsConfig(projectRoot);
    const pathAliases = {};
    let include = DEFAULT_INCLUDE;
    let exclude = DEFAULT_EXCLUDE;
    if (tsConfigPath) {
        const tsConfig = parseTsConfig(tsConfigPath);
        if (tsConfig.compilerOptions?.paths) {
            for (const [alias, targets] of Object.entries(tsConfig.compilerOptions.paths)) {
                pathAliases[alias] = targets;
            }
        }
        if (tsConfig.include) {
            include = normalizeTsConfigInclude(tsConfig.include);
        }
        if (tsConfig.exclude) {
            exclude = [...DEFAULT_EXCLUDE, ...tsConfig.exclude];
        }
    }
    return {
        projectRoot: path.resolve(projectRoot),
        tsConfigPath,
        pathAliases,
        include,
        exclude,
    };
}
/**
 * TypeScript's tsconfig "include" accepts directory names (e.g. "src") which
 * means "include all files under src/". Glob requires explicit patterns, so
 * we convert bare directory names into glob patterns.
 */
function normalizeTsConfigInclude(include) {
    return include.map((pattern) => {
        // Already a glob pattern
        if (pattern.includes('*') || pattern.includes('?'))
            return pattern;
        // Strip trailing slash if present
        const clean = pattern.replace(/\/$/, '');
        // Convert directory name to glob: "src" -> "src/**/*.ts", "src/**/*.tsx", etc.
        return `${clean}/**/*.{ts,tsx,js,jsx}`;
    });
}
function findTsConfig(projectRoot) {
    const candidates = ['tsconfig.json', 'tsconfig.app.json', 'jsconfig.json'];
    for (const name of candidates) {
        const p = path.join(projectRoot, name);
        if (fs.existsSync(p))
            return p;
    }
    return undefined;
}
function parseTsConfig(tsConfigPath) {
    const raw = fs.readFileSync(tsConfigPath, 'utf-8');
    // Strip comments while preserving string contents.
    // Process character by character to avoid matching inside strings.
    const stripped = stripJsonComments(raw);
    try {
        return JSON.parse(stripped);
    }
    catch {
        return {};
    }
}
function stripJsonComments(json) {
    let result = '';
    let i = 0;
    while (i < json.length) {
        // String literal — pass through unchanged
        if (json[i] === '"') {
            result += '"';
            i++;
            while (i < json.length && json[i] !== '"') {
                if (json[i] === '\\') {
                    result += json[i] + (json[i + 1] || '');
                    i += 2;
                }
                else {
                    result += json[i];
                    i++;
                }
            }
            if (i < json.length) {
                result += '"';
                i++;
            }
        }
        // Line comment
        else if (json[i] === '/' && json[i + 1] === '/') {
            // Skip until end of line
            while (i < json.length && json[i] !== '\n')
                i++;
        }
        // Block comment
        else if (json[i] === '/' && json[i + 1] === '*') {
            i += 2;
            while (i < json.length && !(json[i] === '*' && json[i + 1] === '/'))
                i++;
            i += 2; // skip */
        }
        // Trailing comma before } or ]
        else if (json[i] === ',' && /^\s*[\]}]/.test(json.slice(i + 1))) {
            // Skip the trailing comma
            i++;
        }
        else {
            result += json[i];
            i++;
        }
    }
    return result;
}
/**
 * Resolve a path alias (e.g. "@/lib/auth") to an absolute path.
 * Returns undefined if the source doesn't match any alias.
 */
export function resolvePathAlias(source, config) {
    for (const [pattern, targets] of Object.entries(config.pathAliases)) {
        // Convert glob pattern "@/*" to regex "^@/(.*)"
        const prefix = pattern.replace('/*', '/');
        const wildcard = pattern.endsWith('/*');
        if (wildcard && source.startsWith(prefix)) {
            const rest = source.slice(prefix.length);
            // Use the first target
            const target = targets[0];
            const targetDir = target.replace('/*', '/').replace('./', '');
            return path.join(config.projectRoot, targetDir, rest);
        }
        else if (!wildcard && source === pattern) {
            const target = targets[0];
            return path.join(config.projectRoot, target.replace('./', ''));
        }
    }
    return undefined;
}
//# sourceMappingURL=loader.js.map
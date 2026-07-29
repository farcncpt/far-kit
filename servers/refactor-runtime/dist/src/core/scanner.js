import * as path from 'node:path';
import { glob } from 'glob';
import { parseFile } from './parser.js';
const LANGUAGE_MAP = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.css': 'css',
};
/**
 * Scan a codebase directory and return all parseable files with their imports/exports.
 */
export async function scanProject(config) {
    const filePaths = await discoverFiles(config);
    const files = [];
    for (const absPath of filePaths) {
        const ext = path.extname(absPath);
        const language = LANGUAGE_MAP[ext];
        if (!language)
            continue;
        try {
            const fileInfo = parseFile(absPath, config);
            files.push(fileInfo);
        }
        catch (err) {
            // Skip files that fail to parse
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Warning: Failed to parse ${absPath}: ${msg}\n`);
        }
    }
    const stats = computeStats(files);
    return { files, stats };
}
// File types that tsconfig.include won't list but matter for dependency auditing
const SUPPLEMENTAL_PATTERNS = ['**/*.mjs', '**/*.cjs', '**/*.css'];
async function discoverFiles(config) {
    const basePatterns = config.include.length > 0
        ? config.include
        : ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
    // Always include supplemental patterns so CSS @imports and config files are scanned
    const patterns = [...basePatterns, ...SUPPLEMENTAL_PATTERNS];
    const ignorePatterns = config.exclude;
    const results = [];
    for (const pattern of patterns) {
        const matches = await glob(pattern, {
            cwd: config.projectRoot,
            absolute: true,
            ignore: ignorePatterns,
            nodir: true,
        });
        results.push(...matches);
    }
    // Deduplicate
    return [...new Set(results)];
}
function computeStats(files) {
    const byLanguage = {};
    let totalImports = 0;
    let totalExports = 0;
    for (const f of files) {
        byLanguage[f.language] = (byLanguage[f.language] || 0) + 1;
        totalImports += f.imports.length;
        totalExports += f.exports.length;
    }
    return {
        totalFiles: files.length,
        byLanguage,
        totalImports,
        totalExports,
    };
}
//# sourceMappingURL=scanner.js.map
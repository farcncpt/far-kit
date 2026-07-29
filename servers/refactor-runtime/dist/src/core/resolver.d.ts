import type { ProjectConfig } from './types.js';
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
export declare function resolveImportPath(source: string, fromDir: string, config: ProjectConfig): string;
/**
 * Compute a relative import path from one file to another.
 * Returns a path like "./foo" or "../bar/baz" (without extension).
 */
export declare function computeRelativeImport(fromFile: string, toFile: string): string;
/**
 * Check if a source string refers to a path alias.
 */
export declare function isPathAlias(source: string, config: ProjectConfig): boolean;
/**
 * Convert an absolute path back to a path alias string.
 * Returns undefined if no alias matches.
 */
export declare function toPathAlias(absolutePath: string, config: ProjectConfig): string | undefined;
//# sourceMappingURL=resolver.d.ts.map
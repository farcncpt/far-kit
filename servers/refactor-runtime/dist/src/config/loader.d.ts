import type { ProjectConfig } from '../core/types.js';
export declare function loadProjectConfig(projectRoot: string): ProjectConfig;
/**
 * Resolve a path alias (e.g. "@/lib/auth") to an absolute path.
 * Returns undefined if the source doesn't match any alias.
 */
export declare function resolvePathAlias(source: string, config: ProjectConfig): string | undefined;
//# sourceMappingURL=loader.d.ts.map
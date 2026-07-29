import * as fs from 'node:fs';
/**
 * Parse a .env file and return a map of variable names to their values.
 */
function parseEnvFile(filePath) {
    const vars = new Map();
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1)
            continue;
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (key) {
            vars.set(key, value);
        }
    }
    return vars;
}
/**
 * Audit environment variables: find stale, missing, no-default, and inconsistent vars.
 */
export function auditEnv(graph, config, envFiles, enrichedFiles) {
    // 1. Parse all env files
    const envFileMaps = new Map();
    const allDeclaredVars = new Set();
    for (const envFile of envFiles) {
        const vars = parseEnvFile(envFile);
        envFileMaps.set(envFile, vars);
        for (const key of vars.keys()) {
            allDeclaredVars.add(key);
        }
    }
    // 2. Collect all env references from enriched files
    const referencedVars = new Map();
    for (const [filePath, fileInfo] of enrichedFiles) {
        if (!fileInfo.envReferences)
            continue;
        for (const ref of fileInfo.envReferences) {
            if (!referencedVars.has(ref.variable)) {
                referencedVars.set(ref.variable, []);
            }
            referencedVars.get(ref.variable).push({
                file: fileInfo.relativePath,
                line: ref.line,
                hasDefault: ref.hasDefault,
            });
        }
    }
    // 3. Stale vars: in env files but never referenced in code
    const staleVars = [];
    for (const varName of allDeclaredVars) {
        if (!referencedVars.has(varName)) {
            const declaredIn = [];
            for (const [envFile, vars] of envFileMaps) {
                if (vars.has(varName)) {
                    declaredIn.push(envFile);
                }
            }
            staleVars.push({ name: varName, declaredIn });
        }
    }
    // 4. Missing vars: referenced in code but not in any env file
    const missingVars = [];
    for (const [varName, refs] of referencedVars) {
        if (!allDeclaredVars.has(varName)) {
            missingVars.push({
                name: varName,
                usedIn: refs.map((r) => ({ file: r.file, line: r.line })),
            });
        }
    }
    // 5. No-default vars: referenced without fallback AND not in any env file
    const noDefaultVars = [];
    for (const [varName, refs] of referencedVars) {
        const hasAnyDefault = refs.some((r) => r.hasDefault);
        if (!hasAnyDefault && !allDeclaredVars.has(varName)) {
            noDefaultVars.push({
                name: varName,
                usedIn: refs.map((r) => ({ file: r.file, line: r.line })),
            });
        }
    }
    // 6. Inconsistent vars: present in some env files but missing from others
    const inconsistentVars = [];
    if (envFiles.length > 1) {
        for (const varName of allDeclaredVars) {
            const presentIn = [];
            const missingFrom = [];
            for (const [envFile, vars] of envFileMaps) {
                if (vars.has(varName)) {
                    presentIn.push(envFile);
                }
                else {
                    missingFrom.push(envFile);
                }
            }
            if (missingFrom.length > 0 && presentIn.length > 0) {
                inconsistentVars.push({ name: varName, presentIn, missingFrom });
            }
        }
    }
    return {
        staleVars,
        missingVars,
        noDefaultVars,
        inconsistentVars,
        totalDeclared: allDeclaredVars.size,
        totalReferenced: referencedVars.size,
    };
}
//# sourceMappingURL=auditor.js.map
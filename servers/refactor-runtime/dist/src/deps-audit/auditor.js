import * as fs from 'node:fs';
import { glob } from 'glob';
// Known implicit dependencies that should not be flagged as unused
const IMPLICIT_DEPS = new Set([
    'typescript',
    'vite',
    'webpack',
    'rollup',
    'esbuild',
    'parcel',
    'vitest',
    'jest',
    'mocha',
    'prettier',
    'ts-node',
    'tsx',
    'turbo',
    'next',
]);
// Peer/runtime dependencies required by declared packages but rarely imported directly
const PEER_DEP_MAP = {
    'next': ['react', 'react-dom'],
    'react': ['react-dom'],
    '@tiptap/react': ['@tiptap/pm'],
    '@tiptap/starter-kit': ['@tiptap/pm'],
    'vitest': ['@vitest/runner'],
    'tailwindcss': ['postcss', 'autoprefixer'],
};
const IMPLICIT_PREFIXES = [
    '@types/',
    'eslint',
    '@eslint/',
    'babel',
    '@babel/',
];
// Node.js built-in modules
const NODE_BUILTINS = new Set([
    'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
    'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
    'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
    'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
    'sys', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
    'worker_threads', 'zlib',
]);
/**
 * Extract the package name from an import specifier.
 * Handles scoped packages: "@scope/pkg/sub" -> "@scope/pkg"
 * Handles unscoped: "lodash/fp" -> "lodash"
 */
function extractPackageName(importSource) {
    // Skip relative imports
    if (importSource.startsWith('.') || importSource.startsWith('/')) {
        return null;
    }
    // Skip node: protocol builtins
    if (importSource.startsWith('node:')) {
        return null;
    }
    // Skip bare node builtins
    const firstSegment = importSource.split('/')[0];
    if (NODE_BUILTINS.has(firstSegment)) {
        return null;
    }
    // Scoped package: @scope/pkg or @scope/pkg/sub
    if (importSource.startsWith('@')) {
        const parts = importSource.split('/');
        if (parts.length >= 2) {
            return `${parts[0]}/${parts[1]}`;
        }
        return importSource;
    }
    // Unscoped package: pkg or pkg/sub
    return importSource.split('/')[0];
}
function isImplicitDep(name) {
    if (IMPLICIT_DEPS.has(name))
        return true;
    return IMPLICIT_PREFIXES.some((prefix) => name.startsWith(prefix));
}
/**
 * Scan config files for package references that aren't import statements.
 * Covers: PostCSS plugin keys, Tailwind content config, etc.
 */
async function scanConfigFileRefs(projectRoot, declaredDeps) {
    const found = new Set();
    const configGlobs = [
        'postcss.config.*',
        'tailwind.config.*',
        'babel.config.*',
        '.babelrc',
        'vite.config.*',
        'next.config.*',
    ];
    for (const pattern of configGlobs) {
        const matches = await glob(pattern, {
            cwd: projectRoot,
            absolute: true,
            nodir: true,
        });
        for (const filePath of matches) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                // Check if any declared dep name appears as a string in the config file
                for (const [depName] of declaredDeps) {
                    // Match the dep name as a quoted string (key or value)
                    const escaped = depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`['"\`]${escaped}['"\`]`);
                    if (regex.test(content)) {
                        found.add(depName);
                    }
                }
            }
            catch {
                // Skip unreadable config files
            }
        }
    }
    return found;
}
/**
 * Audit package.json dependencies against actual imports in the codebase.
 */
export async function auditDeps(graph, config, packageJsonPath) {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const declaredDeps = new Map(); // name -> isDev
    const dependencies = pkg.dependencies || {};
    const devDependencies = pkg.devDependencies || {};
    for (const name of Object.keys(dependencies)) {
        declaredDeps.set(name, false);
    }
    for (const name of Object.keys(devDependencies)) {
        declaredDeps.set(name, true);
    }
    // Scan all imports in the graph to find used packages
    const usedPackages = new Map(); // pkgName -> set of files
    for (const [filePath, fileInfo] of graph.nodes) {
        for (const imp of fileInfo.imports) {
            const pkgName = extractPackageName(imp.source);
            if (pkgName) {
                if (!usedPackages.has(pkgName)) {
                    usedPackages.set(pkgName, new Set());
                }
                usedPackages.get(pkgName).add(fileInfo.relativePath);
            }
        }
    }
    // Scan config files for package references (plugin keys, string refs)
    const configRefs = await scanConfigFileRefs(config.projectRoot, declaredDeps);
    for (const dep of configRefs) {
        if (!usedPackages.has(dep)) {
            usedPackages.set(dep, new Set(['(config file)']));
        }
    }
    // Build set of packages needed as peer deps of used/declared packages
    const peerRequired = new Set();
    for (const [parent, peers] of Object.entries(PEER_DEP_MAP)) {
        if (declaredDeps.has(parent) || usedPackages.has(parent)) {
            for (const peer of peers) {
                peerRequired.add(peer);
            }
        }
    }
    // Find unused deps
    const unusedDeps = [];
    for (const [name, isDev] of declaredDeps) {
        if (isImplicitDep(name))
            continue;
        if (peerRequired.has(name))
            continue;
        if (!usedPackages.has(name)) {
            unusedDeps.push({ name, isDev });
        }
    }
    // Find undeclared deps
    const undeclaredDeps = [];
    for (const [pkgName, files] of usedPackages) {
        if (!declaredDeps.has(pkgName)) {
            undeclaredDeps.push({
                name: pkgName,
                usedIn: [...files],
            });
        }
    }
    const totalDeclared = declaredDeps.size;
    const totalUsed = usedPackages.size;
    return {
        unusedDeps,
        undeclaredDeps,
        duplicateImports: [], // Handled by graph dedup already
        totalDeclared,
        totalUsed,
    };
}
//# sourceMappingURL=auditor.js.map
import { z } from "zod";
import { resolve, join } from "path";
import { existsSync, readFileSync } from "fs";
// Schema for the tool
export const analyzeProjectChecksSchema = z.object({
    projectRoot: z.string().describe("Path to the project root directory"),
    verbose: z.boolean().default(false).describe("Include detailed detection info"),
});
// Detect frameworks from package.json and file structure
async function detectFrameworks(projectRoot) {
    const frameworks = [];
    // Read package.json
    let packageJson = {};
    try {
        const content = readFileSync(join(projectRoot, "package.json"), "utf-8");
        packageJson = JSON.parse(content);
    }
    catch {
        return frameworks;
    }
    const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
    };
    // Next.js detection
    const nextVersion = allDeps["next"];
    const hasAppRouter = existsSync(join(projectRoot, "src/app")) ||
        existsSync(join(projectRoot, "app"));
    const hasPagesRouter = existsSync(join(projectRoot, "src/pages")) ||
        existsSync(join(projectRoot, "pages"));
    if (nextVersion) {
        const patterns = [];
        if (hasAppRouter)
            patterns.push("App Router");
        if (hasPagesRouter)
            patterns.push("Pages Router");
        frameworks.push({
            name: "Next.js",
            detected: true,
            version: nextVersion,
            patterns,
        });
    }
    // React (standalone)
    if (allDeps["react"] && !nextVersion) {
        frameworks.push({
            name: "React",
            detected: true,
            version: allDeps["react"],
            patterns: ["Standalone React"],
        });
    }
    // Vue
    if (allDeps["vue"] || allDeps["nuxt"]) {
        frameworks.push({
            name: allDeps["nuxt"] ? "Nuxt" : "Vue",
            detected: true,
            version: allDeps["vue"] || allDeps["nuxt"],
            patterns: [],
        });
    }
    // Express/Node
    if (allDeps["express"]) {
        frameworks.push({
            name: "Express",
            detected: true,
            version: allDeps["express"],
            patterns: ["Node.js API"],
        });
    }
    return frameworks;
}
// Detect auth libraries
async function detectAuthLibraries(projectRoot) {
    const authLibraries = [];
    // Read package.json
    let packageJson = {};
    try {
        const content = readFileSync(join(projectRoot, "package.json"), "utf-8");
        packageJson = JSON.parse(content);
    }
    catch {
        return authLibraries;
    }
    const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
    };
    // Stack Auth - uses suspendIfSsr
    if (allDeps["@stackframe/stack"]) {
        authLibraries.push({
            name: "Stack Auth",
            detected: true,
            hasSSRBailout: true,
            hooks: ["useUser", "useAuth", "useStackApp"],
        });
    }
    // NextAuth/Auth.js
    if (allDeps["next-auth"] || allDeps["@auth/core"]) {
        authLibraries.push({
            name: "NextAuth",
            detected: true,
            hasSSRBailout: false, // Uses server-side session
            hooks: ["useSession"],
        });
    }
    // Clerk
    if (allDeps["@clerk/nextjs"]) {
        authLibraries.push({
            name: "Clerk",
            detected: true,
            hasSSRBailout: true,
            hooks: ["useUser", "useAuth", "useClerk"],
        });
    }
    // Supabase Auth
    if (allDeps["@supabase/auth-helpers-nextjs"] || allDeps["@supabase/ssr"]) {
        authLibraries.push({
            name: "Supabase Auth",
            detected: true,
            hasSSRBailout: true,
            hooks: ["useUser", "useSession", "useSupabaseClient"],
        });
    }
    // Firebase Auth
    if (allDeps["firebase"] || allDeps["@firebase/auth"]) {
        authLibraries.push({
            name: "Firebase Auth",
            detected: true,
            hasSSRBailout: true,
            hooks: ["useAuthState", "useIdToken"],
        });
    }
    return authLibraries;
}
// Generate recommended checks based on detection
function generateRecommendedChecks(frameworks, authLibraries, hasTypeScript, hasMonorepo, hasPrisma) {
    const checks = [];
    // Always recommend TypeScript check if TS is used
    if (hasTypeScript) {
        checks.push({
            name: "typescript-ci",
            recommended: true,
            reason: "TypeScript detected - validates compilation in CI environment",
            priority: "required",
            estimatedTime: "10-30s",
        });
    }
    // Always recommend import check
    checks.push({
        name: "imports",
        recommended: true,
        reason: "Validates all import paths resolve correctly",
        priority: "required",
        estimatedTime: "2-5s",
    });
    // Always recommend circular dependency check
    checks.push({
        name: "circular",
        recommended: true,
        reason: "Detects circular dependencies that can cause runtime issues",
        priority: "required",
        estimatedTime: "3-10s",
    });
    // Next.js App Router specific checks
    const nextjs = frameworks.find(f => f.name === "Next.js");
    const hasAppRouter = nextjs?.patterns.includes("App Router");
    if (hasAppRouter) {
        // Check if any auth library has SSR bailout
        const ssrBailoutAuth = authLibraries.find(a => a.hasSSRBailout);
        if (ssrBailoutAuth) {
            checks.push({
                name: "suspense-boundaries",
                recommended: true,
                reason: `${ssrBailoutAuth.name} detected - hooks like ${ssrBailoutAuth.hooks.join(", ")} require Suspense boundaries in layouts`,
                priority: "required",
                estimatedTime: "2-5s",
            });
        }
        // Next.js build check (slow but thorough)
        checks.push({
            name: "next-build",
            recommended: false, // Optional because it's slow
            reason: "Runs full Next.js build - catches prerender errors but slow (~30s+)",
            priority: "optional",
            estimatedTime: "30-120s",
        });
    }
    // Prisma check
    if (hasPrisma) {
        checks.push({
            name: "prisma-schema",
            recommended: true,
            reason: "Prisma detected - validates schema and generated types",
            priority: "recommended",
            estimatedTime: "5-10s",
        });
    }
    // Env check
    checks.push({
        name: "env",
        recommended: true,
        reason: "Validates environment variables are documented",
        priority: "recommended",
        estimatedTime: "1-2s",
    });
    // Unused code check (optional)
    checks.push({
        name: "unused",
        recommended: false,
        reason: "Detects unused code with Knip - can be slow on large projects",
        priority: "optional",
        estimatedTime: "10-60s",
    });
    return checks;
}
// Main analysis function
export async function analyzeProjectChecks(params) {
    const { projectRoot, verbose } = params;
    const absoluteRoot = resolve(projectRoot);
    // Validate project root
    if (!existsSync(absoluteRoot)) {
        return {
            status: "error",
            projectRoot: absoluteRoot,
            frameworks: [],
            authLibraries: [],
            hasTypeScript: false,
            hasMonorepo: false,
            hasPrisma: false,
            recommendedChecks: [],
            summary: `Project root not found: ${projectRoot}`,
        };
    }
    // Get project name
    let projectName;
    try {
        const pkg = JSON.parse(readFileSync(join(absoluteRoot, "package.json"), "utf-8"));
        projectName = pkg.name;
    }
    catch { }
    // Detect frameworks and auth
    const frameworks = await detectFrameworks(absoluteRoot);
    const authLibraries = await detectAuthLibraries(absoluteRoot);
    // Check for TypeScript
    const hasTypeScript = existsSync(join(absoluteRoot, "tsconfig.json"));
    // Check for monorepo
    const hasMonorepo = existsSync(join(absoluteRoot, "pnpm-workspace.yaml")) ||
        existsSync(join(absoluteRoot, "lerna.json")) ||
        existsSync(join(absoluteRoot, "nx.json"));
    // Check for Prisma
    const hasPrisma = existsSync(join(absoluteRoot, "prisma/schema.prisma")) ||
        existsSync(join(absoluteRoot, "prisma.config.ts"));
    // Generate recommended checks
    const recommendedChecks = generateRecommendedChecks(frameworks, authLibraries, hasTypeScript, hasMonorepo, hasPrisma);
    // Build summary
    const frameworkNames = frameworks.map(f => f.name).join(", ") || "None detected";
    const authNames = authLibraries.map(a => a.name).join(", ") || "None detected";
    const requiredChecks = recommendedChecks.filter(c => c.priority === "required" && c.recommended);
    const summary = `Detected: ${frameworkNames}${authLibraries.length > 0 ? ` + ${authNames}` : ""}. ` +
        `Recommended ${requiredChecks.length} required checks.`;
    // Generate quick command
    const checkNames = requiredChecks.map(c => c.name);
    const quickCommand = `pre_deploy_audit with checks: [${checkNames.map(c => `"${c}"`).join(", ")}]`;
    return {
        status: "success",
        projectRoot: absoluteRoot,
        projectName,
        frameworks,
        authLibraries,
        hasTypeScript,
        hasMonorepo,
        hasPrisma,
        recommendedChecks,
        summary,
        quickCommand,
    };
}
//# sourceMappingURL=analyze_project_checks.js.map
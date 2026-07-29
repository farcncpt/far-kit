import { z } from "zod";
import { resolve, relative } from "path";
import { existsSync, readFileSync } from "fs";
import { glob } from "glob";
// Schema for the tool
export const suspenseBoundaryCheckSchema = z.object({
    projectRoot: z.string().describe("Path to the project root directory"),
    verbose: z.boolean().default(false).describe("Include detailed detection info"),
});
// Known hooks that require Suspense boundaries during SSR
const SSR_BAILOUT_HOOKS = {
    // Stack Auth
    "@stackframe/stack": ["useUser", "useAuth", "useStackApp"],
    // Clerk
    "@clerk/nextjs": ["useUser", "useAuth", "useClerk", "useSession"],
    // Supabase
    "@supabase/auth-helpers-react": ["useUser", "useSession", "useSessionContext"],
    // Firebase
    "react-firebase-hooks/auth": ["useAuthState", "useIdToken"],
    // Generic patterns (custom hooks that might call these)
    "custom": ["useAuth", "useUser", "useSession", "useCurrentUser"],
};
// Parse imports from a file to identify which auth libraries are used
function parseImports(content) {
    const importMap = new Map();
    // Match: import { useUser } from "@stackframe/stack"
    // Match: import { useUser as myUser } from "@stackframe/stack"
    const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        const imports = match[1];
        const source = match[2];
        // Parse individual imports
        const importItems = imports.split(",").map(s => s.trim());
        for (const item of importItems) {
            // Handle "useUser as myUser" -> store as "useUser"
            const hookName = item.split(/\s+as\s+/)[0].trim();
            if (hookName) {
                importMap.set(hookName, source);
            }
        }
    }
    return importMap;
}
// Check if a file has a Suspense boundary wrapping the problematic hooks
function hasSuspenseBoundary(content) {
    // Simple heuristic: check if Suspense is imported and used
    const hasSuspenseImport = /import\s*\{[^}]*Suspense[^}]*\}\s*from\s*['"]react['"]/.test(content);
    const hasSuspenseJSX = /<Suspense[^>]*>/.test(content);
    return hasSuspenseImport && hasSuspenseJSX;
}
// Check if this is a server component (no "use client" directive)
function isServerComponent(content) {
    // Check first few lines for "use client"
    const firstLines = content.slice(0, 500);
    return !firstLines.includes("'use client'") && !firstLines.includes('"use client"');
}
// Check if the layout properly wraps client components in Suspense
function checkLayoutStructure(content, filePath) {
    const issues = [];
    const imports = parseImports(content);
    // Find all hook usages
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        // Check each known SSR bailout hook
        for (const [source, hooks] of Object.entries(SSR_BAILOUT_HOOKS)) {
            for (const hook of hooks) {
                // Check if this hook is used (as a function call)
                const hookUsageRegex = new RegExp(`\\b${hook}\\s*\\(`);
                if (hookUsageRegex.test(line)) {
                    // Check if this hook was imported from a known source
                    const importSource = imports.get(hook);
                    // If imported from known source, or matches custom pattern
                    if (importSource || source === "custom") {
                        const actualSource = importSource || "custom hook";
                        // Check if file has Suspense boundary
                        if (!hasSuspenseBoundary(content)) {
                            // This is a 'use client' layout using auth hooks without Suspense
                            if (!isServerComponent(content)) {
                                issues.push({
                                    file: filePath,
                                    line: lineNum,
                                    hook,
                                    source: actualSource,
                                    severity: "error",
                                    message: `Layout uses ${hook}() without Suspense boundary - will fail during static generation`,
                                    suggestion: `Split into server layout + client shell wrapped in <Suspense>`,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    return issues;
}
// Main check function
export async function suspenseBoundaryCheck(params) {
    const { projectRoot, verbose } = params;
    const absoluteRoot = resolve(projectRoot);
    // Validate project root
    if (!existsSync(absoluteRoot)) {
        return {
            status: "error",
            projectRoot: absoluteRoot,
            issues: [],
            layoutsChecked: 0,
            summary: `Project root not found: ${projectRoot}`,
        };
    }
    // Find all layout files in app directory (Next.js App Router)
    const layoutPatterns = [
        `${absoluteRoot}/src/app/**/layout.tsx`,
        `${absoluteRoot}/src/app/**/layout.ts`,
        `${absoluteRoot}/app/**/layout.tsx`,
        `${absoluteRoot}/app/**/layout.ts`,
    ];
    const layoutFiles = [];
    for (const pattern of layoutPatterns) {
        const matches = await glob(pattern, {
            ignore: ["**/node_modules/**", "**/.next/**"],
        });
        layoutFiles.push(...matches);
    }
    if (layoutFiles.length === 0) {
        return {
            status: "pass",
            projectRoot: absoluteRoot,
            issues: [],
            layoutsChecked: 0,
            summary: "No Next.js App Router layouts found - check skipped",
        };
    }
    const allIssues = [];
    for (const layoutFile of layoutFiles) {
        try {
            const content = readFileSync(layoutFile, "utf-8");
            const relativePath = relative(absoluteRoot, layoutFile);
            const issues = checkLayoutStructure(content, relativePath);
            allIssues.push(...issues);
        }
        catch (err) {
            // Skip unreadable files
        }
    }
    const status = allIssues.length > 0 ? "fail" : "pass";
    let recommendation;
    if (allIssues.length > 0) {
        recommendation = `
Fix pattern for layout with auth hooks:

1. Create a client component (e.g., AdminShell.tsx) with the auth logic:
   'use client';
   export function AdminShell({ children }) {
     const { user } = useAuth();
     // ... your layout UI
   }

2. Make layout.tsx a server component that wraps in Suspense:
   import { Suspense } from 'react';
   import { AdminShell } from './AdminShell';

   export default function Layout({ children }) {
     return (
       <Suspense fallback={<LoadingUI />}>
         <AdminShell>{children}</AdminShell>
       </Suspense>
     );
   }
`;
    }
    return {
        status,
        projectRoot: absoluteRoot,
        issues: allIssues,
        layoutsChecked: layoutFiles.length,
        summary: allIssues.length > 0
            ? `Found ${allIssues.length} Suspense boundary issues in ${layoutFiles.length} layouts`
            : `All ${layoutFiles.length} layouts passed Suspense boundary check`,
        recommendation,
    };
}
//# sourceMappingURL=suspense_boundary_check.js.map
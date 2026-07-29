#!/usr/bin/env node
import { resolve } from "path";
import { existsSync } from "fs";
import { analyzeProjectChecks } from "./tools/analyze_project_checks.js";
import { validateTypeScript } from "./tools/validate_typescript.js";
import { preDeployAudit } from "./tools/pre_deploy_audit.js";
import { suspenseBoundaryCheck } from "./tools/suspense_boundary_check.js";
import { inspectServerLogs } from "./tools/inspect_server_logs.js";
// ─── Helpers ──────────────────────────────────────────────────────────────────
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
function header(text) {
    console.log(`\n${BOLD}${CYAN}═══ ${text} ═══${RESET}\n`);
}
function pass(text) {
    console.log(`  ${GREEN}✔${RESET} ${text}`);
}
function fail(text) {
    console.log(`  ${RED}✘${RESET} ${text}`);
}
function warn(text) {
    console.log(`  ${YELLOW}⚠${RESET} ${text}`);
}
function info(text) {
    console.log(`  ${DIM}${text}${RESET}`);
}
function printJson(data) {
    console.log(JSON.stringify(data, null, 2));
}
function usage() {
    console.log(`
${BOLD}internal-code${RESET} - Static analysis CLI for TypeScript projects

${BOLD}Usage:${RESET}
  internal-code <command> <project-path> [options]

${BOLD}Commands:${RESET}
  scan        Run all validators and print a summary report
  analyze     Detect project stack and recommend checks
  audit       Run pre-deploy audit (typescript-ci, imports, circular, env, suspense)
  typescript  Validate TypeScript compilation
  suspense    Check Suspense boundaries in Next.js layouts
  functions   Validate function behavior (requires extra args)
  logs        Inspect server log file

${BOLD}Options:${RESET}
  --verbose   Include detailed output
  --json      Output raw JSON instead of formatted text

${BOLD}Examples:${RESET}
  internal-code scan ./my-project
  internal-code typescript ./my-project
  internal-code audit ./my-project --verbose
  internal-code logs /var/log/app.log --filter error
`);
    process.exit(1);
}
// ─── Command Handlers ─────────────────────────────────────────────────────────
async function cmdAnalyze(projectRoot, verbose, json) {
    header("Project Analysis");
    const result = await analyzeProjectChecks({ projectRoot, verbose });
    if (json) {
        printJson(result);
        return result;
    }
    if (result.status === "error") {
        fail(result.summary);
        return result;
    }
    console.log(`  Project: ${BOLD}${result.projectName || "unknown"}${RESET}`);
    console.log(`  Root:    ${result.projectRoot}`);
    console.log();
    if (result.frameworks.length > 0) {
        console.log(`  ${BOLD}Frameworks:${RESET}`);
        for (const fw of result.frameworks) {
            console.log(`    - ${fw.name} ${fw.version || ""} ${DIM}[${fw.patterns.join(", ")}]${RESET}`);
        }
    }
    if (result.authLibraries.length > 0) {
        console.log(`  ${BOLD}Auth Libraries:${RESET}`);
        for (const auth of result.authLibraries) {
            const bailout = auth.hasSSRBailout ? `${YELLOW}(SSR bailout)${RESET}` : "";
            console.log(`    - ${auth.name} ${bailout} hooks: ${auth.hooks.join(", ")}`);
        }
    }
    console.log();
    console.log(`  TypeScript: ${result.hasTypeScript ? GREEN + "yes" + RESET : "no"}`);
    console.log(`  Monorepo:   ${result.hasMonorepo ? "yes" : "no"}`);
    console.log(`  Prisma:     ${result.hasPrisma ? "yes" : "no"}`);
    console.log();
    if (result.recommendedChecks.length > 0) {
        console.log(`  ${BOLD}Recommended Checks:${RESET}`);
        for (const check of result.recommendedChecks) {
            const icon = check.priority === "required" ? RED + "●" + RESET
                : check.priority === "recommended" ? YELLOW + "●" + RESET
                    : DIM + "○" + RESET;
            const rec = check.recommended ? "" : DIM + " (optional)" + RESET;
            console.log(`    ${icon} ${check.name}${rec} - ${check.reason} ${DIM}~${check.estimatedTime || "?"}${RESET}`);
        }
    }
    console.log();
    info(result.summary);
    if (result.quickCommand) {
        info(`Quick: ${result.quickCommand}`);
    }
    return result;
}
async function cmdTypeScript(projectRoot, verbose, json) {
    header("TypeScript Validation");
    const result = await validateTypeScript({
        projectRoot,
        fix: false,
        timeout: 120000,
        simulateCI: false,
        regenerate: false,
    });
    if (json) {
        printJson(result);
        return result;
    }
    if (result.status === "error" && result.message) {
        fail(result.message);
        return result;
    }
    const summary = result.summary;
    if (summary) {
        if (summary.errors === 0) {
            pass(`TypeScript compilation passed (${result.duration})`);
        }
        else {
            fail(`${summary.errors} errors, ${summary.warnings} warnings (${result.duration})`);
        }
        if (summary.byCategory && Object.keys(summary.byCategory).length > 0) {
            console.log();
            console.log(`  ${BOLD}Errors by category:${RESET}`);
            for (const [cat, count] of Object.entries(summary.byCategory)) {
                console.log(`    ${cat}: ${count}`);
            }
        }
        if (summary.byFile && Object.keys(summary.byFile).length > 0) {
            console.log();
            console.log(`  ${BOLD}Errors by file:${RESET}`);
            const files = Object.entries(summary.byFile).sort((a, b) => b[1] - a[1]);
            const limit = verbose ? files.length : Math.min(files.length, 15);
            for (let i = 0; i < limit; i++) {
                const [file, count] = files[i];
                console.log(`    ${count} ${DIM}${file}${RESET}`);
            }
            if (!verbose && files.length > 15) {
                info(`  ... and ${files.length - 15} more files`);
            }
        }
        const errors = result.errors;
        if (errors && errors.length > 0 && verbose) {
            console.log();
            console.log(`  ${BOLD}Errors (first ${Math.min(errors.length, 50)}):${RESET}`);
            for (const err of errors.slice(0, 50)) {
                console.log(`    ${RED}${err.code}${RESET} ${err.file}:${err.line}:${err.column}`);
                console.log(`      ${err.message}`);
                if (err.suggestedFix) {
                    console.log(`      ${YELLOW}Fix: ${err.suggestedFix.description}${RESET}`);
                }
            }
        }
    }
    console.log();
    info(result.hint || "");
    return result;
}
async function cmdAudit(projectRoot, verbose, json) {
    header("Pre-Deploy Audit");
    const checks = ["typescript-ci", "imports", "circular", "env", "suspense-boundaries"];
    const result = await preDeployAudit({
        projectRoot,
        checks,
        timeout: 300000,
        failFast: false,
        parallel: false,
        verbose,
    });
    if (json) {
        printJson(result);
        return result;
    }
    console.log(`  Status: ${result.status === "pass" ? GREEN + "PASS" + RESET : RED + "FAIL" + RESET}`);
    console.log(`  Duration: ${(result.totalDuration / 1000).toFixed(1)}s`);
    console.log();
    for (const check of result.checks) {
        const icon = check.status === "pass" ? `${GREEN}✔${RESET}`
            : check.status === "fail" ? `${RED}✘${RESET}`
                : check.status === "warn" ? `${YELLOW}⚠${RESET}`
                    : `${DIM}○${RESET}`;
        const dur = `${DIM}(${(check.duration / 1000).toFixed(1)}s)${RESET}`;
        console.log(`  ${icon} ${BOLD}${check.name}${RESET} ${dur} - ${check.summary}`);
        if (check.errors && check.errors.length > 0) {
            const limit = verbose ? check.errors.length : Math.min(check.errors.length, 5);
            for (let i = 0; i < limit; i++) {
                const err = check.errors[i];
                if (err.file) {
                    console.log(`      ${DIM}${err.file}${err.line ? ":" + err.line : ""}: ${err.message || ""}${RESET}`);
                }
                else if (err.chain) {
                    console.log(`      ${DIM}${err.chain}${RESET}`);
                }
                else if (err.import) {
                    console.log(`      ${DIM}${err.file}: unresolved ${err.import}${RESET}`);
                }
                else {
                    console.log(`      ${DIM}${JSON.stringify(err)}${RESET}`);
                }
            }
            if (!verbose && check.errors.length > 5) {
                info(`      ... and ${check.errors.length - 5} more`);
            }
        }
    }
    console.log();
    console.log(`  ${BOLD}Summary:${RESET} ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.warnings} warnings, ${result.summary.skipped} skipped`);
    console.log(`  Total errors: ${result.summary.totalErrors}, Total warnings: ${result.summary.totalWarnings}`);
    if (result.criticalIssues.length > 0) {
        console.log();
        console.log(`  ${BOLD}${RED}Critical Issues:${RESET}`);
        for (const issue of result.criticalIssues) {
            fail(issue);
        }
    }
    if (result.recommendations.length > 0) {
        console.log();
        console.log(`  ${BOLD}Recommendations:${RESET}`);
        for (const rec of result.recommendations) {
            warn(rec);
        }
    }
    console.log();
    info(result.hint);
    return result;
}
async function cmdSuspense(projectRoot, verbose, json) {
    header("Suspense Boundary Check");
    const result = await suspenseBoundaryCheck({ projectRoot, verbose });
    if (json) {
        printJson(result);
        return result;
    }
    if (result.status === "error") {
        fail(result.summary);
        return result;
    }
    console.log(`  Layouts checked: ${result.layoutsChecked}`);
    if (result.issues.length === 0) {
        pass(result.summary);
    }
    else {
        fail(result.summary);
        console.log();
        for (const issue of result.issues) {
            console.log(`    ${RED}${issue.severity}${RESET} ${issue.file}:${issue.line}`);
            console.log(`      ${issue.message}`);
            console.log(`      ${YELLOW}${issue.suggestion}${RESET}`);
        }
    }
    if (result.recommendation) {
        console.log();
        console.log(`  ${BOLD}Recommendation:${RESET}`);
        console.log(result.recommendation);
    }
    return result;
}
async function cmdLogs(logPath, verbose, json, filter) {
    header("Server Log Inspection");
    const result = await inspectServerLogs({
        logFilePath: logPath,
        lines: verbose ? 200 : 50,
        filter,
    });
    if (json) {
        printJson(result);
        return result;
    }
    if (result.status === "error") {
        fail(result.message);
        return result;
    }
    console.log(`  ${result.summary}`);
    console.log();
    const logs = result.logs || [];
    for (const line of logs) {
        if (line.trim()) {
            console.log(`  ${line}`);
        }
    }
    return result;
}
async function cmdScan(projectRoot, verbose, json) {
    header("Full Project Scan");
    console.log(`  Target: ${resolve(projectRoot)}`);
    console.log();
    const results = {};
    // Step 1: Analyze project
    console.log(`${BOLD}[1/4] Analyzing project structure...${RESET}`);
    results.analyze = await cmdAnalyze(projectRoot, verbose, false);
    // Step 2: TypeScript validation
    console.log(`\n${BOLD}[2/4] Validating TypeScript...${RESET}`);
    results.typescript = await cmdTypeScript(projectRoot, verbose, false);
    // Step 3: Suspense boundary check
    console.log(`\n${BOLD}[3/4] Checking Suspense boundaries...${RESET}`);
    results.suspense = await cmdSuspense(projectRoot, verbose, false);
    // Step 4: Pre-deploy audit
    console.log(`\n${BOLD}[4/4] Running pre-deploy audit...${RESET}`);
    results.audit = await cmdAudit(projectRoot, verbose, false);
    // Summary
    header("Scan Summary");
    const analyzeStatus = results.analyze?.status === "success" ? "pass" : results.analyze?.status || "error";
    const tsStatus = results.typescript?.summary?.errors === 0 ? "pass" : "fail";
    const suspenseStatus = results.suspense?.status || "error";
    const auditStatus = results.audit?.status || "error";
    const statusIcon = (s) => s === "pass" ? `${GREEN}PASS${RESET}` : s === "fail" ? `${RED}FAIL${RESET}` : `${YELLOW}${s.toUpperCase()}${RESET}`;
    console.log(`  analyze:    ${statusIcon(analyzeStatus)}`);
    console.log(`  typescript: ${statusIcon(tsStatus)}`);
    console.log(`  suspense:   ${statusIcon(suspenseStatus)}`);
    console.log(`  audit:      ${statusIcon(auditStatus)}`);
    const allPassed = analyzeStatus === "pass" && tsStatus === "pass" && suspenseStatus === "pass" && auditStatus === "pass";
    console.log();
    console.log(`  ${BOLD}Overall: ${allPassed ? GREEN + "ALL PASSED" : RED + "ISSUES FOUND"}${RESET}`);
    if (json) {
        console.log();
        printJson(results);
    }
    return results;
}
// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        usage();
    }
    const command = args[0];
    const targetPath = args[1];
    const verbose = args.includes("--verbose");
    const json = args.includes("--json");
    const filterIdx = args.indexOf("--filter");
    const filter = filterIdx !== -1 ? args[filterIdx + 1] : undefined;
    if (!targetPath) {
        console.error(`${RED}Error: Missing target path${RESET}`);
        usage();
    }
    const absolutePath = resolve(targetPath);
    // For logs command, path is a file, not a directory
    if (command === "logs") {
        await cmdLogs(absolutePath, verbose, json, filter);
        return;
    }
    // For functions command, we need more args - provide help
    if (command === "functions") {
        console.log(`
${BOLD}functions${RESET} command requires additional arguments and is best used via the MCP tool.
Use the MCP server's validate_function_behavior tool to test specific functions.

Alternatively, use the 'scan' command for a full project analysis.
`);
        return;
    }
    // Validate project path exists
    if (!existsSync(absolutePath)) {
        console.error(`${RED}Error: Path does not exist: ${absolutePath}${RESET}`);
        process.exit(1);
    }
    try {
        switch (command) {
            case "scan":
                await cmdScan(absolutePath, verbose, json);
                break;
            case "analyze":
                await cmdAnalyze(absolutePath, verbose, json);
                break;
            case "typescript":
                await cmdTypeScript(absolutePath, verbose, json);
                break;
            case "audit":
                await cmdAudit(absolutePath, verbose, json);
                break;
            case "suspense":
                await cmdSuspense(absolutePath, verbose, json);
                break;
            default:
                console.error(`${RED}Unknown command: ${command}${RESET}`);
                usage();
        }
    }
    catch (error) {
        console.error(`${RED}Error: ${error instanceof Error ? error.message : String(error)}${RESET}`);
        process.exit(1);
    }
}
main().catch((err) => {
    console.error(`${RED}Fatal error: ${err.message || err}${RESET}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map
#!/usr/bin/env node
/**
 * code-audit.mjs — Standalone code audit tool wrapping Truth-Seeker CLI & MCP servers.
 *
 * Runs import validation, dead code detection, dependency graph analysis,
 * environment variable validation, architecture analysis, and type checking.
 *
 * Uses Truth-Seeker Rust CLI if available, falls back to MCP server tools via Node.js.
 *
 * Usage:
 *   node cli/code-audit.mjs /path/to/project                    # full code audit
 *   node cli/code-audit.mjs /path/to/project --imports           # imports only
 *   node cli/code-audit.mjs /path/to/project --env               # env vars only
 *   node cli/code-audit.mjs /path/to/project --dead-code         # unused exports
 *   node cli/code-audit.mjs /path/to/project --deps              # dependency graph
 *   node cli/code-audit.mjs /path/to/project --arch              # architecture
 *   node cli/code-audit.mjs /path/to/project --typecheck         # type checking
 *   node cli/code-audit.mjs /path/to/project --output report.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs"
import { join, resolve, dirname, basename } from "path"
import { exec as execCb } from "child_process"
import { promisify } from "util"
import { fileURLToPath } from "url"

const execAsync = promisify(execCb)
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TRUTH_SEEKER_DIR = "C:\\Users\\bubun\\CascadeProjects\\Truth-Seeker"
const TRUTH_SEEKER_BIN = join(TRUTH_SEEKER_DIR, "rust", "target", "release", "truth-seeker.exe")

const MCP_SERVERS = {
  internalCode: join(TRUTH_SEEKER_DIR, "internal-code-mcp", "dist", "index-internal-code.js"),
  codeComprehension: join(TRUTH_SEEKER_DIR, "code-comprehension-mcp", "dist", "index.js"),
  truthSeeker: join(TRUTH_SEEKER_DIR, "truth-seeker-mcp", "dist", "index.js"),
  securityAudit: join(TRUTH_SEEKER_DIR, "security-audit-mcp", "dist", "index.js"),
  refactorImports: join(TRUTH_SEEKER_DIR, "refactor-imports-mcp", "dist", "index.js"),
}

// ─── Argument parsing ───

const rawArgs = process.argv.slice(2)
const projectDir = rawArgs.find((a) => !a.startsWith("--")) || process.cwd()
const resolvedProject = resolve(projectDir)

function hasFlag(name) {
  return rawArgs.includes(name)
}

function flagValue(name, fallback) {
  const idx = rawArgs.indexOf(name)
  if (idx !== -1 && rawArgs[idx + 1] && !rawArgs[idx + 1].startsWith("--")) return rawArgs[idx + 1]
  return fallback
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`
Code Audit — Truth-Seeker integration for Field Trip

Usage:
  node cli/code-audit.mjs /path/to/project [flags]

Flags:
  --imports       Validate all imports resolve correctly
  --env           Check environment variable drift
  --dead-code     Find unused exports
  --deps          Analyze dependency graph (circular deps)
  --arch          Analyze project architecture
  --typecheck     Run TypeScript type checker
  --output <path> Save JSON report to file (use "-" for stdout JSON)
  -h, --help      Show this help

Without flags, runs all checks.
`)
  process.exit(0)
}

const runImports = hasFlag("--imports")
const runEnv = hasFlag("--env")
const runDeadCode = hasFlag("--dead-code")
const runDeps = hasFlag("--deps")
const runArch = hasFlag("--arch")
const runTypecheck = hasFlag("--typecheck")
const runAll = !runImports && !runEnv && !runDeadCode && !runDeps && !runArch && !runTypecheck
const outputPath = flagValue("--output", null)

// ─── Severity / scoring ───

const SEVERITY_DEDUCTIONS = { critical: 15, high: 8, medium: 4, low: 2 }

function calculateScore(issues) {
  let score = 100
  for (const issue of issues) {
    score -= SEVERITY_DEDUCTIONS[issue.severity] || 2
  }
  return Math.max(0, score)
}

// ─── CLI detection ───

function hasTruthSeekerBinary() {
  if (existsSync(TRUTH_SEEKER_BIN)) return TRUTH_SEEKER_BIN
  try {
    execCb("truth-seeker --version", { stdio: "pipe" })
    return "truth-seeker"
  } catch {}
  return null
}

// ─── Run a CLI command and parse JSON output ───

async function runCliCommand(label, cmd) {
  process.stdout.write(`  ${label}...`)
  try {
    const { stdout } = await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 })
    try {
      const result = JSON.parse(stdout)
      const issues = extractIssues(label, result)
      console.log(issues.length > 0 ? ` ${issues.length} issue(s)` : " OK")
      return { result, issues }
    } catch {
      // Not JSON — treat as text output
      console.log(" OK (text output)")
      return { result: { raw: stdout.trim() }, issues: [] }
    }
  } catch (err) {
    if (err.stdout) {
      try {
        const result = JSON.parse(err.stdout)
        const issues = extractIssues(label, result)
        console.log(issues.length > 0 ? ` ${issues.length} issue(s)` : " OK")
        return { result, issues }
      } catch {}
    }
    console.log(` ERROR: ${(err.message || "").slice(0, 80)}`)
    return { result: null, issues: [] }
  }
}

function extractIssues(label, result) {
  const issues = []
  if (!result) return issues

  // Handle various JSON result shapes
  if (result.errors?.length > 0) {
    for (const err of result.errors) {
      issues.push({
        severity: err.severity || "high",
        category: `Code: ${label}`,
        message: err.message || err.path || String(err),
        fix: err.fix || err.suggestion || "",
        file: err.file || err.path || "",
      })
    }
  }
  if (result.warnings?.length > 0) {
    for (const warn of result.warnings) {
      issues.push({
        severity: warn.severity || "medium",
        category: `Code: ${label}`,
        message: warn.message || warn.path || String(warn),
        fix: warn.fix || warn.suggestion || "",
        file: warn.file || warn.path || "",
      })
    }
  }
  // Handle import validation shape
  if (result.unresolved?.length > 0) {
    for (const item of result.unresolved) {
      issues.push({
        severity: "high",
        category: `Code: ${label}`,
        message: `Unresolved import: ${item.specifier || item.path || item}`,
        fix: item.suggestion || "Check the import path and ensure the module exists",
        file: item.file || "",
      })
    }
  }
  // Handle unused exports shape
  if (result.unused?.length > 0) {
    for (const item of result.unused) {
      issues.push({
        severity: "low",
        category: `Code: ${label}`,
        message: `Unused export: ${item.name || item.symbol || item}`,
        fix: "Remove unused export or add consumers",
        file: item.file || "",
      })
    }
  }
  // Handle circular deps
  if (result.circular?.length > 0) {
    for (const cycle of result.circular) {
      const chain = Array.isArray(cycle) ? cycle.join(" -> ") : String(cycle)
      issues.push({
        severity: "medium",
        category: `Code: ${label}`,
        message: `Circular dependency: ${chain}`,
        fix: "Break the cycle by extracting shared code into a separate module",
      })
    }
  }
  // Handle env drift
  if (result.missing_in_env?.length > 0) {
    for (const v of result.missing_in_env) {
      issues.push({
        severity: "high",
        category: `Code: ${label}`,
        message: `Env variable used in code but missing from .env: ${v.name || v}`,
        fix: `Add ${v.name || v} to your .env file`,
      })
    }
  }
  if (result.unused_in_env?.length > 0) {
    for (const v of result.unused_in_env) {
      issues.push({
        severity: "low",
        category: `Code: ${label}`,
        message: `Env variable in .env but unused in code: ${v.name || v}`,
        fix: `Remove ${v.name || v} from .env if no longer needed`,
      })
    }
  }
  // Handle type errors
  if (result.type_errors?.length > 0) {
    for (const te of result.type_errors) {
      issues.push({
        severity: "high",
        category: `Code: ${label}`,
        message: te.message || String(te),
        fix: te.fix || "Fix the type error",
        file: te.file || "",
      })
    }
  }
  // Generic status: error
  if (result.status === "error" && issues.length === 0) {
    issues.push({
      severity: "high",
      category: `Code: ${label}`,
      message: result.summary || result.message || "Check failed",
      fix: result.hint || "",
    })
  }
  return issues
}

// ─── Find source files for import checking ───

function findEntryFiles(dir) {
  const candidates = [
    "src/app/layout.tsx", "src/app/layout.ts", "src/app/page.tsx", "src/app/page.ts",
    "src/index.tsx", "src/index.ts", "src/main.tsx", "src/main.ts",
    "app/layout.tsx", "app/layout.ts", "app/page.tsx", "app/page.ts",
    "pages/index.tsx", "pages/index.ts", "pages/_app.tsx", "pages/_app.ts",
    "index.ts", "index.tsx",
  ]
  for (const c of candidates) {
    const full = join(dir, c)
    if (existsSync(full)) return full
  }
  return null
}

// ─── MCP Fallback: run a tool by spawning MCP server as subprocess ───
// We use a simple approach: write a small script that imports the MCP tool directly

async function runMcpFallback(label, serverPath, toolName, args) {
  if (!existsSync(serverPath)) {
    process.stdout.write(`  ${label}...`)
    console.log(" SKIP (MCP server not built)")
    return { result: null, issues: [] }
  }

  // For MCP fallback, we use the CLI wrappers from internal-code-mcp and others if they exist
  const serverDir = dirname(dirname(serverPath))
  const cliPath = join(serverDir, "src", "cli.ts")

  if (existsSync(cliPath)) {
    // Some MCP servers have a CLI
    return runCliCommand(label, `npx tsx "${cliPath}" ${toolName} ${JSON.stringify(args)}`)
  }

  // If no CLI, skip gracefully
  process.stdout.write(`  ${label}...`)
  console.log(" SKIP (no CLI available, use Rust binary or build MCP)")
  return { result: null, issues: [] }
}

// ─── Main ───

async function main() {
  const startTime = Date.now()

  console.log(`\n  Code Audit — Truth-Seeker`)
  console.log(`  =========================`)
  console.log(`  Project: ${resolvedProject}\n`)

  const binary = hasTruthSeekerBinary()
  const mode = binary ? "Rust CLI" : "MCP fallback"
  console.log(`  Mode: ${mode}${binary ? ` (${binary})` : ""}\n`)

  const allIssues = []
  const details = {}

  // ─── Import Validation ───
  if (runAll || runImports) {
    if (binary) {
      const entry = findEntryFiles(resolvedProject)
      if (entry) {
        const bin = (typeof binary === "string" && binary.includes("\\")) ? binary.replace(/\\/g, "/") : binary
        const { result, issues } = await runCliCommand("Import Validation",
          `"${bin}" check-imports "${entry}" --json --recursive --project "${resolvedProject}"`)
        allIssues.push(...issues)
        details.imports = { result, issues }
      } else {
        process.stdout.write("  Import Validation...")
        console.log(" SKIP (no entry file found)")
        details.imports = { result: null, issues: [] }
      }
    } else {
      const { result, issues } = await runMcpFallback("Import Validation",
        MCP_SERVERS.internalCode, "validate_import_tree", { directory: resolvedProject })
      allIssues.push(...issues)
      details.imports = { result, issues }
    }
  }

  // ─── Dead Code Detection ───
  if (runAll || runDeadCode) {
    if (binary) {
      // Rust CLI doesn't have find_unused_exports yet — use architecture for now
      process.stdout.write("  Dead Code Detection...")
      console.log(" SKIP (use --deps for dependency analysis)")
      details.deadCode = { result: null, issues: [] }
    } else {
      const { result, issues } = await runMcpFallback("Dead Code Detection",
        MCP_SERVERS.internalCode, "find_unused_exports", { directory: resolvedProject })
      allIssues.push(...issues)
      details.deadCode = { result, issues }
    }
  }

  // ─── Dependency Graph ───
  if (runAll || runDeps) {
    if (binary) {
      // Rust CLI doesn't have circular dep detection built in — try architecture
      process.stdout.write("  Dependency Graph...")
      console.log(" SKIP (circular dep detection via MCP only)")
      details.deps = { result: null, issues: [] }
    } else {
      const { result, issues } = await runMcpFallback("Dependency Graph",
        MCP_SERVERS.internalCode, "analyze_dependency_graph", { projectRoot: resolvedProject })
      allIssues.push(...issues)
      details.deps = { result, issues }
    }
  }

  // ─── Environment Variable Validation ───
  if (runAll || runEnv) {
    if (binary) {
      const bin = (typeof binary === "string" && binary.includes("\\")) ? binary.replace(/\\/g, "/") : binary
      const { result, issues } = await runCliCommand("Env Variable Drift",
        `"${bin}" env-check "${resolvedProject}" --json`)
      allIssues.push(...issues)
      details.env = { result, issues }
    } else {
      const { result, issues } = await runMcpFallback("Env Variable Drift",
        MCP_SERVERS.truthSeeker, "validate_env_variables", { projectRoot: resolvedProject })
      allIssues.push(...issues)
      details.env = { result, issues }
    }
  }

  // ─── Architecture Analysis ───
  if (runAll || runArch) {
    if (binary) {
      const bin = (typeof binary === "string" && binary.includes("\\")) ? binary.replace(/\\/g, "/") : binary
      const { result, issues } = await runCliCommand("Architecture Analysis",
        `"${bin}" architecture "${resolvedProject}" --json`)
      allIssues.push(...issues)
      details.architecture = { result, issues }
    } else {
      const { result, issues } = await runMcpFallback("Architecture Analysis",
        MCP_SERVERS.codeComprehension, "analyze_project_architecture", { projectRoot: resolvedProject })
      allIssues.push(...issues)
      details.architecture = { result, issues }
    }
  }

  // ─── Type Checking ───
  if (runAll || runTypecheck) {
    if (existsSync(join(resolvedProject, "tsconfig.json"))) {
      if (binary) {
        const bin = (typeof binary === "string" && binary.includes("\\")) ? binary.replace(/\\/g, "/") : binary
        const { result, issues } = await runCliCommand("Type Checking",
          `"${bin}" typecheck "${resolvedProject}" --json`)
        allIssues.push(...issues)
        details.typecheck = { result, issues }
      } else {
        // Fallback: run tsc directly
        const { result, issues } = await runCliCommand("Type Checking",
          `npx tsc --noEmit --pretty false -p "${resolvedProject}/tsconfig.json" 2>&1 || true`)
        // Parse tsc text output for errors
        if (result?.raw) {
          const lines = result.raw.split("\n").filter((l) => l.includes("error TS"))
          for (const line of lines.slice(0, 20)) {
            allIssues.push({
              severity: "high",
              category: "Code: Type Checking",
              message: line.trim(),
              fix: "Fix the TypeScript type error",
            })
          }
          details.typecheck = { result, issues: allIssues.filter((i) => i.category === "Code: Type Checking") }
        } else {
          details.typecheck = { result, issues }
        }
      }
    } else {
      process.stdout.write("  Type Checking...")
      console.log(" SKIP (no tsconfig.json)")
      details.typecheck = { result: null, issues: [] }
    }
  }

  // ─── Summary ───

  const score = calculateScore(allIssues)
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const issue of allIssues) {
    counts[issue.severity] = (counts[issue.severity] || 0) + 1
  }

  console.log()
  console.log(`  ─── Code Audit Summary ───`)
  console.log(`  Score: ${score}/100`)
  console.log(`  Issues: ${allIssues.length} total`)
  if (counts.critical > 0) console.log(`    Critical: ${counts.critical}`)
  if (counts.high > 0) console.log(`    High: ${counts.high}`)
  if (counts.medium > 0) console.log(`    Medium: ${counts.medium}`)
  if (counts.low > 0) console.log(`    Low: ${counts.low}`)
  console.log(`  Duration: ${elapsed}s`)

  // ─── Output ───

  const report = {
    project: resolvedProject,
    mode,
    timestamp: new Date().toISOString(),
    score,
    counts,
    totalIssues: allIssues.length,
    issues: allIssues,
    details,
    durationMs: Date.now() - startTime,
  }

  if (outputPath === "-") {
    // stdout JSON mode (for piping into orchestrate)
    console.log(JSON.stringify(report))
  } else if (outputPath) {
    writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2))
    console.log(`\n  Report saved: ${resolve(outputPath)}`)
  }

  console.log()

  // Exit code
  if (counts.critical > 0) process.exit(2)
  if (counts.high > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(3)
})

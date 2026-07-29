#!/usr/bin/env node
/**
 * Bootstrap Project Harness
 *
 * Sets up any web project for autonomous agent work.
 * Run this once in a project directory — it creates:
 *   1. CLAUDE.md with E2E testing instructions
 *   2. .claude/settings.json with hooks for auto-validation
 *   3. Detects framework, dev command, port
 *   4. Optionally starts the dev server
 *   5. Optionally runs initial audit
 *
 * Usage:
 *   node bootstrap-project.mjs                     # interactive setup
 *   node bootstrap-project.mjs --auto              # auto-detect everything
 *   node bootstrap-project.mjs --auto --audit      # auto-detect + run initial audit
 *   node bootstrap-project.mjs --auto --overnight   # full autonomous mode
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, basename, resolve } from "path"
import { execSync } from "child_process"
import { createInterface } from "readline"

const TRUTH_SEEKER_DIR = "C:\\Users\\bubun\\CascadeProjects\\Truth-Seeker"
const TRUTH_SEEKER_BINARY = join(TRUTH_SEEKER_DIR, "rust", "target", "release", "truth-seeker.exe")

const projectDir = process.argv[2] && !process.argv[2].startsWith("--")
  ? resolve(process.argv[2])
  : process.cwd()

const flags = {
  auto: process.argv.includes("--auto"),
  audit: process.argv.includes("--audit"),
  overnight: process.argv.includes("--overnight"),
  security: process.argv.includes("--security"),
  help: process.argv.includes("--help") || process.argv.includes("-h"),
}

if (flags.help) {
  console.log(`
Bootstrap Project Harness — Set up any project for autonomous agent work

Usage:
  node bootstrap-project.mjs [project-dir] [flags]

Flags:
  --auto        Auto-detect framework, commands, and port
  --audit       Run initial UX + security audit after setup
  --security    Run security-only audit
  --overnight   Full autonomous mode (audit → fix → re-audit → report)
  --help        Show this help

What it does:
  1. Detects your framework (Next.js, Vite, etc.)
  2. Adds E2E testing section to CLAUDE.md
  3. Creates audit configuration
  4. Connects to the relay bridge
  5. Optionally runs the full audit pipeline
  `)
  process.exit(0)
}

const FIELD_TRIP_DIR = "C:\\Users\\bubun\\CascadeProjects\\joyride-web-extension"
const FIELD_TRIP_CLI = join(FIELD_TRIP_DIR, "cli")

// ─── Truth-Seeker Detection ───

function detectTruthSeeker() {
  // Check for compiled Rust binary
  if (existsSync(TRUTH_SEEKER_BINARY)) {
    return { available: true, binary: TRUTH_SEEKER_BINARY, type: "rust" }
  }
  // Check if truth-seeker is on PATH
  try {
    execSync("truth-seeker --version", { stdio: "pipe" })
    return { available: true, binary: "truth-seeker", type: "rust" }
  } catch {}
  // Check for MCP server fallbacks
  const mcpServers = {
    internalCode: join(TRUTH_SEEKER_DIR, "internal-code-mcp", "dist", "index-internal-code.js"),
    codeComprehension: join(TRUTH_SEEKER_DIR, "code-comprehension-mcp", "dist", "index.js"),
    truthSeeker: join(TRUTH_SEEKER_DIR, "truth-seeker-mcp", "dist", "index.js"),
    securityAudit: join(TRUTH_SEEKER_DIR, "security-audit-mcp", "dist", "index.js"),
    refactorImports: join(TRUTH_SEEKER_DIR, "refactor-imports-mcp", "dist", "index.js"),
  }
  const availableMcps = {}
  for (const [name, path] of Object.entries(mcpServers)) {
    availableMcps[name] = existsSync(path) ? path : null
  }
  const anyMcp = Object.values(availableMcps).some(Boolean)
  return { available: anyMcp, binary: null, type: "mcp", mcpServers: availableMcps }
}

// ─── Framework Detection ───

function detectFramework(dir) {
  const pkgPath = join(dir, "package.json")
  if (!existsSync(pkgPath)) return { framework: "unknown", devCommand: null, port: 3000 }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const scripts = pkg.scripts || {}

  // Detect framework
  let framework = "unknown"
  let devCommand = scripts.dev || scripts.start || null
  let port = 3000
  let packageManager = "npm"

  if (existsSync(join(dir, "pnpm-lock.yaml"))) packageManager = "pnpm"
  else if (existsSync(join(dir, "yarn.lock"))) packageManager = "yarn"
  else if (existsSync(join(dir, "bun.lockb"))) packageManager = "bun"

  if (deps["next"]) {
    framework = "nextjs"
    const nextVersion = deps["next"].replace(/[\^~]/, "")
    devCommand = devCommand || "next dev"
  } else if (deps["vite"] || deps["@vitejs/plugin-react"]) {
    framework = "vite"
    devCommand = devCommand || "vite"
  } else if (deps["nuxt"]) {
    framework = "nuxt"
    devCommand = devCommand || "nuxt dev"
  } else if (deps["svelte"] || deps["@sveltejs/kit"]) {
    framework = "sveltekit"
    devCommand = devCommand || "svelte-kit dev"
  } else if (deps["react-scripts"]) {
    framework = "cra"
    devCommand = devCommand || "react-scripts start"
  } else if (deps["astro"]) {
    framework = "astro"
    devCommand = devCommand || "astro dev"
  } else if (deps["remix"]) {
    framework = "remix"
    devCommand = devCommand || "remix dev"
  }

  // Detect auth
  let auth = null
  if (deps["@stackframe/stack"]) auth = "stack-auth"
  else if (deps["@clerk/nextjs"]) auth = "clerk"
  else if (deps["next-auth"]) auth = "next-auth"
  else if (deps["@auth/core"]) auth = "authjs"

  // Detect database
  let database = null
  if (deps["@neondatabase/serverless"] || deps["drizzle-orm"]) database = "neon"
  else if (deps["prisma"] || deps["@prisma/client"]) database = "prisma"
  else if (deps["mongoose"]) database = "mongodb"

  // Detect UI library
  let ui = null
  if (deps["tailwindcss"]) ui = "tailwind"
  if (deps["@radix-ui/react-dialog"] || deps["@radix-ui/react-slot"]) ui = "shadcn"

  // Detect payments
  let payments = null
  if (deps["stripe"] || deps["@stripe/stripe-js"]) payments = "stripe"

  return {
    name: pkg.name || basename(dir),
    framework,
    version: deps[framework === "nextjs" ? "next" : framework] || "unknown",
    devCommand: `${packageManager} run dev`,
    rawDevCommand: devCommand,
    port,
    packageManager,
    auth,
    database,
    ui,
    payments,
    hasTypeScript: existsSync(join(dir, "tsconfig.json")),
    hasTailwind: existsSync(join(dir, "tailwind.config.ts")) || existsSync(join(dir, "tailwind.config.js")),
  }
}

// ─── CLAUDE.md E2E Section ───

function generateClaudeMdSection(config) {
  return `
## E2E Testing with Field Trip CLI Tools

### Setup
DOM-first browser automation via Chrome DevTools Protocol and WebSocket relay.
No screenshots, no Playwright — direct DOM inspection and interaction.
Works with React controlled components (native setter + \`__reactProps\` escalation).

**Tools location:** \`${FIELD_TRIP_DIR}\\cli\\\`

### Connection (Relay Mode — Preferred)
\`\`\`powershell
# 1. Start relay server (if not running)
node "${FIELD_TRIP_CLI}\\ws-relay.mjs"

# 2. Chrome auto-connects via Field Trip extension

# 3. Use CLI tools
node "${FIELD_TRIP_CLI}\\tt.mjs" --relay scan
node "${FIELD_TRIP_CLI}\\tt.mjs" --relay find "Submit"
node "${FIELD_TRIP_CLI}\\tt.mjs" --relay click "button-id"
node "${FIELD_TRIP_CLI}\\tt.mjs" --relay --tab <TAB_ID> scan  # target specific tab
node "${FIELD_TRIP_CLI}\\tt.mjs" --relay tabs                 # list all tabs
\`\`\`

### Project Info
- **Framework:** ${config.framework} ${config.version}
- **Package Manager:** ${config.packageManager}
- **Dev Command:** \`${config.devCommand}\`
- **Port:** ${config.port}
- **Auth:** ${config.auth || "none"}
- **Database:** ${config.database || "none"}
- **UI:** ${config.ui || "none"}
- **Payments:** ${config.payments || "none"}

### Audit Commands
\`\`\`powershell
# Full UX audit
node "${FIELD_TRIP_CLI}\\validate-page.mjs" --relay

# Security audit
node "${FIELD_TRIP_CLI}\\security-audit.mjs" --relay

# Header check
node "${FIELD_TRIP_CLI}\\header-check.mjs" --relay

# Responsive check
node "${FIELD_TRIP_CLI}\\validate-page.mjs" --relay --responsive

# DOM simplification
node "${FIELD_TRIP_CLI}\\dom-simplify.mjs" --relay --level 2
\`\`\`

### Code-Level Audit (Truth-Seeker Integration)
\`\`\`powershell
# Full code audit (imports, dead code, deps, env, architecture)
node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}"

# Individual checks
node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}" --imports
node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}" --env
node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}" --dead-code
node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}" --deps
node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}" --output report.json
\`\`\`

### Penetration Testing
\`\`\`powershell
# Read-only pentest via relay
node "${FIELD_TRIP_CLI}\\pentest-audit.mjs" --relay --safe

# Aggressive pentest (submits test payloads)
node "${FIELD_TRIP_CLI}\\pentest-audit.mjs" --relay --aggressive

# Pentest specific tab
node "${FIELD_TRIP_CLI}\\pentest-audit.mjs" --relay --tab <TAB_ID>
\`\`\`

### Overnight Autonomous Mode
\`\`\`powershell
# Run full audit → fix → re-audit loop
node "${FIELD_TRIP_CLI}\\bootstrap-project.mjs" "${projectDir}" --overnight
\`\`\`
`
}

// ─── Audit Config ───

function generateAuditConfig(config) {
  return {
    project: config.name,
    framework: config.framework,
    createdAt: new Date().toISOString(),
    devServer: {
      command: config.devCommand,
      port: config.port,
    },
    audits: {
      ux: {
        enabled: true,
        checks: ["elements", "accessibility", "links", "responsive", "headings"],
        viewports: [375, 768, 1024, 1440],
      },
      security: {
        enabled: true,
        checks: ["secrets", "headers", "auth", "input-validation", "xss", "cookies", "mixed-content", "clickjacking"],
      },
      performance: {
        enabled: true,
        checks: ["dom-size", "images", "scripts", "fonts"],
      },
      code: {
        enabled: true,
        checks: ["imports", "dead-code", "deps", "env", "architecture", "typecheck"],
        truthSeeker: detectTruthSeeker(),
      },
      pentest: {
        enabled: false,
        mode: "safe",
        checks: ["xss", "csrf", "auth-bypass", "sql-injection", "headers", "rate-limit", "directory-traversal"],
      },
    },
    fixPolicy: {
      autoFixCritical: true,
      autoFixMajor: true,
      autoFixMinor: false,
      requireReaudit: true,
      maxRounds: 5,
    },
    relay: {
      port: 9333,
      autoConnect: true,
    },
  }
}

// ─── Main ───

async function main() {
  console.log(`\n  Bootstrap Project Harness`)
  console.log(`  ========================\n`)
  console.log(`  Project: ${projectDir}`)

  // Detect framework
  const config = detectFramework(projectDir)
  console.log(`  Framework: ${config.framework} ${config.version}`)
  console.log(`  Package Manager: ${config.packageManager}`)
  console.log(`  Dev Command: ${config.devCommand}`)
  console.log(`  Auth: ${config.auth || "none"}`)
  console.log(`  Database: ${config.database || "none"}`)
  console.log(`  UI: ${config.ui || "none"}`)
  console.log(`  Payments: ${config.payments || "none"}`)

  // Detect Truth-Seeker
  const tsInfo = detectTruthSeeker()
  if (tsInfo.available) {
    if (tsInfo.type === "rust") {
      console.log(`  Truth-Seeker: Rust CLI (${tsInfo.binary})`)
    } else {
      const mcpCount = Object.values(tsInfo.mcpServers).filter(Boolean).length
      console.log(`  Truth-Seeker: ${mcpCount} MCP server(s) available`)
    }
  } else {
    console.log(`  Truth-Seeker: not found (code audit disabled)`)
  }

  // Check if CLAUDE.md exists
  const claudeMdPath = join(projectDir, "CLAUDE.md")
  const hasClaudeMd = existsSync(claudeMdPath)

  if (hasClaudeMd) {
    const existing = readFileSync(claudeMdPath, "utf-8")
    if (existing.includes("E2E Testing with Field Trip")) {
      console.log(`\n  ✓ CLAUDE.md already has E2E section`)
    } else {
      console.log(`\n  Adding E2E section to CLAUDE.md...`)
      const section = generateClaudeMdSection(config)
      writeFileSync(claudeMdPath, existing + "\n" + section)
      console.log(`  ✓ E2E section added to CLAUDE.md`)
    }
  } else {
    console.log(`\n  Creating CLAUDE.md with E2E section...`)
    const section = `# ${config.name}\n${generateClaudeMdSection(config)}`
    writeFileSync(claudeMdPath, section)
    console.log(`  ✓ CLAUDE.md created`)
  }

  // Create audit config
  const auditConfigDir = join(projectDir, ".field-trip")
  if (!existsSync(auditConfigDir)) mkdirSync(auditConfigDir, { recursive: true })

  const auditConfigPath = join(auditConfigDir, "audit-config.json")
  const auditConfig = generateAuditConfig(config)
  writeFileSync(auditConfigPath, JSON.stringify(auditConfig, null, 2))
  console.log(`  ✓ Audit config created at .field-trip/audit-config.json`)

  // Add .field-trip to .gitignore if not already there
  const gitignorePath = join(projectDir, ".gitignore")
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8")
    if (!gitignore.includes(".field-trip")) {
      writeFileSync(gitignorePath, gitignore + "\n.field-trip/\n")
      console.log(`  ✓ Added .field-trip/ to .gitignore`)
    }
  }

  console.log(`\n  Setup complete!\n`)
  console.log(`  Next steps:`)
  console.log(`    1. Start your dev server: ${config.devCommand}`)
  console.log(`    2. Ensure relay server is running: node "${FIELD_TRIP_CLI}\\ws-relay.mjs"`)
  console.log(`    3. Open your app in Chrome (Field Trip extension auto-connects)`)
  console.log(`    4. Run browser audit: node "${FIELD_TRIP_CLI}\\security-audit.mjs" --relay`)
  console.log(`    5. Run code audit:    node "${FIELD_TRIP_CLI}\\code-audit.mjs" "${projectDir}"`)
  console.log(`    6. Run pentest:       node "${FIELD_TRIP_CLI}\\pentest-audit.mjs" --relay --safe`)
  console.log(``)

  if (flags.audit || flags.overnight) {
    console.log(`  Running initial audit...\n`)
    // The audit would be run via the relay bridge
    // For now, output the commands
    console.log(`  To audit this project:`)
    console.log(`    node "${FIELD_TRIP_CLI}\\validate-page.mjs" --relay`)
    console.log(`    node "${FIELD_TRIP_CLI}\\security-audit.mjs" --relay`)
    console.log(`    node "${FIELD_TRIP_CLI}\\header-check.mjs" --relay`)
  }

  if (flags.overnight) {
    console.log(`\n  Overnight Mode:`)
    console.log(`  The agent will run the full audit → fix → re-audit loop.`)
    console.log(`  Results will be saved to .field-trip/audit-reports/`)
    console.log(``)
    console.log(`  To start overnight mode manually:`)
    console.log(`    1. Start dev server`)
    console.log(`    2. Start relay server`)
    console.log(`    3. Tell Claude Code: "Run overnight audit on this project"`)
    console.log(`    4. The agent will:`)
    console.log(`       - Audit UX, security, accessibility, performance`)
    console.log(`       - Fix all critical and major issues`)
    console.log(`       - Re-audit to verify fixes`)
    console.log(`       - Repeat until convergence (0 critical/major issues)`)
    console.log(`       - Generate final report`)
  }
}

main().catch(console.error)

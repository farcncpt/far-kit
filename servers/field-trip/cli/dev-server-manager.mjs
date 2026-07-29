#!/usr/bin/env node
/**
 * Dev Server Manager — Manages dev server lifecycle for the build loop.
 *
 * Starts, stops, restarts, and reports status of dev servers.
 * Uses a PID file to track running servers.
 *
 * Usage:
 *   node cli/dev-server-manager.mjs start --dir /path/to/project [--port 3000] [--command "pnpm dev"]
 *   node cli/dev-server-manager.mjs status [--port 3000]
 *   node cli/dev-server-manager.mjs restart [--port 3000]
 *   node cli/dev-server-manager.mjs stop [--port 3000]
 *   node cli/dev-server-manager.mjs logs [--port 3000] [--tail 50]
 */

import { spawn, execSync } from "child_process"
import fs from "fs"
import path from "path"
import http from "http"
import os from "os"

// ─── Parse flags ───

const rawArgs = process.argv.slice(2)

function getFlag(name) {
  const idx = rawArgs.indexOf(name)
  if (idx === -1) return null
  return rawArgs[idx + 1] || null
}

function hasFlag(name) {
  return rawArgs.includes(name)
}

const action = rawArgs[0]
const projectDir = getFlag("--dir")
const port = parseInt(getFlag("--port") || "3000")
const command = getFlag("--command") || null
const tailLines = parseInt(getFlag("--tail") || "50")

// ─── State management ───

const STATE_DIR = path.join(os.tmpdir(), "build-loop-servers")
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true })

function stateFile(p) {
  return path.join(STATE_DIR, `server-${p}.json`)
}

function logFile(p) {
  return path.join(STATE_DIR, `server-${p}.log`)
}

function readState(p) {
  const f = stateFile(p)
  if (!fs.existsSync(f)) return null
  try {
    return JSON.parse(fs.readFileSync(f, "utf-8"))
  } catch {
    return null
  }
}

function writeState(p, state) {
  fs.writeFileSync(stateFile(p), JSON.stringify(state, null, 2))
}

function clearState(p) {
  const f = stateFile(p)
  if (fs.existsSync(f)) fs.unlinkSync(f)
}

// ─── Check if process is alive ───

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ─── Check if port is responding ───

function checkPort(p, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${p}/`, { timeout: 3000 }, (res) => {
      resolve({ up: true, statusCode: res.statusCode })
      res.resume()
    })
    req.on("error", () => resolve({ up: false }))
    req.on("timeout", () => {
      req.destroy()
      resolve({ up: false })
    })
  })
}

// ─── Poll until server is ready ───

async function waitForServer(p, timeout = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await checkPort(p)
    if (result.up) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

// ─── Detect project framework and dev command ───

function detectDevCommand(dir) {
  const pkgPath = path.join(dir, "package.json")
  if (!fs.existsSync(pkgPath)) {
    return { cmd: "npx", args: ["http-server", "-p"], framework: "static" }
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
  const scripts = pkg.scripts || {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  // Check for package manager
  let pm = "npm"
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) pm = "pnpm"
  else if (fs.existsSync(path.join(dir, "yarn.lock"))) pm = "yarn"
  else if (fs.existsSync(path.join(dir, "bun.lockb"))) pm = "bun"

  // Check for common frameworks
  let framework = "unknown"
  if (deps["next"]) framework = "next"
  else if (deps["nuxt"]) framework = "nuxt"
  else if (deps["@sveltejs/kit"]) framework = "sveltekit"
  else if (deps["vite"]) framework = "vite"
  else if (deps["gatsby"]) framework = "gatsby"
  else if (deps["astro"]) framework = "astro"
  else if (deps["react-scripts"]) framework = "cra"

  // Use the dev script if available
  if (scripts.dev) {
    return { cmd: pm, args: ["run", "dev"], framework }
  } else if (scripts.start) {
    return { cmd: pm, args: ["run", "start"], framework }
  }

  return { cmd: pm, args: ["run", "dev"], framework }
}

// ─── Actions ───

async function startServer() {
  if (!projectDir) {
    console.error("Error: --dir is required for start")
    process.exit(1)
  }

  const resolvedDir = path.resolve(projectDir)
  if (!fs.existsSync(resolvedDir)) {
    console.error(`Error: Directory not found: ${resolvedDir}`)
    process.exit(1)
  }

  // Check if already running
  const existing = readState(port)
  if (existing && isProcessAlive(existing.pid)) {
    const status = await checkPort(port)
    if (status.up) {
      console.log(`Server already running on port ${port} (PID ${existing.pid})`)
      console.log(`  Directory: ${existing.dir}`)
      console.log(`  Framework: ${existing.framework}`)
      console.log(`  URL: http://localhost:${port}`)
      return
    }
    // Process alive but port not responding — might be starting up
    console.log(`Server process exists (PID ${existing.pid}) but port ${port} not responding yet...`)
    const ready = await waitForServer(port, 10000)
    if (ready) {
      console.log(`Server is now ready on port ${port}`)
      return
    }
    console.log("Server process seems stuck. Killing and restarting...")
    try {
      process.kill(existing.pid, "SIGTERM")
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000))
  }

  // Determine command
  let cmd, args, framework
  if (command) {
    const parts = command.split(/\s+/)
    cmd = parts[0]
    args = parts.slice(1)
    framework = "custom"
  } else {
    const detected = detectDevCommand(resolvedDir)
    cmd = detected.cmd
    args = [...detected.args]
    framework = detected.framework
  }

  // Add port to command if not already specified
  const fullCmd = [cmd, ...args].join(" ")
  if (!fullCmd.includes(String(port))) {
    // Framework-specific port flags
    if (framework === "next") {
      args.push("--", "--port", String(port))
    } else if (framework === "vite" || framework === "sveltekit") {
      args.push("--", "--port", String(port))
    } else if (framework === "cra") {
      // CRA uses PORT env var
    } else {
      args.push("--port", String(port))
    }
  }

  console.log(`Starting dev server...`)
  console.log(`  Directory: ${resolvedDir}`)
  console.log(`  Command: ${cmd} ${args.join(" ")}`)
  console.log(`  Port: ${port}`)
  console.log(`  Framework: ${framework}`)

  // Open log file
  const log = fs.openSync(logFile(port), "a")

  // Set up environment
  const env = { ...process.env, PORT: String(port) }

  // Spawn the process
  const child = spawn(cmd, args, {
    cwd: resolvedDir,
    env,
    stdio: ["ignore", log, log],
    detached: true,
  })

  child.unref()

  // Save state
  writeState(port, {
    pid: child.pid,
    port,
    dir: resolvedDir,
    command: `${cmd} ${args.join(" ")}`,
    framework,
    startedAt: new Date().toISOString(),
  })

  console.log(`  PID: ${child.pid}`)
  console.log(`  Log: ${logFile(port)}`)
  console.log("")
  console.log(`Waiting for server to be ready...`)

  // Wait for server
  const ready = await waitForServer(port, 30000)
  if (ready) {
    console.log(`Server is ready on http://localhost:${port}`)
  } else {
    console.error(`Warning: Server did not respond within 30s. It may still be starting.`)
    console.error(`Check logs: node cli/dev-server-manager.mjs logs --port ${port}`)
  }
}

async function stopServer() {
  const state = readState(port)
  if (!state) {
    console.log(`No server tracked on port ${port}`)
    return
  }

  if (!isProcessAlive(state.pid)) {
    console.log(`Server process (PID ${state.pid}) is no longer running`)
    clearState(port)
    return
  }

  console.log(`Stopping server on port ${port} (PID ${state.pid})...`)

  // Kill the process group (negative PID kills the group for detached processes)
  try {
    process.kill(-state.pid, "SIGTERM")
  } catch {
    try {
      process.kill(state.pid, "SIGTERM")
    } catch { /* ignore */ }
  }

  // Wait for shutdown
  await new Promise((r) => setTimeout(r, 2000))

  if (isProcessAlive(state.pid)) {
    console.log("Process still alive, sending SIGKILL...")
    try {
      process.kill(-state.pid, "SIGKILL")
    } catch {
      try {
        process.kill(state.pid, "SIGKILL")
      } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  clearState(port)
  console.log("Server stopped.")
}

async function restartServer() {
  const state = readState(port)
  if (!state) {
    console.error(`No server tracked on port ${port}. Use start first.`)
    process.exit(1)
  }

  const dir = state.dir
  const cmd = state.command

  console.log(`Restarting server on port ${port}...`)
  await stopServer()

  // Reuse the original command and directory
  const parts = cmd.split(/\s+/)
  const env = { ...process.env, PORT: String(port) }
  const log = fs.openSync(logFile(port), "a")

  const child = spawn(parts[0], parts.slice(1), {
    cwd: dir,
    env,
    stdio: ["ignore", log, log],
    detached: true,
  })

  child.unref()

  writeState(port, {
    pid: child.pid,
    port,
    dir,
    command: cmd,
    framework: state.framework,
    startedAt: new Date().toISOString(),
  })

  console.log(`  PID: ${child.pid}`)

  const ready = await waitForServer(port, 30000)
  if (ready) {
    console.log(`Server restarted and ready on http://localhost:${port}`)
  } else {
    console.error(`Warning: Server did not respond within 30s after restart.`)
  }
}

async function showStatus() {
  const state = readState(port)
  if (!state) {
    const portStatus = await checkPort(port)
    if (portStatus.up) {
      console.log(`Port ${port}: ACTIVE (not managed by dev-server-manager)`)
      console.log(`  HTTP status: ${portStatus.statusCode}`)
    } else {
      console.log(`Port ${port}: NOT RUNNING`)
    }
    return
  }

  const alive = isProcessAlive(state.pid)
  const portStatus = await checkPort(port)

  console.log(`Port ${port}: ${alive ? "RUNNING" : "DEAD"}`)
  console.log(`  PID: ${state.pid} (${alive ? "alive" : "not found"})`)
  console.log(`  HTTP: ${portStatus.up ? `responding (${portStatus.statusCode})` : "not responding"}`)
  console.log(`  Directory: ${state.dir}`)
  console.log(`  Command: ${state.command}`)
  console.log(`  Framework: ${state.framework}`)
  console.log(`  Started: ${state.startedAt}`)
  console.log(`  Log: ${logFile(port)}`)

  if (!alive) {
    console.log("")
    console.log("  Server process has exited. Check logs for errors.")
    clearState(port)
  }
}

async function showLogs() {
  const lf = logFile(port)
  if (!fs.existsSync(lf)) {
    console.error(`No log file found for port ${port}`)
    process.exit(1)
  }

  const content = fs.readFileSync(lf, "utf-8")
  const lines = content.split("\n")
  const tail = lines.slice(-tailLines)
  console.log(`=== Last ${tailLines} lines from ${lf} ===`)
  console.log(tail.join("\n"))
}

// ─── Usage ───

if (!action || hasFlag("--help") || hasFlag("-h")) {
  console.log(`
Dev Server Manager — Manage dev server lifecycle for the build loop

Usage:
  node cli/dev-server-manager.mjs <action> [options]

Actions:
  start     Start a dev server in the background
  stop      Stop a running dev server
  restart   Restart a running dev server
  status    Show server status
  logs      Show server log output

Options:
  --dir <path>        Project directory (required for start)
  --port <number>     Port number (default: 3000)
  --command <cmd>     Custom dev command (default: auto-detect)
  --tail <number>     Number of log lines to show (default: 50)

Examples:
  node cli/dev-server-manager.mjs start --dir ./my-project --port 3000
  node cli/dev-server-manager.mjs start --dir ./app --command "pnpm dev"
  node cli/dev-server-manager.mjs status --port 3000
  node cli/dev-server-manager.mjs restart --port 3000
  node cli/dev-server-manager.mjs stop --port 3000
  node cli/dev-server-manager.mjs logs --port 3000 --tail 100

Auto-detection:
  The manager detects the project framework (Next.js, Vite, SvelteKit, etc.)
  and package manager (npm, pnpm, yarn, bun) automatically.

State:
  Server state is stored in ${STATE_DIR}/
`)
  process.exit(0)
}

// ─── Dispatch ───

switch (action) {
  case "start":
    await startServer()
    break
  case "stop":
    await stopServer()
    break
  case "restart":
    await restartServer()
    break
  case "status":
    await showStatus()
    break
  case "logs":
    await showLogs()
    break
  default:
    console.error(`Unknown action: ${action}`)
    console.error("Valid actions: start, stop, restart, status, logs")
    process.exit(1)
}

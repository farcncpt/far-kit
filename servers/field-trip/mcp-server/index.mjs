#!/usr/bin/env node
/**
 * Field Trip MCP Server
 *
 * Wraps the CLI tools (tt.mjs) via powershell.exe for browser automation.
 * Operations store for saving/loading reusable workflows.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadKB, saveKB, logToolUsage, logLearning, searchKB, getRecentLearnings, updateTool, getKBSummary } from "./knowledge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve the repo root from this file's location so the server is portable.
// Override with FIELD_TRIP_HOME if the CLI lives elsewhere.
const CLI_DIR = process.env.FIELD_TRIP_HOME || join(__dirname, "..");
const TIMEOUT = parseInt(process.env.COMMAND_TIMEOUT || "30000");

// Execution bridge. Under WSL the CLI must run through powershell.exe so node
// executes on the Windows side (where Chrome and the relay live). Everywhere
// else (native Windows, macOS, plain Linux) run node directly in this process's
// environment. Override with FT_BRIDGE=powershell|direct.
const IS_WSL = process.platform === "linux" && (() => {
  try { return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft"); }
  catch { return false; }
})();
const BRIDGE = process.env.FT_BRIDGE || (IS_WSL ? "powershell" : "direct");

// Stable relay identity for this MCP session. Every CLI call this server makes
// connects to the relay under the SAME identity, so the tab-ownership registry
// treats all of them as one agent (owning tabs across the one-shot CLI pattern,
// where each invocation is a fresh socket). pid is stable for the server's
// lifetime; FT_AGENT_ID overrides it for a launcher-stable session id.
//
// F22: identity is injected TWO ways for determinism —
//   1. inline PowerShell $env: in runCli, so EVERY script (tt.mjs, tt-type.mjs,
//      security-audit.mjs, …) inherits it, not only the ones that go through tt()
//   2. --agent-* flags on tt() specifically (flags win over env in tt.mjs)
// Previously only (2) existed, so any relay client the wrapper spawned that
// wasn't tt() (or a pre-fix build) registered under the default name "tt.mjs"
// and presented as a different client than its own new_tab claim.
const AGENT_NAME = process.env.FT_AGENT_NAME || "mcp-field-trip";
const AGENT_ID = process.env.FT_AGENT_ID || `mcp-${process.pid}`;
const AGENT_KIND = process.env.FT_AGENT_KIND || "claude-code";
const IDENTITY_FLAGS = `--agent-name ${AGENT_NAME} --agent-id ${AGENT_ID} --agent-kind ${AGENT_KIND}`;
// PowerShell env-assignment prefix — sets identity for the whole child process.
// F23: the `$` MUST be backslash-escaped. runCli passes this through execSync,
// which runs the whole command via /bin/sh; inside the double-quoted powershell
// argument, an unescaped `$env` is expanded by sh (to empty), leaving a bare
// `:FT_AGENT_NAME=...` that PowerShell rejects with CommandNotFoundException on
// EVERY call (non-fatal — PS continues to cd+node — but it killed the env
// identity channel and spammed stderr). `\$env` reaches PowerShell literally.
const IDENTITY_ENV = `\\$env:FT_AGENT_NAME='${AGENT_NAME}'; \\$env:FT_AGENT_ID='${AGENT_ID}'; \\$env:FT_AGENT_KIND='${AGENT_KIND}';`;

// ── CLI Runner ──

/**
 * PowerShell can't `cd` into a WSL-style path: when this MCP server runs under
 * WSL node, __dirname is /mnt/c/... which powershell.exe reads as C:\mnt\c\...
 * (nonexistent). Translate /mnt/<drive>/rest → <DRIVE>:/rest before shelling out.
 */
function toWindowsPath(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}

function runCli(cmd, timeoutMs, cwd) {
  try {
    let result;
    if (BRIDGE === "direct") {
      result = execSync(cmd, {
        cwd: cwd || CLI_DIR,
        encoding: "utf8",
        timeout: timeoutMs || TIMEOUT,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, FT_AGENT_NAME: AGENT_NAME, FT_AGENT_ID: AGENT_ID, FT_AGENT_KIND: AGENT_KIND },
      });
    } else {
      const dir = toWindowsPath(cwd || CLI_DIR);
      result = execSync(
        `powershell.exe -NoProfile -Command "${IDENTITY_ENV} cd ${dir}; ${cmd}"`,
        { encoding: "utf8", timeout: timeoutMs || TIMEOUT, stdio: ["pipe", "pipe", "pipe"] }
      );
    }
    return result.replace(/^\[relay mode\].*\n?/, "").trim();
  } catch (e) {
    const stderr = e.stderr?.toString() || "";
    const stdout = e.stdout?.toString() || "";
    if (stdout.trim()) return stdout.trim();
    throw new Error(stderr || e.message);
  }
}

function tt(args) {
  return runCli(`node cli/tt.mjs --relay ${IDENTITY_FLAGS} ${args}`);
}

function ttType(selector, value) {
  return runCli(`node cli/tt-type.mjs --relay '${selector}' '${value}'`);
}

// ── Operations Store ──

const OPS_DIR = join(__dirname, "operations");
const OPS_FILE = join(OPS_DIR, "store.json");

function loadOps() {
  if (!existsSync(OPS_DIR)) mkdirSync(OPS_DIR, { recursive: true });
  if (!existsSync(OPS_FILE)) return {};
  try { return JSON.parse(readFileSync(OPS_FILE, "utf8")); } catch { return {}; }
}

function saveOps(store) {
  if (!existsSync(OPS_DIR)) mkdirSync(OPS_DIR, { recursive: true });
  writeFileSync(OPS_FILE, JSON.stringify(store, null, 2));
}

function substituteVars(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ── MCP Server ──

const server = new McpServer({ name: "field-trip", version: "1.0.0" });

server.tool(
  "browser",
  `Browser automation via Field Trip relay bridge.

ACTIONS:
  scan          — List interactive elements. Params: { maxItems?, tabId? }
  find          — Find by text. Params: { text, tabId? }
  click         — Click element. Params: { target, tabId? }
  type          — Type text. Params: { selector, value, tabId? }
  spotlight     — Highlight with caption. Params: { selector, caption?, tabId? }
  page          — Get title/URL. Params: { tabId? }
  navigate      — Go to URL. Params: { url, tabId? }
  eval          — Run JS in page. Params: { expression, tabId? }
  tabs          — List browser tabs (includes owner/source for claimed tabs).
  new_tab       — Open a NEW tab, auto-claimed as YOURS (use this instead of borrowing user tabs; window.open is popup-blocked). Params: { url? }
  close_tab     — Close a tab you opened. Params: { tabId }
  activate      — Focus a tab you OWN (needed before screenshot). Params: { tabId }
  reload        — Reload tab. Params: { tabId? }
  back/forward  — History navigation. Params: { tabId? }
  scroll        — Scroll to element. Params: { selector, tabId? }
  read          — Read element. Params: { selector, tabId? }
  wait          — Pause. Params: { ms? }

TAB OWNERSHIP (the relay physically blocks you from driving another agent's or the user's tab):
  claim_tab     — Claim an existing tab as yours. Params: { tabId }
  release_tab   — Release your claim. Params: { tabId }
  list_claims   — All tab + window claims (owner, source: auto|agent|user). Params: {}
  list_agents   — Connected agents (agent_name, kind, owned_tabs, queue_depths). Params: {}
  tab_activity  — Classify tabs: 'user' | 'agent' | 'collab' | 'idle'. Params: { tabId? }
                  CONSULT THIS before touching any unclaimed tab — 'user'/'collab' = hands off.
                  (human signal approximated from focused-tab samples; focus ≠ interaction)
  * Disruptive verbs (navigate/click/type/eval/reload/activate/scroll/close_tab) are REJECTED
    when the target tab is owned by another agent OR is the user's focused tab. Read verbs
    (page/scan/read/tabs/screenshot/find/a11y_*) are always allowed.
  * A no-tabId disruptive command targets the user's FOCUSED tab and will be rejected — always
    open your own tab with new_tab and pass its tabId.
  * ESCAPE HATCH — only when the user explicitly asked you to act on their tab: add
    allow_user_tab: true to the command's params. Never use it by default.

AGENT WINDOWS (need pixels? isolate first — never activate in a shared window):
  new_window    — Your OWN Chrome window, opens UNFOCUSED; you own it and every tab
                  created inside it. Params: { url? } → { windowId, tabId }
  new_tab       — accepts window_id to open inside your window. Params: { url?, window_id? }
  activate      — on a tab in YOUR window: allowed, and does NOT focus the window —
                  the user keeps typing wherever they are while you capture.
  Capture flow: new_window → (new_tab {window_id}) → activate {tabId} → screenshot.
  Caveat: captureVisibleTab captures an unfocused window's active tab, but NOT a
  minimized window — agent windows stay restored-but-unfocused.

  annotations   — Read/write page annotations. Params: { action: "list"|"get"|"save"|"delete"|"workflows", ... }
                  list: show all annotations across all domains
                  get: get annotations for current tab (params: { url: "current" })
                  save: create/update annotation (params: { annotation: {...} })
                  delete: remove annotation (params: { id })
                  workflows: list workflows for a domain (params: { domain })

VISUAL CAPTURE:
  screenshot        — Capture visible tab as real pixels, returned as MCP image content.
                      Params: { selector?, format?: "png"|"jpeg", quality?: 0-100, tabId? }
                      selector crops to that element's bounding rect (HiDPI-aware via OffscreenCanvas).
                      Requires tab to be active — call 'activate' first if targeting a specific tab.

AGENT-TOOLS ACTIONS (auto-installed on every page via content script):
  arrive            — Install observers + read existing session. Params: { tabOwner?, tabId? }
  quick_scan        — Health check: counts + top a11y/layout/visual issues. Params: { tabId? }
  a11y_tree         — Reconstructed accessibility tree. Params: { selector?, tabId? }
  a11y_issues       — Find missing labels, alt text, accessible names. Params: { tabId? }
  describe_region   — Structured "what does this look like" for an element. Params: { selector, tabId? }
  layout_audit      — Find overlaps, overflow, viewport clipping, tiny text, obscured clickables. Params: { tabId? }
  clickable_check   — Diagnose whether an element is actually clickable + why not. Params: { selector, tabId? }
  visual_snapshot   — Take a named visual snapshot for later diffing. Params: { name, selector?, tabId? }
  visual_diff       — Diff current state vs named snapshot. Params: { name, tabId? }
  changes_since     — Read DOM mutation ring buffer (since ts). Params: { since?, limit?, kinds?, tabId? }
  tab_health        — Navigation/popup/error incidents since install. Params: { since?, tabId? }
  session_state     — Persistent task session across eval calls. Params: { op: "get"|"start"|"note"|"observe"|"next"|"end", ... }

  batch         — Run commands in sequence. Params: { commands: [{action, params}], delayMs? }

OPERATIONS:
  save_op       — Save reusable workflow. Params: { name, description, commands, variables?, category?, site?, tags? }
  run_op        — Run saved workflow. Params: { name, variables?, dryRun? }
  list_ops      — List saved ops. Params: { category?, site? }
  get_op        — Get op details. Params: { name }
  delete_op     — Delete op. Params: { name }
  export_ops    — Export as JSON. Params: { category?, names? }
  import_ops    — Import from JSON. Params: { json, overwrite? }`,
  {
    action: z.string().describe("Action to execute"),
    params: z.record(z.any()).optional().default({}).describe("Parameters"),
  },
  async ({ action, params: p }) => {
    const text = (t) => ({ content: [{ type: "text", text: t }] });
    const image = (base64, mimeType, caption) => ({
      content: [
        { type: "image", data: base64, mimeType },
        ...(caption ? [{ type: "text", text: caption }] : []),
      ],
    });

    try {
      // ── Screenshot — real pixels as MCP image content ──
      // Uses chrome.tabs.captureVisibleTab in the background service worker
      // to capture the currently visible portion of the target tab. If a
      // selector is provided the image is cropped to that element's bounding
      // rect via OffscreenCanvas. Returns MCP image content so Claude
      // actually sees the pixels instead of a file path.
      //
      // Params: { selector?, format?: "png"|"jpeg", quality?: 0-100, tabId? }
      if (action === "screenshot") {
        const tabFlag = p.tabId ? ` --tab ${p.tabId}` : "";
        const selectorFlag = p.selector ? ` --selector '${p.selector}'` : "";
        const formatFlag = p.format ? ` --format ${p.format}` : "";
        const qualityFlag = p.quality ? ` --quality ${p.quality}` : "";
        const cliOut = tt(`capture_tab${selectorFlag}${formatFlag}${qualityFlag}${tabFlag}`);
        let parsed;
        try {
          parsed = JSON.parse(cliOut);
        } catch {
          return text(`screenshot: could not parse CLI output: ${cliOut.slice(0, 300)}`);
        }
        // Translate Windows paths to WSL paths so the MCP server (running
        // in WSL Linux) can read files written by tt.mjs (running on Windows
        // via PowerShell). C:\Users\... → /mnt/c/Users/...
        const toWslPath = (winPath) => {
          if (!winPath) return winPath;
          const m = winPath.match(/^([A-Z]):\\(.*)$/i);
          if (!m) return winPath;
          return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
        };
        const readPath = BRIDGE === "powershell" ? toWslPath(parsed.path) : parsed.path;
        if (!readPath || !existsSync(readPath)) {
          return text(`screenshot: file not found at ${readPath} (original: ${parsed.path})`);
        }
        const bytes = readFileSync(readPath);
        const base64 = bytes.toString("base64");
        const caption = `${parsed.width || "?"}×${parsed.height || "?"}${parsed.cropped ? ` cropped to ${parsed.selector}` : " viewport"} · ${parsed.title || parsed.url || ""}`;
        return image(base64, parsed.mimeType || "image/png", caption);
      }

      // ── Wait ──
      if (action === "wait") {
        const ms = p.ms || 2000;
        await new Promise(r => setTimeout(r, ms));
        return text(`Waited ${ms}ms`);
      }

      // ── Operations Store ──
      if (action === "save_op") {
        const store = loadOps();
        store[p.name] = {
          name: p.name, description: p.description || "", category: p.category || "general",
          site: p.site || null, commands: p.commands || [], variables: p.variables || [],
          tags: p.tags || [], createdAt: new Date().toISOString(), runCount: 0,
        };
        saveOps(store);
        return text(`Operation "${p.name}" saved (${(p.commands || []).length} steps)`);
      }

      if (action === "list_ops") {
        const store = loadOps();
        let ops = Object.values(store);
        if (p.category) ops = ops.filter(o => o.category === p.category);
        if (p.site) ops = ops.filter(o => o.site?.includes(p.site));
        if (!ops.length) return text("No operations found");
        return text(ops.map(o => `• ${o.name}${o.site ? ` @${o.site}` : ""} — ${o.description} (${o.commands.length} steps)${o.runCount ? ` [ran ${o.runCount}x]` : ""}`).join("\n"));
      }

      if (action === "get_op") {
        const op = loadOps()[p.name];
        return text(op ? JSON.stringify(op, null, 2) : `Operation "${p.name}" not found`);
      }

      if (action === "delete_op") {
        const store = loadOps();
        if (!store[p.name]) return text(`Operation "${p.name}" not found`);
        delete store[p.name]; saveOps(store);
        return text(`Deleted "${p.name}"`);
      }

      if (action === "export_ops") {
        const store = loadOps();
        let result = store;
        if (p.names?.length) { result = {}; for (const n of p.names) if (store[n]) result[n] = store[n]; }
        else if (p.category) { result = {}; for (const [n, o] of Object.entries(store)) if (o.category === p.category) result[n] = o; }
        return text(JSON.stringify(result, null, 2));
      }

      if (action === "import_ops") {
        let incoming; try { incoming = JSON.parse(p.json); } catch { return text("Invalid JSON"); }
        const store = loadOps();
        let imported = 0, skipped = 0;
        for (const [name, op] of Object.entries(incoming)) {
          if (store[name] && !p.overwrite) { skipped++; continue; }
          store[name] = op; imported++;
        }
        saveOps(store);
        return text(`Imported ${imported}, skipped ${skipped}`);
      }

      if (action === "run_op") {
        const store = loadOps();
        const op = store[p.name];
        if (!op) return text(`Operation "${p.name}" not found. Available: ${Object.keys(store).join(", ") || "none"}`);

        const vars = {};
        for (const v of (op.variables || [])) {
          vars[v.name] = p.variables?.[v.name] || v.default || "";
          if (v.required && !vars[v.name]) return text(`Missing variable: ${v.name}`);
        }

        if (p.dryRun) {
          const preview = op.commands.map((c, i) => `${i + 1}. ${c.action} ${JSON.stringify(c.params || {})}`).join("\n");
          return text(`DRY RUN "${p.name}":\n${preview}`);
        }

        const results = [];
        for (const cmd of op.commands) {
          try {
            const cliArgs = buildCliArgs(cmd.action, substituteParams(cmd.params || {}, vars));
            if (cmd.action === "wait") {
              await new Promise(r => setTimeout(r, cmd.params?.ms || 2000));
              results.push(`✓ wait`);
            } else {
              const out = tt(cliArgs);
              results.push(`✓ ${cmd.action}: ${out.substring(0, 100)}`);
            }
          } catch (e) {
            results.push(`✗ ${cmd.action}: ${e.message.substring(0, 100)}`);
          }
        }

        store[p.name].runCount = (store[p.name].runCount || 0) + 1;
        store[p.name].lastRunAt = new Date().toISOString();
        saveOps(store);
        return text(`"${p.name}" complete:\n${results.join("\n")}`);
      }

      // ── Batch ──
      if (action === "batch") {
        const results = [];
        for (const cmd of (p.commands || [])) {
          try {
            if (cmd.action === "wait") {
              await new Promise(r => setTimeout(r, cmd.params?.ms || 2000));
              results.push(`── wait ──\nWaited ${cmd.params?.ms || 2000}ms`);
            } else {
              const args = buildCliArgs(cmd.action, cmd.params || {});
              const out = tt(args);
              results.push(`── ${cmd.action} ──\n${out}`);
            }
          } catch (e) {
            results.push(`── ${cmd.action} ──\nERROR: ${e.message}`);
          }
          if (p.delayMs) await new Promise(r => setTimeout(r, p.delayMs));
        }
        return text(results.join("\n\n"));
      }

      // ── Direct CLI Commands ──
      const args = buildCliArgs(action, p);
      const result = tt(args);
      return text(result || "(no output)");

    } catch (e) {
      return text(`Error: ${e.message}`);
    }
  }
);

// ── Build CLI args for tt.mjs relay commands ──

function buildCliArgs(action, p) {
  const tabFlag = p.tabId ? ` --tab ${p.tabId}` : "";
  // Explicit escape hatch — only when the caller set allow_user_tab. tt.mjs
  // merges it into the relay command's params so the ownership gate lets it by.
  const allowFlag = p.allow_user_tab === true ? " --allow-user-tab" : "";

  // Ownership / presence verbs — the relay server handles these; tt.mjs relays
  // them straight through. claim/release/grant take a tabId, list_* take none.
  if (action === "claim_tab" || action === "release_tab" || action === "grant_tab") {
    return `${action}${tabFlag}`;
  }
  if (action === "list_claims" || action === "list_agents") {
    return action;
  }

  switch (action) {
    case "scan": return `scan${tabFlag}`;
    case "find": return `find ${quote(p.text || "")}${tabFlag}`;
    case "click": return `click ${quote(p.target || p.selector || "")}${tabFlag}${allowFlag}`;
    case "type": return `type ${quote(p.selector || "")} ${quote(p.value || "")}${tabFlag}${allowFlag}`;
    case "spotlight": return `spotlight ${quote(p.selector || "")} ${p.caption || ""}${tabFlag}`;
    case "page": return `page${tabFlag}`;
    case "navigate": return `navigate ${quote(p.url || "")}${tabFlag}${allowFlag}`;
    case "eval": return `eval ${quote(p.expression || "")}${tabFlag}${allowFlag}`;
    case "tabs": return "tabs";
    case "activate": return `activate ${p.tabId || ""}${allowFlag}`;
    case "reload": return `reload${tabFlag}${allowFlag}`;
    case "back": return `back${tabFlag}${allowFlag}`;
    case "forward": return `forward${tabFlag}${allowFlag}`;
    case "new_tab": return `new_tab ${quote(p.url || "about:blank")}${p.window_id ? ` --window ${p.window_id}` : ""}`;
    case "new_window": return `new_window ${quote(p.url || "about:blank")}`;
    case "tab_activity": return `tab_activity${tabFlag}`;
    case "close_tab": return `close_tab ${p.tabId || ""}`;
    case "zoom": return `zoom ${p.level || 1.0}${tabFlag}`;
    case "annotations": return `annotations ${p.action || "get"}${p.domain ? " " + quote(p.domain) : ""}${tabFlag}`;
    case "scroll": return `scroll ${quote(p.selector || "")}${tabFlag}`;
    case "read": return `read ${quote(p.selector || "")}${tabFlag}`;

    // ── Agent-tools actions ──
    // Every one of these is implemented natively in the content script
    // but doesn't need a dedicated tt.mjs case — we pass through as
    // `agent_action <name> <paramsJson>` and tt.mjs relays the raw
    // relay.command() call. See cli/tt.mjs `agent_action` handler.
    case "arrive":
    case "quick_scan":
    case "a11y_tree":
    case "a11y_issues":
    case "describe_region":
    case "layout_audit":
    case "clickable_check":
    case "visual_snapshot":
    case "visual_diff":
    case "changes_since":
    case "tab_health":
    case "session_state":
      return `agent_action ${action} ${quote(JSON.stringify(p))}${tabFlag}`;

    default: return `${action} ${Object.values(p).filter(v => typeof v === "string").map(quote).join(" ")}`;
  }
}

function quote(s) {
  if (!s) return "''";
  return `'${s.replace(/'/g, "''")}'`;
}

function substituteParams(params, vars) {
  const result = {};
  for (const [k, v] of Object.entries(params)) {
    result[k] = typeof v === "string" ? substituteVars(v, vars) : v;
  }
  return result;
}

// ── Dynamic CLI Tool Runner ──
// Auto-discovers scripts in cli/ directories across projects
// No rebuild needed — just add a .mjs file and it's available

function runCliTool(script, args, cwd) {
  const dir = cwd || CLI_DIR;
  return runCli(`node cli/${script} ${args}`, null, dir);
}

function runBinary(binary, args) {
  try {
    if (BRIDGE === "direct") {
      return execSync(`${binary} ${args}`, {
        encoding: "utf8", timeout: TIMEOUT, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    }
    return execSync(
      `powershell.exe -NoProfile -Command "${binary} ${args}"`,
      { encoding: "utf8", timeout: TIMEOUT, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e) {
    const stdout = e.stdout?.toString()?.trim();
    if (stdout) return stdout;
    throw new Error(e.stderr?.toString() || e.message);
  }
}

server.tool(
  "tools",
  `Dynamic CLI tool runner. Auto-discovers and runs CLI tools from any project.
No rebuild needed — add a .mjs file to cli/ and it's immediately available.

ACTIONS:
  run           — Run a CLI tool. Params: { script, args?, project? }
                  script: filename (e.g. "security-audit.mjs")
                  args: command line args as string
                  project: project path (default: joyride-web-extension)

  list          — List available CLI tools. Params: { project? }
                  Returns all .mjs files in the cli/ directory

  help          — Get help for a tool. Params: { script, project? }
                  Runs the tool with --help or -h flag

  create        — Create a new CLI tool. Params: { script, code, project? }
                  Writes a new .mjs file to the cli/ directory

  binary        — Run a system binary. Params: { cmd }
                  For truth-seeker, refactor-runtime, etc.

SHORTCUTS (common tools with smart defaults):
  security      — security-audit.mjs --relay. Params: { url?, tabId? }
  pentest       — pentest-audit.mjs --relay --safe. Params: { url?, tabId?, project? }
  headers       — header-check.mjs. Params: { url }
  code_audit    — code-audit.mjs. Params: { path, flags? }
  validate      — validate-page.mjs --relay. Params: { tabId? }
  deep_scan     — deep-scan.mjs --relay. Params: { tabId? }
  dom           — dom-simplify.mjs --relay. Params: { level?, tabId? }
  forms         — read-form.mjs --relay. Params: { tabId? }
  canvas        — canvas-detect.mjs --relay. Params: { tabId? }
  console       — check-console-errors.mjs --relay. Params: { tabId? }
  responsive    — responsive-check.mjs --relay. Params: { tabId? }
  screenshot    — screenshot.mjs. Params: { output?, chartOnly? }
  orchestrate   — orchestrate.mjs. Params: { path, output? }
  bootstrap     — bootstrap-project.mjs. Params: { path }
  dom_audit     — dom-audit.mjs: contrast, links, a11y, security, design. Params: { checks?, tabId?, output? }`,
  {
    action: z.string().describe("Action: run, list, help, create, binary, or a shortcut name"),
    params: z.record(z.any()).optional().default({}).describe("Parameters"),
  },
  async ({ action, params: p }) => {
    const text = (t) => ({ content: [{ type: "text", text: t }] });
    const projectDir = p.project || CLI_DIR;
    const relayFlag = p.relay !== false ? " --relay" : "";
    const tabFlag = p.tabId ? ` --tab ${p.tabId}` : "";

    try {
      switch (action) {
        // ── Core actions ──
        case "run": {
          const script = p.script || "";
          if (!script) return text("Missing 'script' param. Use 'list' to see available tools.");
          const args = p.args || "";
          return text(runCli(`node cli/${script} ${args}`, null, projectDir));
        }

        case "list": {
          if (BRIDGE === "direct") {
            const files = readdirSync(join(projectDir, "cli"))
              .filter((f) => f.endsWith(".mjs"))
              .sort()
              .join("\n");
            return text(files || "No CLI tools found");
          }
          const files = execSync(
            `powershell.exe -NoProfile -Command "Get-ChildItem -Path '${projectDir.replace(/\//g, "\\")}\\cli' -Filter '*.mjs' | Select-Object -ExpandProperty Name | Sort-Object"`,
            { encoding: "utf8", timeout: 10000 }
          ).trim();
          return text(files || "No CLI tools found");
        }

        case "help": {
          const script = p.script || "";
          if (!script) return text("Missing 'script' param");
          try { return text(runCli(`node cli/${script} --help`, null, projectDir)); }
          catch { return text(runCli(`node cli/${script} -h`, null, projectDir)); }
        }

        case "create": {
          const script = p.script || "";
          const code = p.code || "";
          if (!script || !code) return text("Missing 'script' or 'code' param");
          const filePath = BRIDGE === "powershell"
            ? join(projectDir.replace("C:", "/mnt/c"), "cli", script)
            : join(projectDir, "cli", script);
          writeFileSync(filePath, code);
          return text(`Created cli/${script} (${code.length} bytes)`);
        }

        case "binary": {
          return text(runBinary(p.cmd || "", ""));
        }

        // ── Shortcuts ──
        case "security":
          return text(runCli(`node cli/security-audit.mjs${relayFlag}${p.url ? ` --url ${quote(p.url)}` : ""}${tabFlag}`, null, projectDir));
        case "pentest":
          return text(runCli(`node cli/pentest-audit.mjs${relayFlag} --safe${p.url ? ` --url ${quote(p.url)}` : ""}${p.project ? ` --project ${quote(p.project)}` : ""}${tabFlag}`, null, projectDir));
        case "headers":
          return text(runCli(`node cli/header-check.mjs ${quote(p.url || "")}`, null, projectDir));
        case "code_audit": {
          const flags = p.flags || "--imports --env --arch";
          return text(runCli(`node cli/code-audit.mjs ${quote(p.path || ".")} ${flags}`, null, projectDir));
        }
        case "validate":
          return text(runCli(`node cli/validate-page.mjs${relayFlag}${tabFlag}`, null, projectDir));
        case "deep_scan":
          return text(runCli(`node cli/deep-scan.mjs${relayFlag}${tabFlag}`, null, projectDir));
        case "dom":
          return text(runCli(`node cli/dom-simplify.mjs${relayFlag}${p.level ? ` --level ${p.level}` : ""}${tabFlag}`, null, projectDir));
        case "forms":
          return text(runCli(`node cli/read-form.mjs${relayFlag}${tabFlag}`, null, projectDir));
        case "canvas":
          return text(runCli(`node cli/canvas-detect.mjs${relayFlag}${tabFlag}`, null, projectDir));
        case "console":
          return text(runCli(`node cli/check-console-errors.mjs${relayFlag}${tabFlag}`, null, projectDir));
        case "responsive":
          return text(runCli(`node cli/responsive-check.mjs${relayFlag}${tabFlag}`, null, projectDir));
        case "screenshot":
          return text(runCli(`node cli/screenshot.mjs${p.output ? ` --output ${quote(p.output)}` : ""}${p.chartOnly ? " --chart-only" : ""}`, null, projectDir));
        case "orchestrate":
          return text(runCli(`node cli/orchestrate.mjs ${quote(p.path || ".")}${p.output ? ` --output ${quote(p.output)}` : ""}`, null, projectDir));
        case "bootstrap":
          return text(runCli(`node cli/bootstrap-project.mjs ${quote(p.path || ".")}`, null, projectDir));
        case "dom_audit":
          return text(runCli(`node cli/dom-audit.mjs${relayFlag}${tabFlag}${p.checks ? ` --checks ${p.checks}` : ""}${p.output ? ` --output ${quote(p.output)}` : ""}`, null, projectDir));

        default:
          // Try running it as a script name directly
          if (action.endsWith(".mjs") || action.endsWith(".js")) {
            return text(runCli(`node cli/${action} ${p.args || ""}`, null, projectDir));
          }
          // Try adding .mjs
          try {
            return text(runCli(`node cli/${action}.mjs ${p.args || ""}`, null, projectDir));
          } catch {
            return text(`Unknown action: "${action}". Use 'list' to see available tools, or pass a script filename.`);
          }
      }
    } catch (e) {
      return text(`Error: ${e.message}`);
    }
  }
);

// ── Knowledge Base Tool ──

server.tool(
  "knowledge",
  `Persistent tool knowledge base — survives compactions and sessions.

ACTIONS:
  summary       — Get overview of all known tools and categories
  search        — Find tools by keyword. Params: { query }
  log_use       — Log a tool usage. Params: { tool, action?, params?, result?, duration? }
  learn         — Log a learning event. Params: { type, message, context? }
  get_learnings — Get recent learnings. Params: { count? }
  update        — Update tool metadata. Params: { tool, description?, category?, notes? }
  get           — Get full details of a tool. Params: { tool }
  list          — List all tools in the knowledge base
  add_note      — Add a note to a tool. Params: { tool, note }`,
  {
    action: z.string().describe("Action to execute"),
    params: z.record(z.any()).optional().default({}).describe("Parameters"),
  },
  async ({ action, params: p }) => {
    const text = (t) => ({ content: [{ type: "text", text: t }] });

    switch (action) {
      case "summary":
        return text(getKBSummary());

      case "search":
        const matches = searchKB(p.query || "");
        if (!matches.length) return text(`No tools found matching "${p.query}"`);
        return text(matches.map(m => `• ${m.name} (score:${m.score}, used:${m.useCount}x) — ${m.description || "no desc"}\n  Category: ${m.category} | Params: ${m.params?.join(", ") || "none"}`).join("\n\n"));

      case "log_use":
        logToolUsage(p.tool || "unknown", p.action, p.params, p.result, p.duration);
        return text(`Logged usage of "${p.tool}"`);

      case "learn":
        logLearning({ type: p.type || "observation", message: p.message || "", context: p.context });
        return text(`Learning logged: ${p.message}`);

      case "get_learnings":
        const learnings = getRecentLearnings(p.count || 10);
        if (!learnings.length) return text("No learnings recorded yet.");
        return text(learnings.map(l => `[${l.timestamp}] ${l.type}: ${l.message}`).join("\n"));

      case "update":
        const updated = updateTool(p.tool || "", {
          ...(p.description ? { description: p.description } : {}),
          ...(p.category ? { category: p.category } : {}),
        });
        if (p.notes) {
          if (!updated.notes) updated.notes = [];
          updated.notes.push(p.notes);
          saveKB(loadKB());
        }
        return text(`Updated "${p.tool}": ${JSON.stringify(updated, null, 2)}`);

      case "get": {
        const kb = loadKB();
        const tool = kb[p.tool || ""];
        return text(tool ? JSON.stringify(tool, null, 2) : `Tool "${p.tool}" not found in knowledge base`);
      }

      case "list": {
        const kb = loadKB();
        const tools = Object.keys(kb);
        return text(tools.length ? tools.join("\n") : "Knowledge base is empty");
      }

      case "add_note": {
        const kb = loadKB();
        if (!kb[p.tool]) return text(`Tool "${p.tool}" not found`);
        if (!kb[p.tool].notes) kb[p.tool].notes = [];
        kb[p.tool].notes.push(p.note);
        saveKB(kb);
        return text(`Note added to "${p.tool}"`);
      }

      default:
        return text(`Unknown knowledge action: "${action}"`);
    }
  }
);

// ── Start ──

const transport = new StdioServerTransport();
await server.connect(transport);

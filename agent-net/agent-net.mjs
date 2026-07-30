#!/usr/bin/env node
/**
 * agent-net — auto-registration, liveness, and push messaging for Claude Code
 * terminal agents, driven entirely by hooks (no tmux, no polling).
 *
 * Hook wiring (settings.json):
 *   SessionStart     → register session + inject roster & pending messages
 *   UserPromptSubmit → heartbeat + inject pending messages with the prompt
 *   Stop             → if inbox has messages, block stop and deliver them
 *   SessionEnd       → deregister
 *
 * Agent-side commands (via Bash):
 *   agent-net send <name> <message...> [--from <name>]
 *   agent-net list            # live/dead roster (PID-checked)
 *   agent-net watch           # optional sweeper daemon (15s prune loop)
 *
 * State: ~/.claude/agent-net/state/{agents,inbox}/
 * Liveness = does /proc/<pid> still exist. No cooperation needed.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, renameSync, appendFileSync } from "fs";
import { spawn } from "child_process";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const AGENTS = join(ROOT, "state", "agents");
const INBOX = join(ROOT, "state", "inbox");
mkdirSync(AGENTS, { recursive: true });
mkdirSync(INBOX, { recursive: true });

const sanitize = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function readStdinJson() {
  try { return JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

function agentName(cwd) {
  return sanitize(process.env.AGENT_NET_NAME || basename(cwd || process.cwd()));
}

function loadAgents() {
  const out = [];
  for (const f of readdirSync(AGENTS)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(AGENTS, f), "utf8"))); } catch { /* corrupt entry, skip */ }
  }
  return out;
}

function pruneDead() {
  for (const a of loadAgents()) {
    if (!pidAlive(a.pid)) { try { unlinkSync(join(AGENTS, a.session_id + ".json")); } catch {} }
  }
}

/** Atomically drain the inbox for a name. Sends racing the drain land in a fresh file. */
function drainInbox(name) {
  const file = join(INBOX, name + ".jsonl");
  if (!existsSync(file)) return [];
  const tmp = file + "." + process.pid + ".draining";
  try { renameSync(file, tmp); } catch { return []; }
  const msgs = readFileSync(tmp, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  try { unlinkSync(tmp); } catch {}
  return msgs;
}

function formatMsgs(msgs) {
  return msgs.map((m) => `• [${m.ts}] from ${m.from}: ${m.msg}`).join("\n");
}

function rosterText(selfSession) {
  const live = loadAgents().filter((a) => pidAlive(a.pid) && a.session_id !== selfSession);
  if (!live.length) return "No other agents are currently alive.";
  return "Live agents:\n" + live.map((a) => `• ${a.name} — ${a.cwd} (since ${a.started})`).join("\n");
}

const HOWTO = `To message another agent: node ${join(ROOT, "agent-net.mjs")} send <agent-name> "your message" --from <your-name>. It is delivered automatically at the end of their current turn or with their next prompt.`;

// ── subcommands ──

const [, , cmd, ...rest] = process.argv;

if (cmd === "hook") {
  const event = rest[0];
  const input = readStdinJson();
  const sid = input.session_id || "unknown";
  const cwd = input.cwd || process.cwd();
  const name = agentName(cwd);
  const regFile = join(AGENTS, sid + ".json");

  if (event === "SessionStart") {
    pruneDead();
    writeFileSync(regFile, JSON.stringify({ session_id: sid, name, cwd, pid: process.ppid, started: new Date().toISOString() }, null, 2));
    const msgs = drainInbox(name);
    const parts = [`[agent-net] You are registered as "${name}".`, rosterText(sid), HOWTO];
    if (msgs.length) parts.push(`Messages received while you were away:\n${formatMsgs(msgs)}`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts.join("\n\n") } }));
    process.exit(0);
  }

  if (event === "UserPromptSubmit") {
    // Self-heal: if SessionStart was missed (trust dialog, race, transient
    // failure), register on the first prompt instead.
    if (!existsSync(regFile)) {
      writeFileSync(regFile, JSON.stringify({ session_id: sid, name, cwd, pid: process.ppid, started: new Date().toISOString() }, null, 2));
    }
    try { const r = JSON.parse(readFileSync(regFile, "utf8")); r.last_seen = new Date().toISOString(); writeFileSync(regFile, JSON.stringify(r, null, 2)); } catch {}
    const msgs = drainInbox(name);
    if (msgs.length) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `[agent-net] New inter-agent messages:\n${formatMsgs(msgs)}` } }));
    }
    process.exit(0);
  }

  if (event === "Stop") {
    // Self-heal here too: /rc transitions cycle the session id (SessionEnd
    // fires without a re-register), so any turn boundary re-joins the mesh.
    if (!existsSync(regFile)) {
      writeFileSync(regFile, JSON.stringify({ session_id: sid, name, cwd, pid: process.ppid, started: new Date().toISOString() }, null, 2));
    }
    const msgs = drainInbox(name);
    if (msgs.length) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: `[agent-net] Message(s) arrived from other agents. Handle them now — reply with 'send' if a response is expected, then finish your turn.\n${formatMsgs(msgs)}` }));
    }
    process.exit(0);
  }

  if (event === "SessionEnd") {
    try { unlinkSync(regFile); } catch {}
    process.exit(0);
  }

  process.exit(0);
}

if (cmd === "send") {
  const fromIdx = rest.indexOf("--from");
  let from = agentName(process.cwd());
  let args = rest;
  if (fromIdx !== -1) { from = sanitize(rest[fromIdx + 1] || from); args = rest.slice(0, fromIdx).concat(rest.slice(fromIdx + 2)); }
  const [target, ...msgParts] = args;
  const msg = msgParts.join(" ").trim();
  if (!target || !msg) { console.error("usage: agent-net send <name> <message...> [--from <name>]"); process.exit(1); }
  const tname = sanitize(target);
  const live = loadAgents().filter((a) => a.name === tname && pidAlive(a.pid));
  appendFileSync(join(INBOX, tname + ".jsonl"), JSON.stringify({ from, to: tname, msg, ts: new Date().toISOString() }) + "\n");
  console.log(live.length
    ? `queued for ${tname} (${live.length} live session${live.length > 1 ? "s" : ""}) — delivered at their next turn boundary`
    : `queued for ${tname} — no live session right now; delivered when one starts`);
  process.exit(0);
}

if (cmd === "list") {
  pruneDead();
  const agents = loadAgents();
  if (!agents.length) { console.log("no registered agents"); process.exit(0); }
  for (const a of agents) {
    const inboxFile = join(INBOX, a.name + ".jsonl");
    const pending = existsSync(inboxFile) ? readFileSync(inboxFile, "utf8").split("\n").filter(Boolean).length : 0;
    console.log(`${pidAlive(a.pid) ? "ALIVE" : "DEAD "}  ${a.name.padEnd(24)} pid=${String(a.pid).padEnd(7)} inbox=${pending}  ${a.cwd}`);
  }
  process.exit(0);
}

if (cmd === "rc-rescue") {
  // agent-net rc-rescue <agent-name>
  // Focus the agent's own window by its stable "agent:<name>" title and type
  // /rc + Enter — enabling Remote Control on the RUNNING session. Works for
  // windows created by `agent-net spawn` (which stamps the title). Steals
  // foreground focus for ~2 seconds; don't type while it runs.
  const target = rest[0];
  if (!target) { console.error("usage: agent-net rc-rescue <agent-name>"); process.exit(1); }
  const title = `agent:${sanitize(target)}`;
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell;",
    `if (-not $ws.AppActivate('${title}')) { Write-Output 'NOTFOUND'; exit 1 };`,
    "Start-Sleep -Milliseconds 600;",
    "$ws.SendKeys('/rc');",
    "Start-Sleep -Milliseconds 900;",
    "$ws.SendKeys('~');",
    "Write-Output 'SENT'",
  ].join(" ");
  const proc = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.on("close", () => {
    if (out.includes("SENT")) {
      console.log(`rc-rescue: typed /rc into window "${title}" — check it for the Remote Control banner`);
    } else {
      console.error(`rc-rescue: no window titled "${title}" found. Only windows created by 'agent-net spawn' carry stable titles; for others, focus the window manually and run: agent-net rc-here`);
      process.exit(1);
    }
  });
} else if (cmd === "rc-here") {
  // Fallback for windows without a stable title: user focuses the target
  // window themselves, then this types /rc into the foreground window.
  const ps = "$ws = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 400; $ws.SendKeys('/rc'); Start-Sleep -Milliseconds 900; $ws.SendKeys('~'); Write-Output 'SENT'";
  const proc = spawn("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: ["ignore", "pipe", "pipe"] });
  proc.on("close", () => console.log("rc-here: typed /rc into the focused window"));
} else if (cmd === "spawn") {
  // agent-net spawn <project-path> [opening prompt...] [--rc] [--name <n>]
  // Opens a new Windows Terminal window running an interactive claude session
  // in <project-path>. The session auto-registers via the SessionStart hook,
  // making it immediately discoverable and messageable on the mesh.
  let args = [...rest];
  const flag = (f, hasValue = false) => {
    const i = args.indexOf(f);
    if (i === -1) return hasValue ? undefined : false;
    const v = hasValue ? args[i + 1] : true;
    args.splice(i, hasValue ? 2 : 1);
    return v;
  };
  const rc = flag("--rc");
  const cont = flag("--continue");
  const resume = flag("--resume", true);
  const name = flag("--name", true);
  const auto = flag("--auto");
  const skipPerms = flag("--skip-permissions");
  const [projPath, ...promptParts] = args;
  if (!projPath) { console.error("usage: agent-net spawn <project-path> [opening prompt...] [--rc] [--continue] [--resume <session-id>] [--name <n>]"); process.exit(1); }
  const prompt = promptParts.join(" ").trim();

  // Write a launcher script and pass only its (space-free) path through the
  // wt.exe → wsl.exe boundary — inline quoting does not survive wt's parsing.
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const launchDir = join(ROOT, "state", "launch");
  mkdirSync(launchDir, { recursive: true });
  const script = join(launchDir, `spawn-${Date.now()}.sh`);
  writeFileSync(script, [
    "#!/usr/bin/env bash",
    name ? `export AGENT_NET_NAME=${shq(name)}` : "",
    `cd ${shq(projPath)} || { echo "cd failed: ${projPath}"; exec bash; }`,
    `exec claude${rc ? " --rc" : ""}${cont ? " --continue" : ""}${resume ? " --resume " + shq(resume) : ""}${auto ? " --permission-mode auto" : ""}${skipPerms ? " --allow-dangerously-skip-permissions" : ""}${prompt ? " " + shq(prompt) : ""}`,
    "",
  ].filter(Boolean).join("\n"), { mode: 0o755 });

  // -w new: own window per agent (tabs can't be focus-targeted by API).
  // --title + --suppressApplicationTitle: permanent "agent:<name>" window
  // title Claude Code cannot overwrite — the stable handle rc-rescue needs.
  const windowTitle = `agent:${sanitize(name || basename(projPath))}`;
  const child = spawn("wt.exe", [
    "-w", "new",
    "--title", windowTitle,
    "--suppressApplicationTitle",
    "wsl.exe", "-e", "bash", "-lic", script,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (e) => {
    console.error(`wt.exe failed (${e.message}) — is Windows Terminal installed? Falling back is manual: run in any terminal:\n  cd ${projPath} && claude${rc ? " --rc" : ""}`);
    process.exit(1);
  });
  child.unref();
  console.log(`spawning claude in ${projPath}${name ? ` as "${sanitize(name)}"` : ""}${rc ? " with remote control" : ""}${prompt ? ` — opening prompt: "${prompt}"` : ""}`);
  console.log("it will appear in agent-net list / agent-com discovery once the session starts");
  // give wt.exe a moment to launch before this process exits
  setTimeout(() => process.exit(0), 1500);
} else if (cmd === "watch") {
  const interval = parseInt(process.env.AGENT_NET_SWEEP_MS || "15000");
  console.log(`agent-net watcher: pruning dead sessions every ${interval / 1000}s`);
  setInterval(() => {
    const before = loadAgents().length;
    pruneDead();
    const after = loadAgents().length;
    if (before !== after) console.log(`[${new Date().toISOString()}] pruned ${before - after} dead session(s)`);
  }, interval);
} else if (cmd) {
  console.error(`unknown command: ${cmd}\nusage: agent-net <hook <event>|send|list|spawn|watch>`);
  process.exit(1);
} else {
  console.log("usage: agent-net <hook <event>|send|list|spawn|watch>");
}

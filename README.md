# far-kit

Lean, portable Claude Code plugin — browser automation (Field Trip relay + Chrome extension + MCP), runtime validators (Truth-Seeker), refactoring engine (refactor-runtime), internal code analysis, plus curated skills, agents, and workflow rules. Clone it on any machine and be productive in minutes.

> **Note:** if installing on a work machine, make sure your employer's policy allows third-party dev tools and browser extensions.

**License: AGPL-3.0-only.** Free to use, study, and modify. If you modify it and provide it to others as a service (including over a network), you must publish your modified source under the same license. See [LICENSE](LICENSE).

## What's inside

| Component | Path | What it gives you |
|---|---|---|
| **Field Trip MCP** | `servers/field-trip/mcp-server` | `browser` / `knowledge` / `tools` MCP tools — scan, click, type, eval, screenshot, spotlight, annotations, multi-tab etiquette |
| **WebSocket relay** | `servers/field-trip/cli/ws-relay.mjs` | Bridges CLI/agents ↔ Chrome extension on port 9333; serves the tab-ownership panel at `http://localhost:9333/` |
| **Chrome extension** | `servers/field-trip/extension` | Built, ready for Load Unpacked |
| **CLI tools** | `servers/field-trip/cli` | `tt.mjs` and ~100 helper scripts (audits, scans, flows) callable directly or via the `tools` MCP action |
| **Truth-Seeker** | `servers/truth-seeker` | Migration safety, env var audit, ORM/API contract validation, webhook simulation, SSR checks |
| **refactor-runtime** | `servers/refactor-runtime` | Dependency-graph refactoring (rename/move/dead-code/impact) backed by a Rust engine; prebuilt Linux + Windows binaries in `bin/` |
| **internal-code** | `servers/internal-code` | Internal code analysis and function validation |
| **agent-net** | `agent-net/` + `scripts/install-agent-net.sh` | Terminal-agent mesh: hook-driven auto-registration, PID-verified liveness, push messaging between sessions, `spawn` (summon a terminal agent in any project), `rc-rescue` (enable Remote Control on a running session). Install: `bash scripts/install-agent-net.sh` |
| **Skills** | `skills/` | 24 curated skills: agent-net, field-trip family, tab-coworking, production-testing/security, refactor, human-walkthrough, and more |
| **Agents** | `agents/` | architect, code-reviewer, security-reviewer, typescript-reviewer, e2e-runner |
| **Rules** | `rules/` | Reference workflow docs (testing protocol, deploy verification, git workflow, coding style) — copy into `~/.claude/rules/` or reference from CLAUDE.md |

## Setup on a new machine

Prereqs: Node 18+ (22 recommended), npm, Chrome, Claude Code.

```bash
git clone https://github.com/farcncpt/far-kit.git
cd far-kit
bash scripts/setup.sh        # or: powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
```

Then:

1. **Chrome extension** — `chrome://extensions` → Developer mode → *Load unpacked* → select `servers/field-trip/extension`.
2. **Relay** — keep running in a terminal: `node servers/field-trip/cli/ws-relay.mjs` (port 9333, override with `RELAY_PORT`). The extension's relay page auto-connects. Tab ownership panel: `http://localhost:9333/`.
3. **Install the plugin** in Claude Code:
   ```
   /plugin marketplace add farcncpt/far-kit
   /plugin install far-kit@far-kit
   ```
   That registers all four MCP servers (paths resolve via `${CLAUDE_PLUGIN_ROOT}`) and loads the bundled skills and agents.

Verify: `/mcp` should list field-trip, truth-seeker, refactor-runtime, internal-code. Then try `mcp__field-trip__browser({ action: "page" })` with a Chrome tab open.

## Platform notes

- **Execution bridge (field-trip):** the MCP server auto-detects its environment. Under WSL it shells through `powershell.exe` so node runs on the Windows side next to Chrome; on native Windows/macOS/Linux it runs node directly. Force with `FT_BRIDGE=powershell` or `FT_BRIDGE=direct`.
- **refactor-runtime binary:** `bin/` ships prebuilt `refactor-runtime` (Linux x64) and `refactor-runtime.exe` (Windows x64). The MCP server finds them automatically; override with `REFACTOR_RUNTIME_BIN`. To rebuild for another platform: `cd servers/refactor-runtime/rust-src && cargo build --release`, then point `REFACTOR_RUNTIME_BIN` at the output. Pure-TS fallback server (slower, no binary needed): change the plugin `.mcp.json` entry to `dist/src/mcp/server.js`.
- **Truth-Seeker optional backends:** some tools use Postgres/Redis/S3 if configured via env; core validation tools work with none of them.

## Remote MCPs (not bundled — add per machine)

These are HTTP servers, nothing to install; add if wanted:

```bash
claude mcp add --transport http ai-project-planner https://v0-ai-project-planner-eight.vercel.app/mcp
claude mcp add --transport http neon https://mcp.neon.tech/mcp
```

The planner derives identity from your API key — configure its auth header per its docs before relying on it.

## Layout

```
far-kit/
├── .claude-plugin/
│   ├── plugin.json          # plugin manifest
│   └── marketplace.json     # lets /plugin marketplace add farcncpt/far-kit work
├── .mcp.json                # four bundled MCP servers, ${CLAUDE_PLUGIN_ROOT}-relative
├── servers/                 # all server code (dist builds + package.json each)
├── skills/                  # auto-loaded by the plugin
├── agents/                  # auto-loaded by the plugin
├── rules/                   # reference docs (manual copy to ~/.claude/rules/ if wanted)
└── scripts/setup.sh|ps1     # npm install for every server
```

## Updating the kit

The bundles are snapshots of the source repos (`joyride-web-extension`, `Truth-Seeker/*`, `refactor-runtime`). After changing a source project, rebuild it there, re-copy its `dist/` (and `extension/` for field-trip) into `servers/<name>/`, bump `version` in `.claude-plugin/plugin.json`, commit, push. On other machines: `git pull` + re-run setup if deps changed.

## License

Copyright (C) 2026 bubune99 / FAR CNCPT.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3. It is distributed WITHOUT ANY WARRANTY; see [LICENSE](LICENSE) for the full text, including the Section 13 network-use provision.

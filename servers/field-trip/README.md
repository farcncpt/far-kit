# Farxplor

**AI-guided web navigation — a spotlight overlay and browser-automation agent that lives in your browser.**

Farxplor is a Manifest V3 Chrome extension plus a small toolchain that lets an AI agent *see* and *act on* any web page: scan the DOM, click, type, navigate, run accessibility and layout audits, and guide a human with visual spotlight overlays. The in-browser agent runs a full **observe → act → observe** loop using your own Anthropic API key (BYOK) — no server round-trip required.

> **Status:** early / pre-1.0. Core extension and the local agent loop work today. See [Roadmap](#roadmap) for what's still landing.

---

## What's in this repo

| Component | Path | What it does |
|---|---|---|
| **Chrome extension** | `src/` | Content scripts, service worker, shadow-DOM React UI (the floating pill, spotlight, annotations). Built with Vite + TypeScript + React 19. |
| **Local agent** | `src/background/local-agent.ts` | In-browser agentic loop — runs Claude against your BYOK key, closes the observe→act cycle. |
| **Agent tools** | `src/content/agent-tools/`, `src/content/message-handler.ts` | The action space: scan, click, type, a11y tree, layout audit, visual diff, region describe, session tracking. |
| **WebSocket relay** | `cli/ws-relay.mjs` | Bridges external CLI tools and AI agents to the extension over port `9333`. |
| **MCP server** | `mcp-server/` | Exposes the browser actions as [Model Context Protocol](https://modelcontextprotocol.io) tools so any MCP-capable agent (e.g. Claude Code) can drive the browser. |
| **CLI toolkit** | `cli/` | 60+ Node scripts (`tt.mjs` and friends) for scan / click / type / screenshot / audit from the terminal. |

The hosted dashboard for configuring and managing agents (auth, teams, billing) lives in a **separate** repository and is not part of this open-source release.

---

## Requirements

> ⚠️ **Platform note:** the relay and CLI layer currently shell out through `powershell.exe`, so the terminal tooling targets **Windows with WSL** today. The **Chrome extension and the in-browser local agent run anywhere Chrome runs** — the platform limitation only affects the CLI/relay bridge. Native Linux/macOS support for the CLI is on the [roadmap](#roadmap).

- **Chrome** (or any Chromium browser that loads MV3 unpacked extensions)
- **Node.js** 18+
- **An Anthropic API key** for the local agent (BYOK) — set it in the extension's settings
- For the CLI/relay: **Windows + WSL**

---

## Quick start

### 1. Build and load the extension

```bash
npm install
npm run build          # tsc && vite build → outputs dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `dist/` folder.

### 2. Use the in-browser agent (no CLI needed)

1. Open the extension's side panel.
2. Add your Anthropic API key in settings (stored locally in `chrome.storage`, never sent to any server).
3. Type an instruction (e.g. *"find the pricing page and tell me the cheapest plan"*). The agent scans the page, acts, re-observes, and streams its reasoning back to you.

### 3. (Optional) Drive the browser from the terminal or an MCP agent

Start the relay, then use the CLI:

```bash
node cli/ws-relay.mjs               # start the relay on port 9333 (keep running)
node cli/tt.mjs --relay scan        # list interactive elements on the active tab
node cli/tt.mjs --relay click "Submit"
```

Or register the MCP server with an MCP-capable agent:

```bash
claude mcp add farxplor node /path/to/farxplor/mcp-server/index.mjs
```

The MCP server auto-resolves the repo location; override with `FIELD_TRIP_HOME` if needed.

---

## How it fits together

```
┌─────────────┐   BYOK key    ┌──────────────────┐
│  You (chat) │──────────────▶│  Local agent     │  (src/background/local-agent.ts)
└─────────────┘               │  observe→act loop│
                              └───────┬──────────┘
                                      │ EXECUTE_TOOL
                                      ▼
                              ┌──────────────────┐
                              │ Content script   │  (message-handler.ts + agent-tools/)
                              │ click/type/scan/ │
                              │ a11y/visual/…    │
                              └──────────────────┘

  External agents / CLI ──ws:9333──▶ Relay ──▶ Extension  (same action space)
  MCP agents ──stdio──▶ mcp-server/ ──▶ CLI ──▶ Relay ──▶ Extension
```

---

## Roadmap

- **Cross-platform CLI/relay** — remove the `powershell.exe` dependency so the terminal tooling runs natively on Linux/macOS.
- **Full tool schema** — expose the complete agent action space (a11y, visual-diff, session-state, tab-health) to the model, not just the core navigation subset.
- **Multi-agent coordination** — activate the agent-com bridge for cross-tab agent collaboration.
- **Chrome Web Store** packaging.

---

## Contributing

Contributions are welcome. Please open an issue to discuss substantial changes before submitting a PR. (A `CONTRIBUTING.md` with dev-setup details is coming.)

## License

[Apache License 2.0](./LICENSE) © 2026 Farxplor.

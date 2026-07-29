---
name: Field Trip Relay & MCP Server
description: WebSocket relay bridge connecting CLI tools and AI agents to the Chrome extension. The `mcp__field-trip__browser` tool wraps the entire relay as single-call browser actions — multi-tab control, annotations, dynamic CLI tool execution.
when_to_use: browser automation, relay, field-trip, scan, click, type, navigate, annotations, MCP browser tool, PowerShell relay, tt.mjs, when interacting with live web pages, verifying deployed UIs, cataloging DOM
source: joyride-web-extension/src/skills/field-trip-relay.json v1.0.0
---

# Field Trip Relay & MCP Server

The Field Trip relay is how Claude Code controls real Chrome tabs. A WebSocket bridge connects the AI agent (WSL) → MCP server (WSL) → PowerShell → `tt.mjs` CLI → WebSocket relay → Chrome extension → content script → DOM.

**The primary entry point is `mcp__field-trip__browser`.** This single MCP tool wraps every browser action — use it before falling back to PowerShell CLI calls.

## Architecture

- **Relay server:** `node cli/ws-relay.mjs` (runs on Windows, port 9333)
- **MCP server:** `node mcp-server/index.mjs` (runs in WSL, bridges via PowerShell)
- **Extension:** Offscreen document maintains WebSocket connection to relay

Flow: `AI Agent → MCP Server → PowerShell → tt.mjs CLI → WebSocket relay → Chrome Extension → Content Script → DOM`

## Setup (one-time)

1. Start relay: `node cli/ws-relay.mjs` (in PowerShell on Windows)
2. Connect extension: Click Field Trip extension icon → Connect
3. Register MCP: `claude mcp add field-trip node /mnt/c/Users/bubun/CascadeProjects/joyride-web-extension/mcp-server/index.mjs`

## The `browser` Tool — Primary Interface

Single MCP tool wrapping every relay browser action:

```
mcp__field-trip__browser({ action, params })
```

### Actions

| Action | Purpose | Params |
|--------|---------|--------|
| `page` | Get current tab title + URL | `{ tabId? }` |
| `scan` | List interactive elements | `{ maxItems?, tabId? }` |
| `find` | Find element by text | `{ text, tabId? }` |
| `click` | Click element | `{ target, tabId? }` |
| `type` | Type text (React-compatible via tt-type.mjs) | `{ selector, value, tabId? }` |
| `spotlight` | Highlight with caption overlay | `{ selector, caption?, tabId? }` |
| `navigate` | Go to URL | `{ url, tabId? }` |
| `eval` | Run JS in page, return value | `{ expression, tabId? }` |
| `read` | Read element text/attrs | `{ selector, tabId? }` |
| `scroll` | Scroll to element | `{ selector, tabId? }` |
| `screenshot` | Capture viewport or element | `{ output?, selector?, caption? }` |
| `tabs` | List browser tabs (annotated with `owner`/`ownerSource`) | `{}` |
| `activate` | Make a tab active — ONLY allowed on tabs you own; in your own window it does not steal user focus | `{ tabId }` |
| `reload` | Reload tab | `{ tabId? }` |
| `new_tab` | Open new tab — **auto-claims it for you**; the default way to get a workspace | `{ url?, window_id? }` |
| `new_window` | Open your OWN Chrome window (unfocused) — you own it and every tab you create inside | `{ url? }` |
| `claim_tab` / `release_tab` / `list_claims` | Explicit tab ownership management | `{ tabId }` |
| `grant_tab` | Record a USER grant of a tab to an agent (outranks agent claims; used by the pill) | `{ tabId }` |
| `list_agents` | Live agents on the relay (socket-derived: name, kind, owned tabs, queue depths) | `{}` |
| `tab_activity` | Classify a tab: `user` / `agent` / `collab` / `idle` — consult before touching any unclaimed tab | `{ tabId }` |
| `wait` | Pause | `{ ms? }` |
| `annotations` | Read/write page annotations | `{ action: list\|get\|save\|delete\|workflows }` |
| `batch` | Run commands in sequence | `{ commands: [{action, params}] }` |

### Real Screenshots (`screenshot`)

Returns **actual pixels as MCP image content** — not a file path, not synthetic description. This is the only action I have that gives me genuine vision.

```
mcp__field-trip__browser({ action: "screenshot" })
// → MCP image content: I see the viewport
mcp__field-trip__browser({ action: "screenshot", params: { selector: "[data-testid='card']" } })
// → cropped to just that element, HiDPI-aware
mcp__field-trip__browser({ action: "screenshot", params: { format: "jpeg", quality: 80 } })
// → smaller payload for full-page captures
```

**Gotchas:**
- Capture works on the **active tab of a window** — but activating a tab in a SHARED window steals the user's screen. **Need pixels? `new_window` first**, `activate` tabs inside it freely (it stays unfocused, the user keeps working), then capture. Never `activate` in a window you don't own; the relay will reject it anyway.
- Throttled to ~2 captures/sec per window. For many element crops, take one viewport capture and crop multiple elements in the same burst.
- Captures only the visible viewport. For off-screen elements, `scroll_to` first.
- When to use: visual regressions, aesthetic issues, anything that synthetic `describe_region` can't catch ("the labels visually overlap" / "this looks cramped").

### Agent-Tools Native Actions

Every page automatically gets `window.__agentTools` installed by the content script (since the extension rebuild dated 2026-04-14). These give the agent native reasoning capabilities without needing `eval` injection.

| Action | Purpose | Params |
|--------|---------|--------|
| `arrive` | Install observers + read session state | `{ tabOwner?, tabId? }` |
| `quick_scan` | One-shot health check (a11y/layout/visual counts + top issues) | `{ tabId? }` |
| `a11y_tree` | Reconstructed accessibility tree with roles + names | `{ selector?, tabId? }` |
| `a11y_issues` | Find missing labels, alt text, accessible names | `{ tabId? }` |
| `describe_region` | Structured "what does this look like" for an element (synthetic vision) | `{ selector, tabId? }` |
| `layout_audit` | Find overlaps, overflow, viewport-clipped elements, tiny text | `{ tabId? }` |
| `clickable_check` | Diagnose whether an element is truly clickable + why not | `{ selector, tabId? }` |
| `visual_snapshot` | Take a named snapshot for later diffing | `{ name, selector?, tabId? }` |
| `visual_diff` | Structured diff vs a named snapshot (added/removed/moved/resized/styled/text) | `{ name, tabId? }` |
| `changes_since` | Read DOM mutation ring buffer (mutations + console errors + network fails) | `{ since?, limit?, kinds?, tabId? }` |
| `tab_health` | Navigation/popup/error incidents since monitor install | `{ since?, tabId? }` |
| `session_state` | Persistent task session across eval calls | `{ op: "get"\|"start"\|"note"\|"observe"\|"next"\|"end", ... }` |

**Workflow: start every browser session with `arrive`.**
```
mcp__field-trip__browser({ action: "arrive", params: { tabOwner: "my-agent" } })
```
Returns URL, title, existing session (if any), tab health, and a recent-changes count.

**When something on the page looks wrong:**
```
mcp__field-trip__browser({ action: "quick_scan" })
// → { elementCount, layoutIssues, a11yIssues, collapsed, lowContrast, topIssues }
```

**To catch "what happened after I clicked":**
```
mcp__field-trip__browser({ action: "visual_snapshot", params: { name: "before" } })
// ...click something...
mcp__field-trip__browser({ action: "visual_diff", params: { name: "before" } })
// → { counts, summary, addedSample, removedSample, movedSample }
```

**To reach into React internals or app state:**
Still use `eval` with `window.__agentTools.fiber.findZustandStore(document.body)` — the fiber walker stays eval-only because it can crash content scripts if misused.

## The `tools` MCP Tool — Dynamic CLI Runner

Auto-discovers `.mjs` files in `joyride-web-extension/cli/` and exposes them as sub-commands.

| Action | Purpose |
|--------|---------|
| `run` | Run a CLI tool. Params: `{ script, args?, project? }` |
| `list` | List available CLI tools |
| `help` | Get help for a tool |
| `create` | Create a new CLI tool |
| `binary` | Run a system binary (truth-seeker, etc.) |

### Named shortcuts

```
mcp__field-trip__tools({ action: "security" })   → security-audit.mjs --relay
mcp__field-trip__tools({ action: "pentest" })    → pentest-audit.mjs --relay --safe
mcp__field-trip__tools({ action: "dom_audit" })  → dom-audit.mjs
mcp__field-trip__tools({ action: "headers" })    → header-check.mjs
mcp__field-trip__tools({ action: "code_audit" }) → code-audit.mjs
```

## The `knowledge` MCP Tool — Persistent Tool Learning

Records tool usage across sessions so the knowledge base grows over time.

Actions: `summary`, `search`, `log_use`, `learn`, `get_learnings`, `update`

## Multi-Tab / Multi-Agent Operation (relay-enforced)

Every command accepts a `tabId`. **Always pass one** — a disruptive command with no `tabId` is treated as targeting the user's focused tab and gets rejected.

The relay itself now enforces ownership (this is not just etiquette):
- The **user's focused tab** rejects disruptive verbs (navigate/click/type/eval/reload/activate) from everyone. `allow_user_tab: true` is the explicit per-command escape hatch — pass it ONLY when the user explicitly asked you to act on their tab.
- Tabs **owned by another client** reject your disruptive verbs, with the owner named in the error. Back off; coordinate via agent-com if the work overlaps.
- Commands to one tab run in a **FIFO lane** (cap 20). "Tab queue full — back off and retry" means exactly that; parallelism scales across tabs, not within one.
- **Identify yourself** on connect (`--agent-id` / `FT_AGENT_NAME`) so your claims are stable across one-shot CLI calls and errors name you usefully.

**Decision rule — tab vs window:**
- DOM-only work (scan/eval/click/read) → `new_tab` is enough; it works on background tabs.
- Pixel screenshots, or anything `activate`-dependent → `new_window`, then activate/capture inside it without disturbing anyone.
- Before touching an existing unclaimed tab → `tab_activity` first: `user` or `collab` means hands off (or ask); `agent` means it's another agent's (check `list_agents`); only `idle` unclaimed tabs are fair game, and claiming (`claim_tab`) before use is still the polite move.

The agent-com `tab-ownership` memory remains the higher-level coordination layer for multi-agent sessions; the relay registry is the enforcement layer underneath it.

## Shadow DOM — piercing selectors (built 2026-07-03, branch consumer-local-agent)

`scan`/`find`/`read` pierce open AND closed shadow roots (via `chrome.dom.openOrClosedShadowRoot`, an extension-only power — Playwright can't reach closed roots). Elements inside shadow roots carry `shadowDepth` + `shadowPath`.

**Shadow-path selector = a hop array**, each segment a CSS selector resolved inside the previous segment's shadow root; string form joins segments with ` >>> `:
```
["my-app", "user-card#u42", "button.save"]   ≡   "my-app >>> user-card#u42 >>> button.save"
```
- A **length-1 path is just a flat `querySelector`** — every existing flat selector still works; piercing is the superset.
- Shadow-path is a first-class address type in the annotation/change-record self-healing chain — no separate system.
- **`eval` cannot pierce closed roots** (it runs in the page's MAIN world where `chrome.dom` is undefined). Use the piercing verbs (scan/find/read), never eval, for shadow-nested elements.
- Event capture records `composedPath()[0]` (the real inner target), not the retargeted host — so recorded interactions on component sites are truthful.

## Safety Rules (immutable)

- NEVER kill Chrome or run `Stop-Process`/`taskkill` on browser processes
- ONLY use relay mode (`--relay`) — never direct CDP unless explicitly needed
- Check `chrome-status` and `tab-ownership` in agent-com memory before browser actions
- Max 2 retries on any relay command, then STOP and document the blocker
- Always use PowerShell bridging for CLI commands from WSL (when CLI fallback is needed)

## Fallback — CLI via PowerShell (only when MCP tool errors)

```bash
# Current tab
powershell.exe -NoProfile -Command "cd C:/Users/bubun/CascadeProjects/joyride-web-extension; node cli/tt.mjs --relay page"

# Scan elements
powershell.exe -NoProfile -Command "cd C:/Users/bubun/CascadeProjects/joyride-web-extension; node cli/tt.mjs --relay scan"

# Find by text
powershell.exe -NoProfile -Command "cd C:/Users/bubun/CascadeProjects/joyride-web-extension; node cli/tt.mjs --relay find 'Submit'"
```

## Related skills
- `agent-orchestration` — agent-com protocol for checking chrome-status, tab-ownership, locks
- `field-trip-scanner` — DOM scanning patterns
- `field-trip-annotation` — annotation layer for persistent AI context
- `field-trip-ai-tours` — natural language guided tours via spotlight

# Field Trip Browser Automation

## ALWAYS USE THE MCP TOOL FIRST

The `mcp__field-trip__browser` MCP tool is the **primary** path for any browser interaction. Do not reach for PowerShell, Bash, or `cli/tt.mjs` directly unless the MCP tool is unavailable or explicitly broken.

Why: the MCP tool is one tool call. The shell-out path is 3+ wrappers (bash → powershell → node → ws-relay → extension) that consume tokens, are slower, and break more often.

## MCP Tool Action Reference

```
mcp__field-trip__browser({ action, params })
```

| Action | Purpose | Params |
|--------|---------|--------|
| `page` | Get current tab title + URL | `{}` |
| `scan` | List all interactive elements on page | `{ maxItems? }` |
| `navigate` | Load a URL in the current tab | `{ url }` |
| `click` | Click an element | `{ target }` |
| `type` | Type into input/textarea | `{ selector, value }` |
| `eval` | Run JS in the page (returns value) | `{ expression }` |
| `find` | Find element by text | `{ text }` |
| `read` | Read element text/attrs | `{ selector }` |
| `screenshot` | Capture + save screenshot | `{ output?, selector?, caption? }` |
| `spotlight` | Highlight element with caption | `{ selector, caption? }` |
| `scroll` | Scroll to element | `{ selector }` |
| `tabs` | List all tabs (with `owner` annotations) | `{}` |
| `new_tab` | Open your OWN tab (auto-claimed) — the default workspace for any task | `{ url?, window_id? }` |
| `new_window` | Open your OWN unfocused window — required before pixel screenshots / activate-heavy flows | `{ url? }` |
| `tab_activity` | Classify a tab: user / agent / collab / idle — check before touching unclaimed tabs | `{ tabId }` |
| `list_agents` | Live agents on the relay + their owned tabs | `{}` |
| `annotations` | Read/write page annotations | `{ action: "list"\|"get"\|"save"\|"delete"\|"workflows" }` |
| `batch` | Run commands in sequence | `{ commands: [{action, params}] }` |

### Tab ownership control panel (the USER's surface)

The relay serves an ownership dashboard at `http://localhost:9333/` where the user assigns tabs to agents. A tab granted there carries `ownerSource: "user"` — that grant outranks agent claims, survives your disconnects, and exempts you from the focused-tab gate. **If the user focuses a tab they granted you, keep working — it is still yours.** Never release a user grant because the tab classifies 'user'/'collab'; only the user (or relay restart) revokes it.

### Multi-agent etiquette (relay-ENFORCED — violations are rejected, not just frowned on)

- Work in your own `new_tab`; pass an explicit `tabId` on EVERY command (no-tabId disruptive commands are treated as aimed at the user's focused tab and rejected).
- The user's focused tab and other agents' claimed tabs reject navigate/click/type/eval/reload/activate. `allow_user_tab: true` only when the user explicitly asked you to act on their tab.
- Need screenshots? `new_window` first — `activate` inside your own window doesn't steal the user's focus; `activate` anywhere else is refused.
- Need the user's attention (auth, reload, manual step)? Say it in chat / #alerts — never grab their screen.
- Identify yourself (`--agent-id` / `FT_AGENT_NAME`) so claims persist and errors name you.

### Verification patterns (use these, not ad-hoc JS)

**Check that a specific headline loaded:**
```
mcp__field-trip__browser({
  action: "eval",
  params: { expression: "document.querySelector('h1')?.innerText || 'NO H1'" }
})
```

**Count rendered elements (e.g. course cards, nodes, rows):**
```
mcp__field-trip__browser({
  action: "eval",
  params: { expression: "document.querySelectorAll('[data-slot=\"card\"]').length" }
})
```

**Confirm no console errors:**
```
mcp__field-trip__browser({
  action: "eval",
  params: { expression: "performance.getEntriesByType('navigation').map(e => e.responseStatus)" }
})
```

## Escape Hatches (only when MCP path is unavailable)

Fallback to the CLI only when you've confirmed the MCP tool errored:

```bash
# Check current tab
powershell.exe -NoProfile -Command "cd C:/Users/bubun/CascadeProjects/joyride-web-extension; node cli/tt.mjs --relay page"

# Scan elements
powershell.exe -NoProfile -Command "cd C:/Users/bubun/CascadeProjects/joyride-web-extension; node cli/tt.mjs --relay scan"
```

## Safety Rules (immutable)

- NEVER kill Chrome or run `Stop-Process` / `taskkill`
- ONLY use relay mode — never CDP
- Check chrome-status + locks via agent-com memory before acting
- Max 2 retries on any command, then stop and report
- Always decommission agents (release tabs, locks, unregister)

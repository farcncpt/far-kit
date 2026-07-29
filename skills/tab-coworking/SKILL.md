---
name: Tab Coworking — Respect the Active Tab
description: Rules for coworking with a human user across browser tabs. Agents ALWAYS work in their own tab (new_tab) — the user's active tab and other agents' tabs are off-limits for navigate/click/type/activate. Read-only inspection of the user's tab only when they ask. Covers multi-agent tab isolation, the attention protocol (never grab focus — notify instead), Vercel-per-project tabs, and dev server tab lifecycle.
when_to_use: check active tab, current tab, tab ID, tab ownership, multi-tab coworking, sub-agent tabs, Vercel tab per project, localhost tab, dev server tab, new tab for work, respect user tab, don't override tab, browser tab claim, coworking, tab isolation
source: Bubune's coworking rules, authored 2026-04-14 directly by Claude Code
---

# Tab Coworking — Respect the Active Tab

When the user and Claude (plus sub-agents) are all working in the same browser, tabs are the coordination primitive. The user is always doing their own work — I am NOT the only one in the browser. Before touching any tab, I must check what's already there and what the user is actively using.

**Core rule:** Every agent works in its OWN tab, created via `new_tab`, for the entire task. The user's active tab and any tab another agent owns are off-limits for anything that changes what's on screen — `navigate`, `reload`, `click`, `type`, mutating `eval`, and **`activate` (stealing screen focus counts as disruption)**. The only sanctioned contact with the user's tab is read-only inspection (`page`, `scan`, `read`, read-only `eval`) when the user explicitly asked about "my tab / the active tab". "New work" defaults to "new tab" — no exceptions for convenience.

## The Golden Sequence (run this before ANY browser action)

### 1. List all tabs
```
mcp__field-trip__browser({ action: "tabs" })
```
Returns every open tab with its `tabId`, `title`, `url`, and `active` flag.

### 2. Identify the active tab
```
mcp__field-trip__browser({ action: "page" })
```
Returns the currently-focused tab's title and URL. This is what the user is looking at right now.

### 3. Note the active tab's ID
Store it in your working memory. This is the tab the user is on. If the user says **"check the active tab for work"**, this tabId is the one to use for that work — NOT any other tab.

### 4. Check agent-com for tab ownership (multi-agent sessions)
```
mcp__agent-com__read_memory({ key: "tab-ownership" })
```
Any tabId in here is claimed by another agent. Don't touch it.

### 5. Decide: work on an existing tab or open a new one?

| Situation | What to do |
|-----------|-----------|
| User said "on the active tab" | Use the active tabId from step 2. That's the precedence tab. |
| User said "check my work" without specifying | Use the active tab (step 2). |
| A tab matching my task URL already exists, and nobody owns it | Work in it by explicit `tabId` WITHOUT `activate` — grabbing focus disrupts the user. If it might be the user's browsing (not a tab an agent/dev flow created), leave it alone and `new_tab` instead. |
| I need a dev server / deployment / dashboard the user is NOT currently looking at | **Open a new tab** via `new_tab`, capture the tabId, remember it for the rest of the task |
| I need **pixel screenshots** or any activate-dependent flow | **Open my own WINDOW** via `new_window` — capture needs an active tab, and activating in a shared window steals the user's screen. Inside my own window I can activate/capture freely (it stays unfocused). |
| I'm considering an existing unclaimed tab | `tab_activity` first: `user`/`collab` → hands off (or ask); `agent` → another agent's (see `list_agents`); `idle` → claim it (`claim_tab`) before use |
| Multiple sub-agents are running in parallel | Each gets its own tab via `new_tab` — never share tabs; screenshot-heavy agents get their own window |

## Never Override the Active Tab

These are the actions that can disrupt the user's work — do NOT run them against the user's active tab unless they explicitly said to:

- `navigate` — moves the tab somewhere else
- `reload` — loses unsaved state
- `click` / `type` — modifies what the user is looking at
- `activate` — flips the user's visible tab to something else mid-work. Screenshots requiring an active tab are NOT a justification: either ask first, or capture when the user is idle, or use structured (DOM) perception instead
- mutating `eval` — anything that sets state, dispatches events, or navigates via script

**If the user is working on tab 704449077 and I need to check Vercel:**
- ❌ Wrong: `navigate({ url: "https://vercel.com", tabId: 704449077 })`
- ✅ Right: `new_tab({ url: "https://vercel.com" })` — get a new tabId, work there

**If the user says "check the active tab":**
- ✅ Right: use `mcp__field-trip__browser({ action: "page" })` to get the current tab, then `scan` / `eval` it in place (read-only), never `navigate` it elsewhere unless they asked.

## New Tabs — Capture the ID, Remember It

When I open a fresh tab, I MUST capture the tabId that comes back and use it explicitly for every subsequent action in that task.

```
// Open
const result = mcp__field-trip__browser({ action: "new_tab", params: { url: "https://op-phi-two.vercel.app" } })
// result.tabId is the one to remember

// Every subsequent action MUST pass that tabId
mcp__field-trip__browser({ action: "scan", params: { tabId: <that_id> } })
mcp__field-trip__browser({ action: "eval", params: { tabId: <that_id>, expression: "..." } })
```

Without an explicit `tabId`, the MCP tool defaults to the active tab — which may no longer be the one I was working on. Always be explicit.

## Attention Protocol — Never Grab Focus, Notify Instead

When an agent needs the user (sign-in, extension reload, permission, a manual step, or "come look at this"):

1. **Do NOT** `activate` a tab, `navigate` their tab, or otherwise commandeer the screen to get attention.
2. **Do** surface it through channels the user checks on their own schedule:
   - Say it plainly in the chat response (primary — the user reads agent output)
   - `PushNotification` when the harness supports it and the user would act NOW
   - `mcp__agent-com__publish_to_channel({ channel: "#alerts", ... })` for multi-agent sessions
3. If visual pointing helps, `spotlight` an element **in the agent's own claimed tab** and mention it — the user chooses when to switch.
4. If blocked on the user, record the blocker (planner check-in / task status), release shared resources, and continue other work or end the turn. Blocked ≠ license to interrupt.

## Multi-Agent Tab Isolation

When launching sub-agents for parallel work:

1. **One tab per agent.** Never assign two agents to the same tab.
2. **Claim before using.**
   ```
   mcp__agent-com__write_memory({
     key: "tab-ownership.<tabId>",
     value: { owner: "<agent name>", url, claimedAt: <iso> }
   })
   ```
3. **Verify before acting.**
   ```
   mcp__agent-com__read_memory({ key: "tab-ownership.<tabId>" })
   ```
   If owned by someone else, STOP and publish to `#alerts`.
4. **Release on decommission.**
   ```
   mcp__agent-com__delete_memory({ key: "tab-ownership.<tabId>" })
   ```
   Failure to release blocks future agents.

See `agent-orchestration` skill for the full decommission protocol.

## Vercel Troubleshooting — Tab Per Project

When multiple projects are deployed on Vercel, each project deserves its own tab when troubleshooting:

- **Project A dashboard:** tabId X
- **Project A deployment detail:** tabId Y (opened from X)
- **Project B dashboard:** tabId Z (separate, doesn't disrupt X/Y)
- **Project A production URL:** tabId W (for DOM marker verification)

Don't flip a single Vercel tab between projects mid-troubleshoot — you lose context. Open fresh tabs via `new_tab` for each project being investigated, capture each tabId, work in parallel.

If a sub-agent is troubleshooting a specific project's deployment, it should own exactly one Vercel tab for that project and never touch another agent's Vercel tab.

## Local Dev Server Tab Lifecycle

Dev servers (`localhost:3000`, `localhost:5173`, etc.) are finicky and need their own tab management:

### Starting a dev server

1. **Check if a tab already exists** for that port:
   ```
   mcp__field-trip__browser({ action: "tabs" })
   ```
   Look for any tab URL matching `http://localhost:<port>` or `http://127.0.0.1:<port>`.

2. **If tab exists:** reuse it by explicit `tabId` — don't open a duplicate, and don't `activate` it (that steals the user's focus). The existing tab likely already has console history, auth state, and dev tools state the user wants preserved; all relay verbs work on background tabs except pixel screenshots.

3. **If no tab exists:** Start the dev server first (in a background shell), then open a fresh tab pointed at the URL:
   ```
   mcp__field-trip__browser({ action: "new_tab", params: { url: "http://localhost:3000" } })
   ```
   **Capture the tabId immediately** and use it for every subsequent action in this task.

4. **Register the dev server tab in agent-com:**
   ```
   mcp__agent-com__write_memory({
     key: "dev-servers.<port>",
     value: { tabId, url, pid, startedAt, ownerAgent }
   })
   ```
   So other agents (and future sessions) know which tab owns which dev server.

### Stopping / restarting a dev server

- Never kill the process while the user is still interacting with the tab. Check `tab-ownership` first.
- If the tab is owned by another agent, acquire a restart lock before touching it (see `agent-orchestration` → "Before disruptive actions").
- After restart, re-register in `dev-servers.<port>`.

## Common Mistakes I Must Avoid

- ❌ **Navigating the active tab** without asking when the user said "check what's on the active tab" (that's read-only, they wanted me to inspect where they are, not move them elsewhere)
- ❌ **Opening a duplicate tab** when one already exists for that URL
- ❌ **Using tools without passing `tabId`** after opening a new tab, so the next action targets whatever becomes active
- ❌ **Assuming the "current" tab is mine** — it almost certainly belongs to the user
- ❌ **Running `reload` on the user's active tab** to "refresh state" — they lose unsaved work
- ❌ **Running multiple concurrent actions against the same tab** from different agents — use agent-com locks
- ❌ **Forgetting to release `tab-ownership` on decommission** — stale claims block future agents

## Quick Decision Tree

```
User says "check the active tab"
  → page() → remember tabId → scan/eval in place (read-only)
    → do NOT navigate unless asked

User says "verify the deploy"
  → Is there already a tab on the target URL? (tabs())
    → Yes → verify in place by explicit tabId (no activate)
    → No → new_tab(target URL) → capture tabId → verify

Sub-agent spawned for project X troubleshooting
  → Check agent-com tab-ownership for X → no existing?
    → new_tab(X's URL) → claim in agent-com → work → release on exit

Dev server needed for http://localhost:3000
  → tabs() → find localhost:3000 tab?
    → Yes → use by explicit tabId (no activate) → register in dev-servers.3000
    → No → start server → new_tab(localhost:3000) → capture tabId → register

Agent needs the user (auth / reload / manual step)
  → say it in chat + #alerts / PushNotification
  → NEVER activate or navigate the user's tab to force attention
```

## Related skills
- `field-trip-relay` — the MCP tool this skill uses throughout
- `agent-orchestration` — the full tab-ownership protocol and decommission rules
- `field-trip-scanner` — for verification work on a claimed tab

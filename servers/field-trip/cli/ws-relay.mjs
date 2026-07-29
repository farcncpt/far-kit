#!/usr/bin/env node
/**
 * ws-relay.mjs — Local WebSocket relay server that bridges CLI tools and the
 * Field Trip Chrome extension. Eliminates the need for --remote-debugging-port.
 *
 * Architecture:
 *   CLI (Node.js) ←WebSocket→ This Relay ←WebSocket→ Extension Relay Page
 *
 * The extension relay page (src/relay/index.html) connects as a special
 * "extension" client. CLI tools connect as regular clients. The relay routes
 * commands from CLI → extension and results from extension → CLI.
 *
 * Usage:
 *   node cli/ws-relay.mjs                    # default port 9333
 *   RELAY_PORT=9444 node cli/ws-relay.mjs    # custom port
 *
 * Protocol:
 *   CLI → Relay → Extension:
 *     { id: string, type: "command", command: { action: string, params: {...} } }
 *
 *   Extension → Relay → CLI:
 *     { id: string, type: "result", data: any, error?: string }
 *
 *   Extension identifies itself on connect:
 *     { type: "register", role: "extension" }
 *
 *   CLI tools identify themselves on connect:
 *     { type: "register", role: "cli", name?: string }
 */

import { WebSocketServer } from "ws"
import http from "node:http"

const PORT = parseInt(process.env.RELAY_PORT || "9333")

/** How often to ping the extension (ms). 20s is short of typical TCP idle. */
const HEARTBEAT_MS = parseInt(process.env.RELAY_HEARTBEAT_MS || "20000")
/** Max age of a pending CLI request before we time it out (ms). */
const REQUEST_TIMEOUT_MS = parseInt(process.env.RELAY_REQUEST_TIMEOUT_MS || "30000")
/** How often to sweep pending requests for expirations. */
const SWEEP_MS = 1000

/** Max queued (not yet dispatched) commands per tab before rejecting. */
const TAB_QUEUE_CAP = parseInt(process.env.RELAY_TAB_QUEUE_CAP || "20")

// HTTP server carries both the WS upgrade (agents/extension) and the tab
// ownership control panel (the human's surface — see handleHttpRequest below).
const httpServer = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    try {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    } catch {}
  })
})

httpServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[ws-relay] Port ${PORT} is already in use — another relay instance is running. Exiting.`)
    process.exit(2)
  }
  console.error("[ws-relay] Server error:", err.message)
})

const wss = new WebSocketServer({ server: httpServer })

wss.on("error", (err) => {
  console.error("[ws-relay] Server error:", err.message)
})

httpServer.listen(PORT)

/** @type {import('ws').WebSocket | null} */
let extensionSocket = null

/**
 * Pending request tracking, keyed by the RELAY-NAMESPACED id.
 * Each CLI connection gets a unique client number; its command ids are
 * rewritten to `c<n>:<originalId>` before forwarding so two clients using
 * identical ids (e.g. both start counters at 1) can never cross-wire.
 * @type {Map<string, { cliSocket: import('ws').WebSocket, sentAt: number, originalId: string, queueKey: string, dispatched: boolean }>}
 */
const pendingRequests = new Map()

/** @type {Set<import('ws').WebSocket>} */
const cliSockets = new Set()

/** Monotonic client counter for id namespacing. */
let clientCounter = 0

/**
 * Stable-identity map: a client that passes a `clientKey` (e.g. a persistent
 * agent id) keeps the SAME clientNo across reconnects, so its tab claims
 * survive the one-shot CLI pattern (each `tt.mjs` call is a fresh socket).
 * @type {Map<string, number>}
 */
const clientKeyToNo = new Map()

/**
 * Per-client registration record, set at register time.
 * @type {WeakMap<import('ws').WebSocket, { clientNo: number, agentName: string, kind: string, sessionId: string|null, connectedAt: number }>}
 */
const clientInfo = new WeakMap()

/**
 * Persistent roster of every agent identity seen this relay lifetime.
 * One-shot CLI agents (each tt.mjs call = fresh socket) are usually
 * DISCONNECTED between commands, so the control panel's grant targets must
 * come from this roster, not from live sockets.
 * @type {Map<number, { agentName: string, kind: string, lastSeen: number }>}
 */
const knownAgents = new Map()

/** Is any live socket registered under this client number? */
function isClientConnected(clientNo) {
  for (const s of cliSockets) {
    if (s.readyState === 1 && clientInfo.get(s)?.clientNo === clientNo) return true
  }
  return false
}

/**
 * Per-tab FIFO command queues. Commands targeting the same tab execute one at
 * a time (a second agent's click can't interleave mid-command); commands for
 * different tabs run in parallel. Commands with no tabId share the "__active__"
 * lane, since they all act on whatever tab is focused.
 * @type {Map<string, { inFlight: string | null, queue: Array<{ relayId: string, wire: string }> }>}
 */
const tabQueues = new Map()

function queueKeyFor(msg) {
  const tabId = msg?.command?.tabId
  return tabId === undefined || tabId === null ? "__active__" : String(tabId)
}

/** Dispatch the next queued command for a tab lane, if the lane is idle. */
function dispatchNext(key) {
  const q = tabQueues.get(key)
  if (!q) return
  if (q.inFlight !== null) return
  const item = q.queue.shift()
  if (!item) {
    tabQueues.delete(key)
    return
  }
  const entry = pendingRequests.get(item.relayId)
  if (!entry) {
    // Timed out / client vanished while queued — skip to the next one.
    dispatchNext(key)
    return
  }
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    failEntry(item.relayId, "Extension relay page disconnected")
    dispatchNext(key)
    return
  }
  q.inFlight = item.relayId
  entry.dispatched = true
  // Restart the timeout clock at dispatch: REQUEST_TIMEOUT_MS measures how
  // long the EXTENSION takes to answer, not how long the command sat queued
  // behind earlier commands on the same tab.
  entry.sentAt = Date.now()
  // Activity signal: this tab just received an agent command.
  if (entry.targetTab != null) tabAgentActivity.set(String(entry.targetTab), Date.now())
  extensionSocket.send(item.wire)
}

/** Complete an in-flight/queued entry with an error result to its CLI. */
function failEntry(relayId, error) {
  const entry = pendingRequests.get(relayId)
  if (!entry) return
  pendingRequests.delete(relayId)
  if (entry.cliSocket.readyState === 1) {
    try {
      entry.cliSocket.send(JSON.stringify({ id: entry.originalId, type: "result", data: null, error }))
    } catch {}
  }
}

/** Mark a lane free after its in-flight command finished (result or timeout). */
function laneComplete(relayId, queueKey) {
  const q = tabQueues.get(queueKey)
  if (q && q.inFlight === relayId) {
    q.inFlight = null
    dispatchNext(queueKey)
  }
}

// ─── Tab ownership registry ────────────────────────────────────────────────
// So one agent physically cannot drive a tab another agent (or the user) owns.
// A tab is claimed by a client NUMBER (the same identity used for id
// namespacing). Claims survive a brief disconnect (reconnect grace) then expire.

/** Grace window to keep a claim alive after the owning client disconnects. */
const CLAIM_GRACE_MS = parseInt(process.env.RELAY_CLAIM_GRACE_MS || "60000")
/** TTL for the cached "which tab does the user have focused" answer. */
const FOCUSED_TTL_MS = parseInt(process.env.RELAY_FOCUSED_TTL_MS || "1500")

/**
 * tabId(string) → claim record.
 *   clientNo       — owning client (0 for user grants, which outlive clients)
 *   agentName      — human label for errors ("owned by relay-stabilizer")
 *   source         — 'auto' (new_tab) | 'agent' (claim_tab) | 'user' (grant_tab)
 *   claimedAt      — ms
 *   disconnectedAt — ms the owner's last socket closed, or null. 'user' grants
 *                    ignore this (they persist until revoked / relay restart).
 * A claim reserves the tab for its owner until reaped (grace expiry). 'user'
 * grants are exempt from the focused-tab gate — an explicit grant IS consent.
 * @type {Map<string, { clientNo: number, agentName: string, source: 'auto'|'agent'|'user', claimedAt: number, disconnectedAt: number|null }>}
 */
const tabClaims = new Map()

/** Verbs that only READ — never gated, safe on any tab incl. the user's. */
const SAFE_VERBS = new Set([
  "page", "scan", "read", "tabs", "list_tabs", "tab_info", "find", "list_frames",
  "screenshot", "capture_tab", "spotlight", "wait", "wait_ms", "status",
  // agent-tools observational actions
  "arrive", "quick_scan", "a11y_tree", "a11y_issues", "describe_region",
  "layout_audit", "clickable_check", "visual_snapshot", "visual_diff",
  "changes_since", "tab_health", "session_state",
  // server-handled control/presence verbs (never reach the gate anyway)
  "claim_tab", "release_tab", "list_claims", "grant_tab", "list_agents", "tab_activity",
])

/** Ownership control verbs handled entirely in the relay (never forwarded). */
const OWNERSHIP_VERBS = new Set(["claim_tab", "release_tab", "list_claims", "grant_tab", "list_agents", "tab_activity"])

function isDisruptive(action) {
  return !SAFE_VERBS.has(action)
}

/**
 * Window ownership: a client that owns a window owns every tab inside it.
 * windowId(string) → same claim shape as tabClaims.
 * @type {Map<string, { clientNo: number, agentName: string, source: 'auto'|'agent'|'user', claimedAt: number, disconnectedAt: number|null }>}
 */
const windowClaims = new Map()

/**
 * Last known window per tab — learned from new_tab/new_window results,
 * refreshed opportunistically from every tabs/list_tabs result payload.
 * @type {Map<string, string>} tabId → windowId
 */
const tabWindows = new Map()

/** Effective owner of a tab: its direct claim, else its window's claim. */
function getOwner(tabId) {
  if (tabId == null) return undefined
  const direct = tabClaims.get(String(tabId))
  if (direct) return direct
  const winId = tabWindows.get(String(tabId))
  return winId != null ? windowClaims.get(winId) : undefined
}

function claimWindow(windowId, clientNo, agentName, source = "auto") {
  if (windowId == null) return
  windowClaims.set(String(windowId), {
    clientNo,
    agentName: agentName || `c${clientNo}`,
    source,
    claimedAt: Date.now(),
    disconnectedAt: null,
  })
}

// ─── Tab activity classification ────────────────────────────────────────────
// 'user'   — recent human attention · 'agent' — claimed and/or recent relay
// commands · 'collab' — both within the window · 'idle' — neither.
// Human-activity is APPROXIMATED from focused-tab history: the server samples
// the focused tab on gate lookups plus a periodic poll. Focus ≠ interaction,
// but it's cheap and needs no content-script hook (which would require an
// extension rebuild+reload to even exist).
const ACTIVITY_WINDOW_MS = parseInt(process.env.RELAY_ACTIVITY_WINDOW_MS || "120000")
const FOCUS_POLL_MS = parseInt(process.env.RELAY_FOCUS_POLL_MS || "10000")

/** @type {Map<string, number>} tabId → last relay command dispatched to it */
const tabAgentActivity = new Map()
/** @type {Map<string, number>} tabId → last time observed as the focused tab */
const tabUserActivity = new Map()

function classifyTab(tabId) {
  const key = String(tabId)
  const now = Date.now()
  const lastUser = tabUserActivity.get(key) ?? 0
  const lastAgent = tabAgentActivity.get(key) ?? 0
  const isFocusedNow = focusedTabCache.tabId != null && String(focusedTabCache.tabId) === key
  const userRecent = isFocusedNow || now - lastUser < ACTIVITY_WINDOW_MS
  const agentRecent = now - lastAgent < ACTIVITY_WINDOW_MS || getOwner(tabId) !== undefined
  if (userRecent && agentRecent) return "collab"
  if (userRecent) return "user"
  if (agentRecent) return "agent"
  return "idle"
}

function claimTab(tabId, clientNo, agentName, source = "agent") {
  if (tabId == null) return
  tabClaims.set(String(tabId), {
    clientNo,
    agentName: agentName || `c${clientNo}`,
    source,
    claimedAt: Date.now(),
    disconnectedAt: null,
  })
}

/** Label used in ownership errors: agent name if known, else c<n>. */
function ownerLabel(claim) {
  return claim.source === "user" ? `the user (granted)` : (claim.agentName || `c${claim.clientNo}`)
}

function fmtTime(ms) {
  // HH:MM:SS in local time, avoiding a Date dependency mismatch in tests
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Reap claims whose owner disconnected longer than the grace window ago.
 *  'user' grants never expire on disconnect — only revoke or relay restart. */
function reapExpiredClaims() {
  const cutoff = Date.now() - CLAIM_GRACE_MS
  for (const registry of [tabClaims, windowClaims]) {
    for (const [id, claim] of registry) {
      if (claim.source === "user") continue
      if (claim.disconnectedAt !== null && claim.disconnectedAt < cutoff) {
        registry.delete(id)
      }
    }
  }
}

// ─── Focused-tab detection (the user's active tab) ─────────────────────────
// Asks the extension chrome.tabs.query({active,lastFocusedWindow}). Cached so
// the gate doesn't spam a round-trip per command. Internal ids use the
// "__internal:" prefix and are intercepted before normal result routing.

let focusedTabCache = { tabId: null, windowId: null, at: 0 }
let focusedInflight = null
/** @type {Map<string, (data:any)=>void>} */
const internalPending = new Map()

function getFocusedTab() {
  if (Date.now() - focusedTabCache.at < FOCUSED_TTL_MS) {
    return Promise.resolve(focusedTabCache)
  }
  if (focusedInflight) return focusedInflight
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return Promise.resolve(focusedTabCache)
  }
  const id = `__internal:focused:${Date.now()}`
  focusedInflight = new Promise((resolve) => {
    const timer = setTimeout(() => {
      internalPending.delete(id)
      focusedInflight = null
      resolve(focusedTabCache) // fall back to stale rather than block the gate
    }, 3000)
    internalPending.set(id, (data) => {
      clearTimeout(timer)
      focusedInflight = null
      if (data && typeof data.tabId === "number") {
        focusedTabCache = { tabId: data.tabId, windowId: data.windowId ?? null, at: Date.now() }
        // Every focused-tab sample doubles as a human-attention observation.
        tabUserActivity.set(String(data.tabId), Date.now())
        if (data.windowId != null) tabWindows.set(String(data.tabId), String(data.windowId))
      }
      resolve(focusedTabCache)
    })
    // Prefer the dedicated verb; relay-handler falls back to list_tabs-derived
    // detection so this still works before the extension is reloaded when the
    // user has a single window.
    extensionSocket.send(JSON.stringify({ id, type: "command", command: { action: "focused_tab", params: {} } }))
  })
  return focusedInflight
}

let internalSeq = 0
/**
 * Ask the extension to run a command on the relay's own behalf (no CLI client
 * involved). Used by the control panel to list tabs. Rejects if the extension
 * is down or doesn't answer within timeoutMs.
 */
function internalCommand(action, params = {}, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      return reject(new Error("Extension relay page not connected"))
    }
    const id = `__internal:${action}:${++internalSeq}:${Date.now()}`
    const timer = setTimeout(() => {
      internalPending.delete(id)
      reject(new Error(`${action} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    internalPending.set(id, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
    extensionSocket.send(JSON.stringify({ id, type: "command", command: { action, params } }))
  })
}

/**
 * Annotate a raw extension tab listing with ownership + activity class, and
 * refresh the tab→window map (window claims then cover page-opened tabs).
 * Shared by the CLI list_tabs/tabs result path and the control panel.
 */
function annotateTabs(data) {
  if (!Array.isArray(data)) return data
  return data.map((t) => {
    if (t.id != null && t.windowId != null) tabWindows.set(String(t.id), String(t.windowId))
    const owner = getOwner(t.id)
    const activity = classifyTab(t.id)
    return {
      ...t,
      activity,
      ...(owner ? { owner: owner.agentName, ownerClient: `c${owner.clientNo}`, ownerSource: owner.source, claimedAt: owner.claimedAt } : {}),
    }
  })
}

/** Send an error result for a CLI command that was rejected pre-dispatch. */
function rejectCmd(ws, msg, error) {
  ws.send(JSON.stringify({ id: msg.id, type: "result", data: null, error }))
}

/** Client identity resolved from the socket's registration record. */
function idOf(ws) {
  const info = clientInfo.get(ws)
  return {
    clientNo: info?.clientNo ?? 0,
    agentName: info?.agentName || `c${info?.clientNo ?? 0}`,
  }
}

/** Tabs currently owned by a given client number. */
function ownedTabsOf(clientNo) {
  const out = []
  for (const [tabId, c] of tabClaims) {
    if (c.clientNo === clientNo) out.push(Number(tabId))
  }
  return out
}

/** Handle claim_tab / release_tab / list_claims / grant_tab / list_agents. */
async function handleOwnershipVerb(ws, msg) {
  const { clientNo, agentName } = idOf(ws)
  const action = msg.command.action
  const params = msg.command.params || {}
  const reply = (data, error) => ws.send(JSON.stringify({ id: msg.id, type: "result", data: data ?? null, error: error ?? null }))

  if (action === "claim_tab") {
    const tabId = params.tabId ?? msg.command.tabId
    if (tabId == null) return reply(null, "claim_tab requires a tabId")
    const owner = getOwner(tabId)
    if (owner && owner.clientNo !== clientNo) {
      return reply(null, `Tab ${tabId} is already owned by ${ownerLabel(owner)} (claimed ${fmtTime(owner.claimedAt)}). Coordinate via agent-com or pick another tab.`)
    }
    // Don't let an agent silently claim the tab the user is looking at.
    if (params.allow_user_tab !== true) {
      const focused = await getFocusedTab()
      if (focused.tabId != null && focused.tabId === tabId && !owner) {
        return reply(null, `Tab ${tabId} is the user's focused tab — refusing to claim it. Use new_tab for your own tab, or pass allow_user_tab:true only if the user asked.`)
      }
    }
    claimTab(tabId, clientNo, agentName, "agent")
    return reply({ claimed: true, tabId, owner: agentName, source: "agent" })
  }

  if (action === "grant_tab") {
    // A user-consented grant (from the pill/UI, or an explicitly authorized
    // caller). Outranks agent claims, exempt from the focused-tab gate, and
    // persists until revoked or relay restart. By default the grant binds to
    // the issuing client; the pill (later) passes grantee_client (a "c<n>" id)
    // to grant a specific agent access to the user's tab.
    const tabId = params.tabId ?? msg.command.tabId
    if (tabId == null) return reply(null, "grant_tab requires a tabId")
    let granteeNo = clientNo
    let granteeName = params.grantee || agentName
    if (typeof params.grantee_client === "string") {
      const m = /^c(\d+)$/.exec(params.grantee_client)
      if (m) {
        granteeNo = parseInt(m[1])
        // Prefer the live agent's registered name for the grant label.
        for (const s of cliSockets) {
          const info = clientInfo.get(s)
          if (info?.clientNo === granteeNo) { granteeName = info.agentName; break }
        }
      }
    }
    claimTab(tabId, granteeNo, granteeName, "user")
    return reply({ granted: true, tabId, owner: granteeName, grantee_client: `c${granteeNo}`, source: "user" })
  }

  if (action === "release_tab") {
    const tabId = params.tabId ?? msg.command.tabId
    if (tabId == null) return reply(null, "release_tab requires a tabId")
    const owner = getOwner(tabId)
    if (!owner) return reply({ released: false, tabId, reason: "not claimed" })
    if (owner.clientNo !== clientNo && owner.source !== "user") {
      return reply(null, `Tab ${tabId} is owned by ${ownerLabel(owner)}, not you — cannot release someone else's claim.`)
    }
    tabClaims.delete(String(tabId))
    return reply({ released: true, tabId })
  }

  if (action === "list_claims") {
    const claims = []
    for (const [tabId, c] of tabClaims) {
      claims.push({ tabId: Number(tabId), owner: c.agentName, source: c.source, claimedAt: c.claimedAt, mine: c.clientNo === clientNo, stale: c.disconnectedAt !== null })
    }
    const window_claims = []
    for (const [windowId, c] of windowClaims) {
      window_claims.push({ windowId: Number(windowId), owner: c.agentName, source: c.source, claimedAt: c.claimedAt, mine: c.clientNo === clientNo, stale: c.disconnectedAt !== null })
    }
    return reply({ claims, window_claims, you: agentName })
  }

  if (action === "tab_activity") {
    const singleTab = params.tabId ?? msg.command.tabId
    const describe = (tabId) => ({
      tabId: Number(tabId),
      activity: classifyTab(tabId),
      last_user_at: tabUserActivity.get(String(tabId)) ?? null,
      last_agent_at: tabAgentActivity.get(String(tabId)) ?? null,
      owner: getOwner(tabId)?.agentName ?? null,
      focused_now: focusedTabCache.tabId != null && String(focusedTabCache.tabId) === String(tabId),
    })
    if (singleTab != null) {
      await getFocusedTab() // freshen the human-attention sample first
      return reply(describe(singleTab))
    }
    await getFocusedTab()
    const known = new Set([
      ...tabClaims.keys(),
      ...tabWindows.keys(),
      ...tabAgentActivity.keys(),
      ...tabUserActivity.keys(),
    ])
    const tabs = [...known].map(describe).sort((a, b) => a.tabId - b.tabId)
    return reply({
      tabs,
      note: "human-activity is approximated from focused-tab samples (server polls; focus ≠ interaction)",
      activity_window_ms: ACTIVITY_WINDOW_MS,
    })
  }

  if (action === "list_agents") {
    // Presence derived purely from live sockets — socket state IS liveness.
    const agents = []
    for (const s of cliSockets) {
      if (s.readyState !== 1) continue
      const info = clientInfo.get(s)
      if (!info) continue
      const queueDepths = {}
      for (const [key, q] of tabQueues) {
        // count this client's queued/in-flight commands per lane
        const mine = q.queue.filter((it) => it.relayId.startsWith(`c${info.clientNo}:`)).length
        if (mine > 0) queueDepths[key] = mine
      }
      agents.push({
        client_id: `c${info.clientNo}`,
        agent_name: info.agentName,
        kind: info.kind || "unknown",
        session_id: info.sessionId || null,
        connected_at: info.connectedAt,
        owned_tabs: ownedTabsOf(info.clientNo),
        queue_depths: queueDepths,
      })
    }
    return reply({ agents, you: `c${clientNo}` })
  }
}

// ─── Control panel (the HUMAN's ownership surface) ──────────────────────────
// Served over plain HTTP on the relay's own port: http://localhost:<PORT>/
// Assigning a tab here issues a 'user'-source grant (same registry as
// grant_tab): explicit consent that outranks agent claims, survives agent
// disconnects, and exempts the grantee from the focused-tab gate — so the
// user can focus a granted tab to verify it WITHOUT the relay re-classifying
// it as theirs and locking the agent out.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > maxBytes) {
        req.destroy()
        return reject(new Error("body too large"))
      }
      chunks.push(c)
    })
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch {
        reject(new Error("invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

async function handleHttpRequest(req, res) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`)
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    res.end(JSON.stringify(obj))
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    return res.end(PANEL_HTML)
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const extUp = extensionSocket !== null && extensionSocket.readyState === 1
    let tabs = []
    let tabsError = null
    if (extUp) {
      try {
        tabs = annotateTabs(await internalCommand("tabs", {}))
        if (!Array.isArray(tabs)) { tabsError = "unexpected tabs payload"; tabs = [] }
      } catch (err) {
        tabsError = err instanceof Error ? err.message : String(err)
      }
    } else {
      tabsError = "Extension relay page not connected"
    }
    const agents = [...knownAgents.entries()]
      .map(([no, a]) => ({
        client_id: `c${no}`,
        agent_name: a.agentName,
        kind: a.kind,
        connected: isClientConnected(no),
        last_seen: a.lastSeen,
        owned_tabs: ownedTabsOf(no),
      }))
      .sort((x, y) => Number(y.connected) - Number(x.connected) || y.last_seen - x.last_seen)
    const window_claims = [...windowClaims.entries()].map(([windowId, c]) => ({
      windowId: Number(windowId),
      owner: c.agentName,
      ownerClient: `c${c.clientNo}`,
      source: c.source,
      claimedAt: c.claimedAt,
      stale: c.disconnectedAt !== null,
    }))
    return json(200, {
      extensionConnected: extUp,
      focusedTab: focusedTabCache.tabId,
      tabs,
      tabsError,
      agents,
      window_claims,
    })
  }

  if (req.method === "POST" && (url.pathname === "/api/grant" || url.pathname === "/api/release")) {
    // The panel is the user's consent surface — only the local machine may use it.
    if (!LOOPBACK.has(req.socket.remoteAddress)) {
      return json(403, { error: "ownership mutations are loopback-only" })
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) })
    }

    if (url.pathname === "/api/grant") {
      const tabId = body.tabId
      const m = /^c(\d+)$/.exec(String(body.grantee_client || ""))
      if (tabId == null || !m) return json(400, { error: "grant requires tabId and grantee_client ('c<n>')" })
      const granteeNo = parseInt(m[1])
      const known = knownAgents.get(granteeNo)
      if (!known) return json(404, { error: `No agent known as c${granteeNo} this relay lifetime` })
      claimTab(tabId, granteeNo, known.agentName, "user")
      console.log(`[ws-relay] Control panel: tab ${tabId} granted to ${known.agentName} (c${granteeNo}) by the user`)
      return json(200, { granted: true, tabId: Number(tabId), owner: known.agentName, grantee_client: `c${granteeNo}`, source: "user" })
    }

    // /api/release — the user may release ANY claim (it's their browser).
    if (body.tabId != null) {
      const had = tabClaims.delete(String(body.tabId))
      if (had) console.log(`[ws-relay] Control panel: tab ${body.tabId} claim released by the user`)
      return json(200, { released: had, tabId: Number(body.tabId) })
    }
    if (body.windowId != null) {
      const had = windowClaims.delete(String(body.windowId))
      if (had) console.log(`[ws-relay] Control panel: window ${body.windowId} claim released by the user`)
      return json(200, { released: had, windowId: Number(body.windowId) })
    }
    return json(400, { error: "release requires tabId or windowId" })
  }

  json(404, { error: "not found" })
}

const PANEL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Field Trip Relay — Tab Ownership</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #16181d; color: #d7dae0;
         font: 14px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  h1 { font-size: 17px; margin: 0 0 4px; letter-spacing: .2px; }
  .sub { color: #8a90a0; font-size: 12.5px; margin-bottom: 18px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.up { background: #47c774; } .dot.down { background: #d95757; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .6px;
       color: #8a90a0; padding: 8px 10px; border-bottom: 1px solid #2a2e38; }
  td { padding: 9px 10px; border-bottom: 1px solid #22252d; vertical-align: middle; }
  tr:hover td { background: #1b1e25; }
  .title { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url { color: #6f7585; font-size: 11.5px; max-width: 380px; overflow: hidden;
         text-overflow: ellipsis; white-space: nowrap; }
  .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11.5px; }
  .a-user   { background: #3d3020; color: #e6b45c; }
  .a-agent  { background: #1f3630; color: #5fd3a5; }
  .a-collab { background: #33283d; color: #c39ae8; }
  .a-idle   { background: #262a33; color: #8a90a0; }
  .own { font-size: 12.5px; }
  .src { color: #6f7585; font-size: 11px; margin-left: 5px; }
  .src.user { color: #e6b45c; }
  .focus-star { color: #e6b45c; margin-left: 4px; }
  select, button { background: #22252d; color: #d7dae0; border: 1px solid #333845;
                   border-radius: 6px; padding: 4px 8px; font-size: 12.5px; }
  button { cursor: pointer; } button:hover { background: #2b2f3a; }
  button.rel { color: #d99; border-color: #4a3038; }
  .agents { margin-top: 26px; }
  .agents h2 { font-size: 13px; color: #8a90a0; text-transform: uppercase; letter-spacing: .6px; }
  .agent-row { padding: 5px 0; font-size: 13px; }
  .agent-row .kind { color: #6f7585; font-size: 11.5px; margin-left: 6px; }
  #toast { position: fixed; bottom: 20px; right: 20px; background: #262b35; color: #d7dae0;
           padding: 10px 16px; border-radius: 8px; border: 1px solid #333845; opacity: 0;
           transition: opacity .25s; pointer-events: none; font-size: 13px; }
  #toast.show { opacity: 1; }
  .note { margin-top: 22px; color: #6f7585; font-size: 12px; max-width: 720px; }
  .err { color: #d99; font-size: 12.5px; margin: 10px 0; }
</style>
</head>
<body>
<h1><span id="extdot" class="dot down"></span>Field Trip Relay — Tab Ownership</h1>
<div class="sub" id="sub">connecting…</div>
<div class="err" id="err" hidden></div>
<table id="tabs-table">
  <thead><tr><th>Tab</th><th>Activity</th><th>Owner</th><th style="width:270px">Assign / Release</th></tr></thead>
  <tbody id="tabs"></tbody>
</table>
<div class="agents"><h2>Agents seen this relay session</h2><div id="agents"></div></div>
<div class="note">
  Assigning a tab issues a <b>user grant</b>: the agent keeps full control of the tab even while
  you focus it to verify — the relay will not reclassify it as yours. Grants persist until you
  release them here (or the relay restarts). Releasing an agent's claim frees the tab for anyone.
</div>
<div id="toast"></div>
<script>
const $ = (id) => document.getElementById(id)
let state = null
let lastJson = ""

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])) }

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show")
  setTimeout(() => t.classList.remove("show"), 2200)
}

function agentOptions(sel) {
  return (state?.agents ?? []).map((a) =>
    '<option value="' + esc(a.client_id) + '"' + (sel === a.client_id ? " selected" : "") + '>' +
    esc(a.agent_name) + " (" + esc(a.client_id) + (a.connected ? "" : " · offline") + ")</option>").join("")
}

function render() {
  if (!state) return
  // Don't yank the DOM out from under an open dropdown.
  if (document.activeElement && document.activeElement.tagName === "SELECT") return
  $("extdot").className = "dot " + (state.extensionConnected ? "up" : "down")
  $("sub").textContent = (state.extensionConnected ? "extension connected" : "extension NOT connected") +
    " · " + (state.tabs?.length ?? 0) + " tabs · " + (state.agents?.length ?? 0) + " agents" +
    (state.focusedTab != null ? " · focused tab " + state.focusedTab : "")
  $("err").hidden = !state.tabsError
  $("err").textContent = state.tabsError ? "tabs list unavailable: " + state.tabsError : ""

  $("tabs").innerHTML = (state.tabs ?? []).map((t) => {
    const focused = state.focusedTab != null && t.id === state.focusedTab
    const ownerCell = t.owner
      ? '<span class="own">' + esc(t.owner) + '<span class="src ' + esc(t.ownerSource) + '">' +
        (t.ownerSource === "user" ? "user grant" : esc(t.ownerSource)) + "</span></span>"
      : '<span class="src">—</span>'
    return "<tr>" +
      '<td><div class="title">' + esc(t.title || "(untitled)") + (focused ? '<span class="focus-star" title="your focused tab">★</span>' : "") +
      '</div><div class="url">' + esc(t.url || "") + "</div></td>" +
      '<td><span class="chip a-' + esc(t.activity || "idle") + '">' + esc(t.activity || "idle") + "</span></td>" +
      "<td>" + ownerCell + "</td>" +
      '<td><select id="sel-' + t.id + '">' + agentOptions(t.ownerClient) + "</select> " +
      '<button onclick="grant(' + t.id + ')">Assign</button>' +
      (t.owner ? ' <button class="rel" onclick="release(' + t.id + ')">Release</button>' : "") +
      "</td></tr>"
  }).join("")

  $("agents").innerHTML = (state.agents ?? []).map((a) =>
    '<div class="agent-row"><span class="dot ' + (a.connected ? "up" : "down") + '"></span>' +
    esc(a.agent_name) + " <span class='kind'>" + esc(a.client_id) + " · " + esc(a.kind) +
    (a.owned_tabs?.length ? " · owns tabs " + a.owned_tabs.join(", ") : "") +
    (a.connected ? "" : " · last seen " + new Date(a.last_seen).toLocaleTimeString()) +
    "</span></div>").join("") || '<div class="agent-row"><span class="src">none yet</span></div>'
}

async function refresh() {
  try {
    const r = await fetch("/api/state")
    const j = await r.json()
    const s = JSON.stringify(j)
    if (s !== lastJson) { lastJson = s; state = j; render() }
  } catch (e) {
    $("sub").textContent = "relay unreachable: " + e.message
  }
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok || j.error) throw new Error(j.error || r.status)
  return j
}

window.grant = async (tabId) => {
  const sel = $("sel-" + tabId)
  if (!sel || !sel.value) return toast("no agent selected")
  try {
    const j = await post("/api/grant", { tabId, grantee_client: sel.value })
    toast("tab " + tabId + " → " + j.owner + " (user grant)")
    lastJson = ""; refresh()
  } catch (e) { toast("grant failed: " + e.message) }
}

window.release = async (tabId) => {
  try {
    await post("/api/release", { tabId })
    toast("tab " + tabId + " released")
    lastJson = ""; refresh()
  } catch (e) { toast("release failed: " + e.message) }
}

refresh()
setInterval(() => { if (!document.hidden) refresh() }, 2500)
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh() })
</script>
</body>
</html>
`

/**
 * Gate + enqueue a CLI command. Rejects disruptive verbs aimed at a tab owned
 * by another client or at the user's focused tab (unless allow_user_tab:true).
 */
async function handleCliCommand(ws, msg) {
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return rejectCmd(ws, msg, "Extension relay page not connected. Open chrome-extension://<id>/src/relay/index.html in Chrome.")
  }

  if (!msg.id) {
    // Fire-and-forget with no id: forward directly, nothing to correlate.
    extensionSocket.send(JSON.stringify(msg))
    return
  }

  const { clientNo, agentName: clientName } = idOf(ws)
  const action = msg?.command?.action
  const explicitTab = msg?.command?.tabId
  const params = msg?.command?.params || {}
  // Explicit per-command escape hatch — never a default.
  const allowUserTab = params.allow_user_tab === true

  // Tab-creating verbs touch no existing tab — exempt from the gate entirely
  // (without this, the no-tabId → focused-tab fallback would absurdly reject
  // new_tab/new_window, the very verbs agents are told to use instead).
  const CREATES_TAB = action === "new_tab" || action === "new_window"

  // …except opening INTO a window someone else owns — that's their workspace.
  if (action === "new_tab" && params.window_id != null) {
    const wOwner = windowClaims.get(String(params.window_id))
    if (wOwner && wOwner.clientNo !== clientNo) {
      return rejectCmd(ws, msg,
        `Window ${params.window_id} is owned by ${ownerLabel(wOwner)} — open your tab in your own window (new_window) instead.`)
    }
  }

  // ── Protected-tab gate (disruptive verbs only) ──
  if (isDisruptive(action) && !CREATES_TAB) {
    // Effective target: the explicit tabId, or (for no-tab commands) whatever
    // tab the user currently has focused — since that's what a no-tab
    // disruptive command would actually hit.
    let targetTab = explicitTab
    let targetIsFocusedFallback = false
    if (targetTab == null) {
      const focused = await getFocusedTab()
      targetTab = focused.tabId
      targetIsFocusedFallback = true
    }

    if (targetTab != null) {
      const owner = getOwner(targetTab)
      // A claim reserves the tab for its owner until reaped (grace expiry),
      // so any existing claim blocks non-owners.
      const mine = owner && owner.clientNo === clientNo
      // A 'user' grant to THIS client is explicit consent → skips the focus gate.
      const userGrantedToMe = owner && owner.source === "user" && owner.clientNo === clientNo

      // (b) owned by someone else → blocked (no focus check needed)
      if (owner && !mine) {
        return rejectCmd(ws, msg,
          `Tab ${targetTab} is owned by ${ownerLabel(owner)} (claimed ${fmtTime(owner.claimedAt)}). ` +
          `Pick another tab (new_tab) or coordinate via agent-com. Pass allow_user_tab:true only if the user explicitly asked you to act on this tab.`)
      }

      // activate hardening: only the owner may activate a tab
      if (action === "activate" && !mine && !allowUserTab) {
        return rejectCmd(ws, msg,
          `activate is restricted to tabs you own. Tab ${targetTab} is ${owner ? `owned by ${ownerLabel(owner)}` : "not claimed by you"}. ` +
          `Use new_tab to get your own tab, or pass allow_user_tab:true only if the user explicitly asked.`)
      }

      // (a) the user's focused tab, and this client neither owns it nor holds a
      //     user grant for it → blocked. A user grant IS consent, so exempt.
      if (!mine && !allowUserTab && !userGrantedToMe) {
        const focused = await getFocusedTab()
        if (focused.tabId != null && focused.tabId === targetTab) {
          const how = targetIsFocusedFallback
            ? `No tabId was given, so this '${action}' would hit the user's focused tab ${targetTab}.`
            : `Tab ${targetTab} is the user's focused tab.`
          return rejectCmd(ws, msg,
            `${how} Create your own tab with new_tab and target that, ` +
            `or pass allow_user_tab:true only if the user explicitly asked you to act on their tab.`)
        }
      }
    }
  }

  // activate policy: default is active-within-window WITHOUT stealing window
  // focus (agent windows stay in the background). Focus the window only when
  // the user explicitly authorized acting on their tab (allow_user_tab) on a
  // tab the caller doesn't own — that's a "bring it up for me" request.
  let outMsg = msg
  if (action === "activate" && params.focus_window === undefined) {
    const own = getOwner(explicitTab)
    const mine = own && own.clientNo === clientNo
    outMsg = { ...msg, command: { ...msg.command, params: { ...params, focus_window: allowUserTab && !mine } } }
  }

  const relayId = `c${clientNo}:${msg.id}`
  const queueKey = queueKeyFor(msg)

  const q = tabQueues.get(queueKey) ?? { inFlight: null, queue: [] }
  if (!tabQueues.has(queueKey)) tabQueues.set(queueKey, q)

  if (q.queue.length >= TAB_QUEUE_CAP) {
    return rejectCmd(ws, msg,
      `Tab queue full (${q.queue.length} commands pending for ${queueKey === "__active__" ? "the active tab" : `tab ${queueKey}`}). Back off and retry.`)
  }

  // Register at ENQUEUE time so the timeout clock covers queue wait too.
  pendingRequests.set(relayId, {
    cliSocket: ws,
    sentAt: Date.now(),
    originalId: msg.id,
    queueKey,
    dispatched: false,
    action,
    clientNo,
    clientName,
    targetTab: explicitTab,
  })
  q.queue.push({ relayId, wire: JSON.stringify({ ...outMsg, id: relayId }) })
  dispatchNext(queueKey)
}

/**
 * Liveness marker per socket. Set true on pong (or any inbound message).
 * Cleared just before each heartbeat ping. If false on the next sweep, the
 * socket is treated as dead and terminated.
 * @type {WeakMap<import('ws').WebSocket, boolean>}
 */
const liveness = new WeakMap()

console.log(`[ws-relay] WebSocket relay server listening on ws://localhost:${PORT}`)
console.log(`[ws-relay] Tab ownership control panel: http://localhost:${PORT}/`)
console.log(`[ws-relay] Open the Field Trip relay page in Chrome:`)
console.log(`[ws-relay]   chrome-extension://<extension-id>/src/relay/index.html`)
console.log(`[ws-relay] Then connect CLI tools to ws://localhost:${PORT}`)
console.log()

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "unknown"
  console.log(`[ws-relay] New connection from ${origin}`)

  // Track whether this socket has registered
  let role = null

  // Mark live on connect; refresh on every inbound frame (incl. pong).
  liveness.set(ws, true)
  ws.on("pong", () => { liveness.set(ws, true) })

  ws.on("message", (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }))
      return
    }

    // ── Registration ──
    if (msg.type === "register") {
      role = msg.role

      if (role === "extension") {
        if (extensionSocket && extensionSocket !== ws) {
          // Multiple extension contexts can briefly coexist during reload
          // or SW respawn. Just track the newest; let the old one drop
          // naturally via its own close handler instead of force-terminating
          // (which caused thrash with multi-path ensureOffscreenRelay calls).
          console.log("[ws-relay] New extension connection — older one will be cleaned up by its close handler")
        }
        extensionSocket = ws
        console.log("[ws-relay] Extension relay page connected")
        ws.send(JSON.stringify({ type: "registered", role: "extension" }))

        // Notify waiting CLI sockets
        for (const cli of cliSockets) {
          if (cli.readyState === 1) {
            cli.send(JSON.stringify({ type: "extension_connected" }))
          }
        }
        return
      }

      if (role === "cli") {
        cliSockets.add(ws)
        // Named handshake: {agent_name, kind, session_id, client_key?}. A
        // stable identity (client_key, else session_id) keeps the same clientNo
        // across reconnects so tab claims survive the one-shot CLI pattern.
        const agentName = msg.agent_name || msg.name || "anonymous"
        const kind = msg.kind || "unknown"
        const sessionId = msg.session_id || null
        const clientKey = msg.client_key || sessionId || null

        const reviveClaims = (no) => {
          for (const registry of [tabClaims, windowClaims]) {
            for (const claim of registry.values()) {
              if (claim.clientNo === no) claim.disconnectedAt = null
            }
          }
        }
        let assignedNo
        if (clientKey && clientKeyToNo.has(clientKey)) {
          assignedNo = clientKeyToNo.get(clientKey)
          reviveClaims(assignedNo)
        } else if (typeof msg.clientNo === "number" && msg.clientNo > 0) {
          assignedNo = msg.clientNo
          reviveClaims(assignedNo)
        } else {
          assignedNo = ++clientCounter
        }
        if (clientKey) clientKeyToNo.set(clientKey, assignedNo)

        clientInfo.set(ws, { clientNo: assignedNo, agentName, kind, sessionId, connectedAt: Date.now() })
        knownAgents.set(assignedNo, { agentName, kind, lastSeen: Date.now() })
        console.log(`[ws-relay] CLI connected: ${agentName} [${kind}] (client #${assignedNo})`)
        ws.send(JSON.stringify({
          type: "registered",
          role: "cli",
          clientNo: assignedNo,
          agentName,
          extensionConnected: extensionSocket !== null && extensionSocket.readyState === 1,
        }))
        return
      }

      ws.send(JSON.stringify({ type: "error", error: `Unknown role: ${role}` }))
      return
    }

    // ── Ownership / presence control verbs (server-handled, never forwarded) ──
    if (msg.type === "command" && role === "cli" && OWNERSHIP_VERBS.has(msg?.command?.action)) {
      handleOwnershipVerb(ws, msg).catch((err) => {
        rejectCmd(ws, msg, `Ownership verb error: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }

    // ── Command from CLI → Extension (namespaced + per-tab FIFO + gate) ──
    if (msg.type === "command" && role === "cli") {
      // handleCliCommand is async (the protected-tab gate may await a
      // focused-tab lookup). Nothing needs to await it here.
      handleCliCommand(ws, msg).catch((err) => {
        rejectCmd(ws, msg, `Relay gate error: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }

    // ── Result from Extension → CLI (map namespaced id back) ──
    if ((msg.type === "result" || msg.type === "eval_result") && role === "extension") {
      // Internal relay-issued lookups (focused tab, etc.) never reach a client.
      if (typeof msg.id === "string" && msg.id.startsWith("__internal:")) {
        const cb = internalPending.get(msg.id)
        if (cb) { internalPending.delete(msg.id); cb(msg.data) }
        return
      }

      const entry = pendingRequests.get(msg.id)
      if (!entry) {
        // Late result after timeout, or unknown id. Never broadcast — a
        // response must only ever reach the client that issued the command.
        console.log(`[ws-relay] Dropping unmatched ${msg.type} for id ${msg.id}`)
        return
      }
      pendingRequests.delete(msg.id)

      let data = msg.data
      // Auto-claim the tab a new_tab created, for the client that created it.
      if (entry.action === "new_tab" && data && typeof data.tabId === "number") {
        claimTab(data.tabId, entry.clientNo, entry.clientName, "auto")
        if (data.windowId != null) tabWindows.set(String(data.tabId), String(data.windowId))
        console.log(`[ws-relay] Tab ${data.tabId} auto-claimed by ${entry.clientName} (c${entry.clientNo})`)
      }
      // Auto-claim BOTH the window and its first tab for new_window — the
      // owner then owns every tab created inside that window (via tabWindows).
      if (entry.action === "new_window" && data && typeof data.windowId === "number") {
        claimWindow(data.windowId, entry.clientNo, entry.clientName, "auto")
        if (typeof data.tabId === "number") {
          claimTab(data.tabId, entry.clientNo, entry.clientName, "auto")
          tabWindows.set(String(data.tabId), String(data.windowId))
        }
        console.log(`[ws-relay] Window ${data.windowId} (tab ${data.tabId}) auto-claimed by ${entry.clientName} (c${entry.clientNo})`)
      }
      // Release the claim on a tab this client just closed.
      if (entry.action === "close_tab" && entry.targetTab != null) {
        tabClaims.delete(String(entry.targetTab))
      }
      // Annotate tab listings with ownership + activity class, and refresh the
      // tab→window map so window ownership covers tabs the page itself opened.
      if ((entry.action === "list_tabs" || entry.action === "tabs") && Array.isArray(data)) {
        data = annotateTabs(data)
      }

      if (entry.cliSocket.readyState === 1) {
        entry.cliSocket.send(JSON.stringify({ ...msg, data, id: entry.originalId }))
      }
      laneComplete(msg.id, entry.queueKey)
      return
    }

    // ── Ping/pong for keepalive ──
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }))
      return
    }

    // ── Status query ──
    if (msg.type === "status") {
      const queues = {}
      for (const [key, q] of tabQueues) {
        queues[key] = { inFlight: q.inFlight !== null, depth: q.queue.length }
      }
      const claims = []
      for (const [tabId, c] of tabClaims) {
        claims.push({ tabId: Number(tabId), owner: c.agentName, ownerClient: `c${c.clientNo}`, source: c.source, claimedAt: c.claimedAt, stale: c.disconnectedAt !== null })
      }
      ws.send(JSON.stringify({
        type: "status",
        extensionConnected: extensionSocket !== null && extensionSocket.readyState === 1,
        cliCount: cliSockets.size,
        pendingRequests: pendingRequests.size,
        tabQueues: queues,
        tabQueueCap: TAB_QUEUE_CAP,
        claims,
        focusedTab: focusedTabCache.tabId,
      }))
      return
    }
  })

  ws.on("close", () => {
    if (ws === extensionSocket) {
      console.log("[ws-relay] Extension relay page disconnected")
      extensionSocket = null

      // Notify CLI sockets
      for (const cli of cliSockets) {
        if (cli.readyState === 1) {
          cli.send(JSON.stringify({ type: "extension_disconnected" }))
        }
      }

      // Fail all pending requests (queued or in flight) and reset lanes
      for (const [id, entry] of pendingRequests) {
        if (entry.cliSocket.readyState === 1) {
          entry.cliSocket.send(JSON.stringify({
            id: entry.originalId,
            type: "result",
            data: null,
            error: "Extension relay page disconnected",
          }))
        }
      }
      pendingRequests.clear()
      tabQueues.clear()
    }

    if (cliSockets.has(ws)) {
      cliSockets.delete(ws)
      const goneNo = clientInfo.get(ws)?.clientNo
      console.log(`[ws-relay] CLI tool disconnected (${cliSockets.size} remaining)`)

      // Don't drop this client's tab claims immediately — mark them for the
      // reconnect grace window so a flaky client can re-adopt them. The sweep
      // reaps them after CLAIM_GRACE_MS ('user' grants never expire). Only mark
      // claims whose owner has NO remaining live socket (sockets can share a
      // clientNo via client_key).
      if (goneNo != null) {
        const known = knownAgents.get(goneNo)
        if (known) known.lastSeen = Date.now()
        const stillConnected = [...cliSockets].some((s) => clientInfo.get(s)?.clientNo === goneNo)
        if (!stillConnected) {
          const now = Date.now()
          for (const registry of [tabClaims, windowClaims]) {
            for (const claim of registry.values()) {
              if (claim.clientNo === goneNo && claim.source !== "user" && claim.disconnectedAt === null) {
                claim.disconnectedAt = now
              }
            }
          }
        }
      }

      // Clean up any pending requests from this socket. Queued (not yet
      // dispatched) entries also come out of their lane's queue; in-flight
      // ones stay until the extension responds or the sweep times them out,
      // at which point laneComplete() frees the lane.
      for (const [id, entry] of pendingRequests) {
        if (entry.cliSocket === ws) {
          if (!entry.dispatched) {
            const q = tabQueues.get(entry.queueKey)
            if (q) q.queue = q.queue.filter((item) => item.relayId !== id)
          }
          pendingRequests.delete(id)
        }
      }
    }
  })

  ws.on("error", (err) => {
    console.error("[ws-relay] Socket error:", err.message)
  })
})

// ── Heartbeat sweep ──
// Every HEARTBEAT_MS:
//   1. For every connected socket, check `liveness` flag.
//      - false (no inbound traffic since last sweep) → terminate.
//      - true  → reset to false, send WS-level ping.
//   2. Sweep pending CLI requests; any older than REQUEST_TIMEOUT_MS gets
//      a synthetic timeout result delivered to its CLI socket.
//
// WS pings/pongs are control frames handled at the protocol layer; the
// `pong` event on the server-side ws is what flips `liveness` back to true.
// If the peer is half-dead, no pong comes → we terminate next round →
// `close` fires → extension reconnects via its onclose handler.
const heartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    const alive = liveness.get(client)
    if (alive === false) {
      console.log("[ws-relay] Terminating unresponsive socket (no pong since last sweep)")
      try { client.terminate() } catch {}
      continue
    }
    liveness.set(client, false)
    try { client.ping() } catch {}
  }
}, HEARTBEAT_MS)
heartbeatTimer.unref?.()

const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - REQUEST_TIMEOUT_MS
  for (const [id, entry] of pendingRequests) {
    if (entry.sentAt < cutoff) {
      console.log(`[ws-relay] Request ${id} timed out after ${REQUEST_TIMEOUT_MS}ms — notifying CLI`)
      if (entry.cliSocket.readyState === 1) {
        try {
          entry.cliSocket.send(JSON.stringify({
            id: entry.originalId,
            type: "result",
            data: null,
            error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms (no response from extension)`,
          }))
        } catch {}
      }
      pendingRequests.delete(id)
      if (entry.dispatched) {
        // The lane was occupied by this command — free it so the queue moves.
        laneComplete(id, entry.queueKey)
      } else {
        const q = tabQueues.get(entry.queueKey)
        if (q) q.queue = q.queue.filter((item) => item.relayId !== id)
      }
    }
  }
  reapExpiredClaims()
}, SWEEP_MS)
sweepTimer.unref?.()

// Periodic focused-tab sample — keeps the human-attention history warm for
// tab_activity classification even when no gate lookups are happening.
const focusPollTimer = setInterval(() => {
  if (extensionSocket && extensionSocket.readyState === 1) {
    getFocusedTab()
  }
}, FOCUS_POLL_MS)
focusPollTimer.unref?.()

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[ws-relay] Shutting down...")
  wss.close()
  process.exit(0)
})

process.on("SIGTERM", () => {
  wss.close()
  process.exit(0)
})

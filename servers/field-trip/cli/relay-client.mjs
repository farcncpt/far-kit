#!/usr/bin/env node
/**
 * relay-client.mjs — Shared WebSocket relay client for CLI tools.
 * Connects to the ws-relay server instead of using CDP directly.
 *
 * Usage (as a library):
 *   import { connectRelay, relayCommand } from './relay-client.mjs'
 *   const relay = await connectRelay()
 *   const result = await relayCommand(relay, 'scan', { maxItems: 120 })
 *   relay.close()
 */

import dns from "node:dns"
// WSL gotcha: the Chrome extension reaches the WSL ws-relay via wslrelay.exe,
// which mirrors the port to Windows on [::1] (IPv6) ONLY — never 127.0.0.1.
// Windows node clients default to IPv4 and hit a different/absent server, so the
// relay looks "connected" in the popup but "not connected" to the client.
// Preferring IPv6 makes every client follow the same path as the extension.
// Override with RELAY_HOST if needed. See docs/RELAY-WSL-CONNECTIVITY.md.
dns.setDefaultResultOrder("ipv6first")

/**
 * Connect to the WebSocket relay server.
 * @param {object} [options]
 * @param {number} [options.port] - Relay server port (default: RELAY_PORT env or 9333)
 * @param {string} [options.name] - CLI tool name for identification
 * @param {number} [options.timeout] - Connection timeout in ms (default: 5000)
 * @returns {Promise<{ ws: WebSocket, send: Function, close: Function }>}
 */
export async function connectRelay(options = {}) {
  const port = options.port ?? parseInt(process.env.RELAY_PORT || "9333")
  const name = options.name ?? "cli-tool"
  const timeout = options.timeout ?? 5000
  // Named handshake: a stable agent identity lets tab claims survive the
  // one-shot CLI pattern (each tt.mjs call is a fresh socket). Supplied via
  // --agent-name/FT_AGENT_NAME (name) + FT_AGENT_ID/FT_SESSION_ID (stable key).
  const agentName = options.agentName ?? process.env.FT_AGENT_NAME ?? name
  const kind = options.kind ?? process.env.FT_AGENT_KIND ?? "cli"
  const sessionId = options.sessionId ?? process.env.FT_SESSION_ID ?? null
  const clientKey = options.clientKey ?? process.env.FT_AGENT_ID ?? sessionId ?? null
  // Candidate hosts, tried in order. On WSL the extension's ws-relay is only
  // reachable from Windows clients via [::1] (IPv6) — wslrelay does not mirror
  // 127.0.0.1 — so `localhost` + Happy-Eyeballs races the dead IPv4 path and
  // flakes. Trying IPv6 first then IPv4 connects deterministically on both WSL
  // and native setups. An explicit host / RELAY_HOST overrides the list.
  const explicitHost = options.host ?? process.env.RELAY_HOST
  const candidates = explicitHost ? [explicitHost] : ["::1", "127.0.0.1"]
  const wsUrl = (h) => `ws://${h.includes(":") ? `[${h}]` : h}:${port}`

  const { WebSocket } = await import("ws")

  /** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map()

  /** @type {boolean} */
  let extensionConnected = false

  /** Try one host; resolve with the registered socket or reject. */
  const tryHost = (h) => new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl(h))
    const timer = setTimeout(() => { reject(new Error("timeout")); sock.close() }, timeout)
    sock.on("open", () => sock.send(JSON.stringify({
      type: "register", role: "cli", name,
      agent_name: agentName, kind, session_id: sessionId, client_key: clientKey,
    })))
    sock.on("error", (err) => { clearTimeout(timer); reject(err) })
    const regHandler = (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type === "registered") {
        clearTimeout(timer)
        sock.off("message", regHandler)
        extensionConnected = msg.extensionConnected
        resolve(sock)
      }
    }
    sock.on("message", regHandler)
  })

  let ws = null
  let lastErr = null
  for (const h of candidates) {
    try { ws = await tryHost(h); break } catch (err) { lastErr = err }
  }
  if (!ws) {
    throw new Error(
      `Cannot connect to relay on port ${port} (tried ${candidates.join(", ")}): ${lastErr?.message ?? "unknown"}\n` +
      `Start the relay with: node cli/ws-relay.mjs`
    )
  }

  // Set up ongoing message handler
  ws.on("message", (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    // Handle results for pending commands
    if ((msg.type === "result" || msg.type === "eval_result") && msg.id) {
      const entry = pending.get(msg.id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(msg.id)
        if (msg.error) {
          entry.reject(new Error(msg.error))
        } else {
          entry.resolve(msg.data)
        }
      }
      return
    }

    // Track extension status
    if (msg.type === "extension_connected") {
      extensionConnected = true
      return
    }
    if (msg.type === "extension_disconnected") {
      extensionConnected = false
      // Fail all pending requests
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error("Extension relay page disconnected"))
      }
      pending.clear()
      return
    }
  })

  let reqCounter = 0
  // Per-connection random tag: two clients connecting in the same millisecond
  // would otherwise generate identical ids (both counters start at 1). The
  // relay server also namespaces ids per client; this is defense in depth.
  const connTag = Math.random().toString(36).slice(2, 8)

  function nextId() {
    return `relay_${Date.now()}_${connTag}_${++reqCounter}`
  }

  /**
   * Send a command through the relay to the extension.
   * @param {string} action - Command action (scan, click, type, spotlight, list_tabs, tab_info, etc.)
   * @param {object} [params] - Command parameters
   * @param {object} [options] - Options
   * @param {number} [options.timeout] - Response timeout in ms (default: 15000)
   * @param {number} [options.tabId] - Target a specific browser tab by ID
   * @returns {Promise<any>}
   */
  function command(action, params = {}, options = {}) {
    const cmdTimeout = options.timeout ?? 15000
    const tabId = options.tabId ?? undefined
    const id = nextId()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Command '${action}' timed out after ${cmdTimeout}ms`))
      }, cmdTimeout)

      pending.set(id, { resolve, reject, timer })

      const cmd = { action, params }
      if (tabId !== undefined) cmd.tabId = tabId

      ws.send(JSON.stringify({
        id,
        type: "command",
        command: cmd,
      }))
    })
  }

  /**
   * List all open non-chrome tabs in the browser.
   * @param {object} [options]
   * @param {number} [options.timeout] - Response timeout in ms (default: 15000)
   * @returns {Promise<Array<{id: number, title: string, url: string, active: boolean, windowId: number}>>}
   */
  function listTabs(options = {}) {
    return command("list_tabs", {}, options)
  }

  /**
   * Get info about a specific tab by ID.
   * @param {number} tabId
   * @param {object} [options]
   * @returns {Promise<{id: number, title: string, url: string, active: boolean, windowId: number, status: string}>}
   */
  function tabInfo(tabId, options = {}) {
    return command("tab_info", {}, { ...options, tabId })
  }

  /**
   * Evaluate arbitrary JavaScript in the page context.
   * Uses chrome.scripting.executeScript in the MAIN world from the background.
   * @param {string} expression - JS expression to evaluate
   * @param {object} [options]
   * @param {number} [options.timeout] - Response timeout in ms (default: 15000)
   * @returns {Promise<any>}
   */
  function evaluate(expression, options = {}) {
    return command("eval", { expression }, options)
  }

  function close() {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error("Connection closed"))
    }
    pending.clear()
    ws.close()
  }

  function isExtensionConnected() {
    return extensionConnected
  }

  return {
    ws,
    command,
    evaluate,
    listTabs,
    tabInfo,
    close,
    isExtensionConnected,
  }
}

/**
 * Convenience wrapper: connect + run a single command + close.
 * @param {string} action
 * @param {object} [params]
 * @param {object} [options]
 * @returns {Promise<any>}
 */
export async function relayOnce(action, params = {}, options = {}) {
  const relay = await connectRelay(options)
  try {
    return await relay.command(action, params)
  } finally {
    relay.close()
  }
}

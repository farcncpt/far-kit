#!/usr/bin/env node
/**
 * ft-bridge.mjs — CLI-side bridge helpers for dispatching commands to the
 * Field Trip extension's content script.
 *
 * Supports two transport modes:
 *   1. CDP mode (default) — via Chrome DevTools Protocol + CustomEvent
 *   2. Relay mode — via WebSocket relay (no CDP needed)
 *
 * CDP mode: The content script (cli-bridge.ts) listens on `document` for
 * '__fieldTrip:command' CustomEvents. Results are written to
 * `document.documentElement.dataset.ftResult_<requestId>` so we can poll.
 *
 * Relay mode: Commands go through ws-relay.mjs → extension relay page →
 * chrome.tabs.sendMessage → content script. No CDP required.
 *
 * Usage (as a library — CDP mode):
 *   import { connect, spotlight, scanStructured, typeReact, clickElement, clearSpotlights } from './ft-bridge.mjs'
 *   const { ws, evaluate } = await connect()
 *   await spotlight(evaluate, '#my-btn', 'Click this button')
 *   const items = await scanStructured(evaluate)
 *   ws.close()
 *
 * Usage (relay mode):
 *   import { connectViaRelay } from './ft-bridge.mjs'
 *   const relay = await connectViaRelay()
 *   await relay.spotlight('#my-btn', 'Click this button')
 *   const items = await relay.scanStructured()
 *   relay.close()
 */

import http from "http"

// ─── CDP Connection ───

/**
 * Connect to a Chrome page tab via CDP WebSocket.
 * @param {number} [port=9222] — Chrome DevTools Protocol port
 * @returns {{ ws: WebSocket, evaluate: Function, send: Function }}
 */
export async function connect(port) {
  const cdpPort = port ?? parseInt(process.env.CDP_PORT || "9222")

  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const page = targets.find(
    (t) =>
      t.type === "page" &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("devtools://"),
  )
  if (!page) {
    throw new Error("No page tab found on CDP port " + cdpPort)
  }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    perMessageDeflate: false,
  })
  await new Promise((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  let msgId = 0

  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("CDP timeout")),
        15000,
      )
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id === id) {
          ws.off("message", handler)
          clearTimeout(timeout)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expr) {
    const result = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "eval failed"
      throw new Error(desc)
    }
    return result.result?.value
  }

  return { ws, send, evaluate, page }
}

// ─── Internal helpers ───

let _reqCounter = 0

function nextRequestId() {
  return `ftb_${Date.now()}_${++_reqCounter}`
}

/**
 * Dispatch a CustomEvent('__fieldTrip:command') into the page.
 * This crosses the content script isolation boundary because DOM events
 * are visible to all worlds (main + isolated).
 */
function buildDispatchExpr(detail) {
  const json = JSON.stringify(detail)
  return `document.dispatchEvent(new CustomEvent('__fieldTrip:command', { detail: ${json} }))`
}

/**
 * Poll `document.documentElement.dataset.ftResult_<requestId>` until it appears.
 * The content script writes the result there after handling the command.
 */
async function pollResult(evaluate, requestId, { timeoutMs = 10000, intervalMs = 80 } = {}) {
  const key = `ftResult_${requestId}`
  const start = Date.now()

  while (Date.now() - start < timeoutMs) {
    const raw = await evaluate(
      `document.documentElement.dataset[${JSON.stringify(key)}]`,
    )
    if (raw !== undefined && raw !== null) {
      // Clean up the dataset entry
      await evaluate(
        `delete document.documentElement.dataset[${JSON.stringify(key)}]`,
      ).catch(() => {})
      return JSON.parse(raw)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }

  throw new Error(`Timed out waiting for CLI bridge result (requestId: ${requestId})`)
}

// ─── Public API ───

/**
 * Spotlight an element — fire-and-forget (no polling needed, but we do it
 * briefly to confirm the bridge is alive).
 */
export async function spotlight(evaluate, selector, caption, guideIcon) {
  const requestId = nextRequestId()
  const detail = {
    requestId,
    type: "spotlight",
    selector,
    caption: caption ?? undefined,
    guideIcon: guideIcon ?? undefined,
  }
  await evaluate(buildDispatchExpr(detail))
  // Brief poll to confirm — but don't fail if bridge isn't loaded
  try {
    return await pollResult(evaluate, requestId, { timeoutMs: 2000 })
  } catch {
    return { success: true, note: "fire-and-forget — bridge may not be loaded" }
  }
}

/**
 * Clear all active spotlights.
 */
export async function clearSpotlights(evaluate) {
  const requestId = nextRequestId()
  await evaluate(
    buildDispatchExpr({ requestId, type: "clear_spotlights" }),
  )
  try {
    return await pollResult(evaluate, requestId, { timeoutMs: 2000 })
  } catch {
    return { success: true, note: "fire-and-forget" }
  }
}

/**
 * Scan interactive elements via the extension's DOMNavigator (structured output).
 * Returns an array of element descriptors sorted by Y position.
 */
export async function scanStructured(evaluate, maxItems) {
  const requestId = nextRequestId()
  const detail = {
    requestId,
    type: "scan",
    maxItems: maxItems ?? 120,
  }
  await evaluate(buildDispatchExpr(detail))
  return pollResult(evaluate, requestId, { timeoutMs: 10000 })
}

/**
 * Type into an input using React-compatible method (native setter + onChange escalation).
 */
export async function typeReact(evaluate, selector, value, clearFirst) {
  const requestId = nextRequestId()
  const detail = {
    requestId,
    type: "type",
    selector,
    value,
    clearFirst: clearFirst ?? false,
  }
  await evaluate(buildDispatchExpr(detail))
  return pollResult(evaluate, requestId, { timeoutMs: 5000 })
}

/**
 * Click an element using React-compatible method (el.click() + MouseEvent).
 */
export async function clickElement(evaluate, selector) {
  const requestId = nextRequestId()
  const detail = {
    requestId,
    type: "click",
    selector,
  }
  await evaluate(buildDispatchExpr(detail))
  return pollResult(evaluate, requestId, { timeoutMs: 5000 })
}

// ─── Relay Mode API ───

/**
 * Connect via the WebSocket relay bridge (no CDP required).
 * Returns a high-level API with the same operations as the CDP functions above.
 *
 * @param {object} [options]
 * @param {number} [options.port] - Relay server port (default: RELAY_PORT env or 9333)
 * @returns {Promise<RelayBridge>}
 */
export async function connectViaRelay(options = {}) {
  const { connectRelay } = await import("./relay-client.mjs")
  const relay = await connectRelay({
    port: options.port,
    name: "ft-bridge",
  })

  return {
    /** Spotlight an element */
    async spotlight(selector, caption, guideIcon) {
      return relay.command("spotlight", { selector, caption, guideIcon })
    },

    /** Clear all active spotlights */
    async clearSpotlights() {
      return relay.command("clear_spotlights")
    },

    /** Scan interactive elements (structured output) */
    async scanStructured(maxItems) {
      return relay.command("scan", { maxItems: maxItems ?? 120 })
    },

    /** Type into an input (React-compatible) */
    async typeReact(selector, value, clearFirst) {
      return relay.command("type", { selector, value, clearFirst: clearFirst ?? false })
    },

    /** Click an element (React-compatible) */
    async clickElement(selector) {
      return relay.command("click", { selector })
    },

    /** Evaluate arbitrary JS in the page context */
    async evaluate(expression) {
      return relay.command("eval", { expression })
    },

    /** Get page info (title, URL, headings) */
    async getPage() {
      return relay.command("page")
    },

    /** Navigate to a URL */
    async navigate(url) {
      return relay.command("navigate", { url })
    },

    /** Check if extension is connected */
    isExtensionConnected() {
      return relay.isExtensionConnected()
    },

    /** Close the relay connection */
    close() {
      relay.close()
    },

    /** Access the underlying relay for advanced use */
    relay,
  }
}

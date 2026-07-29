#!/usr/bin/env node
/**
 * TurboTax CLI driver — unified tool for scanning, clicking, typing, and navigating.
 *
 * Supports two connection modes:
 *   1. CDP mode (default) — connects via Chrome DevTools Protocol (requires --remote-debugging-port)
 *   2. Relay mode (--relay) — connects via WebSocket relay bridge (no CDP needed)
 *
 * Usage:
 *   node cli/tt.mjs scan              — list all visible interactive elements
 *   node cli/tt.mjs find <text>       — find elements by text content
 *   node cli/tt.mjs click <id|text>   — click element by ID, selector, or text
 *   node cli/tt.mjs type <id> <value> — type into input
 *   node cli/tt.mjs select <id> <val> — select dropdown value
 *   node cli/tt.mjs page              — get page title, URL, headings
 *   node cli/tt.mjs wait <ms>         — wait then re-scan
 *   node cli/tt.mjs eval <expr>       — evaluate arbitrary JS
 *
 * Flags:
 *   --relay                           — use WebSocket relay instead of CDP
 *   --spotlight                       — show Field Trip spotlight after actions
 *   --port <number>                   — relay port (default: 9333) or CDP port (default: 9222)
 *   --tab <id>                        — target a specific browser tab by ID (relay mode only)
 *
 * Tab management (relay mode):
 *   node cli/tt.mjs --relay tabs                — list all open tabs with IDs
 *   node cli/tt.mjs --relay --tab 123 scan      — scan a specific tab
 *   node cli/tt.mjs --relay --tab 456 click X   — click in a specific tab
 */

import http from "http"
import { writeFileSync, mkdirSync, existsSync } from "fs"
import { resolve } from "path"
import { tmpdir } from "os"
import { spotlight as ftSpotlight } from "./ft-bridge.mjs"

// ─── Parse flags ───

const rawArgs = process.argv.slice(2)
const useSpotlight = rawArgs.includes("--spotlight")
const useRelay = rawArgs.includes("--relay") || !!process.env.RELAY_MODE

// Parse --port flag
let customPort = null
const portIdx = rawArgs.indexOf("--port")
if (portIdx !== -1 && rawArgs[portIdx + 1]) {
  customPort = parseInt(rawArgs[portIdx + 1])
}

// Parse --tab flag (relay mode only)
let targetTabId = null
const tabIdx = rawArgs.indexOf("--tab")
if (tabIdx !== -1 && rawArgs[tabIdx + 1]) {
  targetTabId = parseInt(rawArgs[tabIdx + 1])
}

// Named-handshake flags — carry a stable agent identity so tab ownership
// survives the one-shot CLI pattern (each invocation is a fresh socket).
const flagVal = (flag) => {
  const i = rawArgs.indexOf(flag)
  return i !== -1 && rawArgs[i + 1] ? rawArgs[i + 1] : null
}
const agentName = flagVal("--agent-name") ?? process.env.FT_AGENT_NAME ?? null
const agentId = flagVal("--agent-id") ?? process.env.FT_AGENT_ID ?? null
const agentKind = flagVal("--agent-kind") ?? process.env.FT_AGENT_KIND ?? null
// Explicit escape hatch to act on the user's / another agent's tab. Only set
// this when the user asked. Injected into every relay command's params below.
const allowUserTab = rawArgs.includes("--allow-user-tab")
const flagPairIdx = (flag) => {
  const i = rawArgs.indexOf(flag)
  return i
}
const valueFlags = ["--port", "--tab", "--agent-name", "--agent-id", "--agent-kind"]
const valueFlagValueIdxs = valueFlags.map(flagPairIdx).filter((i) => i !== -1).map((i) => i + 1)

const filteredArgs = rawArgs.filter((a, i) =>
  a !== "--spotlight" &&
  a !== "--relay" &&
  a !== "--allow-user-tab" &&
  !valueFlags.includes(a) &&
  !valueFlagValueIdxs.includes(i)
)

// ─── CDP connection (original mode) ───

const CDP_PORT = customPort ?? parseInt(process.env.CDP_PORT || "9222")

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"))
  if (!page) { console.error("No page tab found"); process.exit(1) }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  let msgId = 0
  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP timeout")), 15000)
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
      const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "eval failed"
      throw new Error(desc)
    }
    return result.result?.value
  }

  return { ws, send, evaluate, page }
}

// ─── Relay connection (new mode) ───

async function connectRelayMode() {
  const { connectRelay } = await import("./relay-client.mjs")
  const relay = await connectRelay({
    port: customPort ?? parseInt(process.env.RELAY_PORT || "9333"),
    name: "tt.mjs",
    ...(agentName ? { agentName } : {}),
    ...(agentId ? { clientKey: agentId } : {}),
    ...(agentKind ? { kind: agentKind } : {}),
  })

  if (!relay.isExtensionConnected()) {
    console.error("Warning: Extension relay page not connected yet.")
    console.error("Open the relay page in Chrome: chrome-extension://<extension-id>/src/relay/index.html")
  }

  return relay
}

// ─── Unified command interface ───

/**
 * Create a unified interface that works the same for both CDP and relay modes.
 * Returns { scan, find, click, type, page, eval, spotlight, wait, close }
 */
async function createDriver() {
  if (useRelay) {
    const relay = await connectRelayMode()

    // Build tab options for every command (passes tabId when --tab is used)
    const tabOpts = targetTabId ? { tabId: targetTabId } : {}

    return {
      relay, // expose relay for tabs command

      async scan() {
        const result = await relay.command("scan", { maxItems: 120 }, tabOpts)
        // Result from scan_structured is an array of StructuredElement
        return result
      },

      async find(text) {
        const result = await relay.command("find", { text }, tabOpts)
        return result
      },

      async click(target) {
        // In relay mode, we need to resolve the target to a selector
        // The content script's click tool expects a CSS selector
        // Try to find by ID first, then selector, then text
        try {
          const result = await relay.command("click", { selector: target }, tabOpts)
          return { success: true, tag: "element", id: "", text: target }
        } catch (err) {
          // Fall back to find-by-text then click
          try {
            const found = await relay.command("find", { text: target }, tabOpts)
            if (found && found.length > 0) {
              const sel = found[0].selector
              await relay.command("click", { selector: sel }, tabOpts)
              return { success: true, tag: found[0].tagName || "element", id: found[0].attributes?.id || "", text: target }
            }
          } catch { /* fall through */ }
          return { success: false, error: `Not found: ${target}` }
        }
      },

      async typeText(selector, value) {
        // Try direct selector first, then find by label text
        try {
          await relay.command("type", { selector, value, clearFirst: true }, tabOpts)
          return { success: true, value, tag: "input" }
        } catch {
          // Try finding by text (label)
          try {
            const found = await relay.command("find", { text: selector }, tabOpts)
            if (found && found.length > 0) {
              // Look for an input near the found element
              const sel = found[0].selector
              await relay.command("type", { selector: sel, value, clearFirst: true }, tabOpts)
              return { success: true, value, tag: "input" }
            }
          } catch { /* fall through */ }
          return { success: false, error: `Not found: ${selector}` }
        }
      },

      async getPage() {
        return relay.command("page", {}, tabOpts)
      },

      async evaluate(expr) {
        return relay.command("eval", { expression: expr }, tabOpts)
      },

      async doSpotlight(selector, caption) {
        return relay.command("spotlight", { selector, caption }, tabOpts)
      },

      async wait(ms) {
        return relay.command("wait_ms", { ms }, tabOpts)
      },

      close() {
        relay.close()
      },

      // For ft-bridge spotlight compatibility
      evaluateFn: null,
    }
  } else {
    // CDP mode (original)
    const { ws, evaluate } = await connectCDP()

    return {
      async scan() {
        return evaluate(`
          (() => {
            const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], h1, h2, h3, h4, label, [data-testid]';
            const els = document.querySelectorAll(selectors);
            const items = [];
            for (const el of els) {
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;
              const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 150);
              if (!text && !['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) continue;
              items.push({
                tag: el.tagName.toLowerCase(),
                text,
                id: el.id || undefined,
                name: el.name || undefined,
                type: el.type || undefined,
                role: el.getAttribute('role') || undefined,
                ariaLabel: el.getAttribute('aria-label') || undefined,
                dataTestid: el.getAttribute('data-testid') || undefined,
                value: (el.value !== undefined && el.value !== '') ? String(el.value).slice(0,80) : undefined,
                cursor: style.cursor === 'pointer' ? 'pointer' : undefined,
                y: Math.round(rect.y),
              });
            }
            items.sort((a, b) => a.y - b.y);
            return items.slice(0, 120);
          })()
        `)
      },

      async find(text) {
        return evaluate(`
          (() => {
            const lower = ${JSON.stringify(text)}.toLowerCase();
            const all = document.querySelectorAll('*');
            const results = [];
            for (const el of all) {
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;
              const fullText = (el.textContent || '').trim();
              if (fullText.length > 300) continue;
              if (!fullText.toLowerCase().includes(lower)) continue;
              results.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                text: fullText.slice(0, 200),
                className: (el.className||'').toString().slice(0,60) || undefined,
                cursor: style.cursor === 'pointer' ? 'pointer' : undefined,
                clickable: ['A','BUTTON'].includes(el.tagName) || el.getAttribute('role') === 'button' || style.cursor === 'pointer',
                y: Math.round(rect.y),
              });
            }
            return results.slice(0, 40);
          })()
        `)
      },

      async click(target) {
        return evaluate(`
          (() => {
            let el = document.getElementById(${JSON.stringify(target)});
            if (!el) {
              try { el = document.querySelector(${JSON.stringify(target)}); } catch(e) {}
            }
            if (!el) {
              el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(target)}) + ']');
            }
            if (!el) {
              el = document.querySelector('[data-automation-id=' + JSON.stringify(${JSON.stringify(target)}) + ']');
            }
            if (!el) {
              const lower = ${JSON.stringify(target)}.toLowerCase();
              const priorities = [
                ...document.querySelectorAll('button, a, [role="button"]'),
                ...document.querySelectorAll('span, td, div, label')
              ];
              for (const candidate of priorities) {
                const text = (candidate.textContent || '').trim().toLowerCase();
                if (text === lower || (text.length < 200 && text.includes(lower))) {
                  el = candidate;
                  break;
                }
              }
            }
            if (!el) return { success: false, error: 'Not found: ' + ${JSON.stringify(target)} };
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
            return {
              success: true,
              tag: el.tagName.toLowerCase(),
              id: el.id || '',
              text: (el.textContent||'').trim().slice(0, 120),
            };
          })()
        `)
      },

      async typeText(selector, value) {
        return evaluate(`
          (() => {
            let el = document.getElementById(${JSON.stringify(selector)});
            if (!el) try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}
            if (!el) {
              const labels = document.querySelectorAll('label');
              const lower = ${JSON.stringify(selector)}.toLowerCase();
              for (const label of labels) {
                if (label.textContent.trim().toLowerCase().includes(lower)) {
                  const forId = label.getAttribute('for');
                  if (forId) el = document.getElementById(forId);
                  if (!el) el = label.querySelector('input, textarea, select');
                  if (!el) el = label.nextElementSibling;
                  if (el) break;
                }
              }
            }
            if (!el) return { success: false, error: 'Not found: ' + ${JSON.stringify(selector)} };
            el.focus();
            el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set || Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(el, ${JSON.stringify(value)});
            } else {
              el.value = ${JSON.stringify(value)};
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            return { success: true, value: el.value, tag: el.tagName.toLowerCase() };
          })()
        `)
      },

      async getPage() {
        return evaluate(`
          (() => {
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .filter(h => {
                const s = getComputedStyle(h);
                return s.display !== 'none' && s.visibility !== 'hidden';
              })
              .map(h => ({ tag: h.tagName, text: h.textContent.trim().slice(0, 150) }));
            return {
              title: document.title,
              url: location.href,
              headings,
            };
          })()
        `)
      },

      async evaluate(expr) {
        return evaluate(expr)
      },

      async doSpotlight(selector, caption) {
        return ftSpotlight(evaluate, selector, caption)
      },

      async wait(ms) {
        await new Promise(r => setTimeout(r, ms))
      },

      close() {
        ws.close()
      },

      evaluateFn: evaluate,
    }
  }
}

// ─── Main ───

const [cmd, ...args] = filteredArgs

if (!cmd || cmd === "help") {
  console.log(`
TurboTax CLI Driver

  node cli/tt.mjs scan                 — list interactive elements
  node cli/tt.mjs find <text>          — find elements by text
  node cli/tt.mjs click <id|text>      — click an element
  node cli/tt.mjs type <id> <value>    — type into input field
  node cli/tt.mjs page                 — show page info
  node cli/tt.mjs wait <ms>            — wait then scan
  node cli/tt.mjs eval <expression>    — run arbitrary JS
  node cli/tt.mjs tabs                 — list all open tabs (relay mode)
  node cli/tt.mjs new_tab [url]        — open a NEW tab (agents: use this, don't borrow user tabs) — auto-claimed by you
  node cli/tt.mjs close_tab --tab <id> — close a tab you opened
  node cli/tt.mjs activate --tab <id>  — focus a tab (only tabs YOU own; needed before capture_tab)
  node cli/tt.mjs navigate <url>       — navigate current/target tab
  node cli/tt.mjs reload|back|forward  — tab history controls
  node cli/tt.mjs capture_tab          — screenshot active tab (see --selector/--format)
  node cli/tt.mjs agent_action <name> <json> — call any content-script agent tool

Tab ownership (the relay blocks agents from driving each other's / the user's tabs):
  node cli/tt.mjs claim_tab --tab <id>   — claim an existing tab as yours
  node cli/tt.mjs release_tab --tab <id> — release your claim
  node cli/tt.mjs list_claims            — show all tab + window claims (owner + source)
  node cli/tt.mjs list_agents            — show connected agents (name, kind, owned tabs)
  node cli/tt.mjs tab_activity [--tab <id>] — classify tabs: user | agent | collab | idle
  Disruptive verbs (navigate/click/type/eval/reload/activate) are REJECTED on a tab
  owned by another agent or on the user's focused tab. Read verbs are always allowed.
  CONSULT tab_activity BEFORE touching any unclaimed tab — 'user'/'collab' = hands off.
  Escape hatch (only when the user explicitly asked): add allow_user_tab to params, e.g.
    node cli/tt.mjs eval "..." --tab <userTab>   (pass allow_user_tab via the MCP params)

Agent windows (need pixels? isolate first):
  node cli/tt.mjs new_window [url]            — your OWN Chrome window (opens unfocused);
                                                you own it and every tab created inside it
  node cli/tt.mjs new_tab <url> --window <id> — open a tab inside your window
  activate on a tab in YOUR window never steals the user's focus (window stays background).
  Capture flow: new_window → new_tab --window → activate --tab → capture_tab.
  NEVER activate in a shared window — that yanks the user's tab selection.
  Caveat: captureVisibleTab captures an unfocused window's active tab, but NOT while
  the window is minimized (keep agent windows restored, just not focused).

Identity flags (stable ownership across the one-shot CLI pattern):
  --agent-name <name>   — human label shown in ownership errors / list_agents (env FT_AGENT_NAME)
  --agent-id <id>       — stable key: same id keeps your tab claims across reconnects (env FT_AGENT_ID)
  --agent-kind <kind>   — claude-code | cli | hosted | unknown (env FT_AGENT_KIND)

Connection modes:
  (default)                            — CDP mode (requires --remote-debugging-port)
  --relay                              — relay mode (requires ws-relay + extension)
  --port <number>                      — override port (CDP: 9222, relay: 9333)

Other flags:
  --spotlight                          — show Field Trip spotlight after actions
  --tab <id>                           — target a specific tab by ID (relay mode)
  `)
  process.exit(0)
}

const driver = await createDriver()

if (useRelay) {
  const tabMsg = targetTabId ? ` (targeting tab ${targetTabId})` : ""
  console.error(`[relay mode] Connected via WebSocket relay${tabMsg}`)
  // Inject the explicit escape hatch into every relay command's params so
  // ownership-gated verbs (click/type/eval/navigate/...) get through when the
  // user authorized acting on their tab. No-op unless --allow-user-tab passed.
  if (allowUserTab && driver.relay && typeof driver.relay.command === "function") {
    const orig = driver.relay.command.bind(driver.relay)
    driver.relay.command = (action, params = {}, options = {}) =>
      orig(action, { ...params, allow_user_tab: true }, options)
  }
}

try {
  switch (cmd) {
    case "scan": {
      const items = await driver.scan()
      if (!items || !Array.isArray(items)) {
        console.error("No scan results returned")
        break
      }
      for (const el of items) {
        const parts = [`<${el.tag}>`]
        if (el.id) parts.push(`id="${el.id}"`)
        if (el.name) parts.push(`name="${el.name}"`)
        if (el.type) parts.push(`type="${el.type}"`)
        if (el.dataTestid) parts.push(`testid="${el.dataTestid}"`)
        if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
        if (el.role) parts.push(`role="${el.role}"`)
        if (el.cursor || el.clickable) parts.push(`[clickable]`)
        if (el.value) parts.push(`val="${el.value}"`)
        if (el.text) parts.push(`"${el.text.slice(0, 100)}"`)
        if (el.selector) parts.push(`→ ${el.selector}`)
        console.log(parts.join(' '))
      }
      break
    }
    case "find": {
      const results = await driver.find(args.join(' '))
      if (!results || !Array.isArray(results)) {
        console.error("No results found")
        break
      }
      for (const el of results) {
        const marker = el.clickable ? '>>>' : '   '
        console.log(`${marker} <${el.tag ?? el.tagName}> ${el.id ? 'id="'+el.id+'"' : ''} ${el.cursor||''} "${(el.text || '').slice(0,120)}"`)
      }
      break
    }
    case "click": {
      const target = args.join(' ')
      const result = await driver.click(target)
      if (result.success) {
        console.log(`Clicked: <${result.tag}> ${result.id ? 'id="'+result.id+'"' : ''} "${result.text || ''}"`)
        if (useSpotlight) {
          const spotSelector = result.id ? `#${result.id}` : target
          if (useRelay) {
            await driver.doSpotlight(spotSelector, `Clicked: ${(result.text || '').slice(0, 60)}`)
          } else if (driver.evaluateFn) {
            await ftSpotlight(driver.evaluateFn, spotSelector, `Clicked: ${(result.text || '').slice(0, 60)}`)
          }
        }
      } else {
        console.error(`Failed: ${result.error}`)
      }
      break
    }
    case "type": {
      const [selector, ...valueParts] = args
      const typedValue = valueParts.join(' ')
      const result = await driver.typeText(selector, typedValue)
      if (result.success) {
        console.log(`Typed "${result.value || typedValue}" into <${result.tag}>`)
        if (useSpotlight) {
          if (useRelay) {
            await driver.doSpotlight(selector, `Typed: "${typedValue.slice(0, 40)}"`)
          } else if (driver.evaluateFn) {
            await ftSpotlight(driver.evaluateFn, selector, `Typed: "${typedValue.slice(0, 40)}"`)
          }
        }
      } else {
        console.error(`Failed: ${result.error}`)
      }
      break
    }
    case "page": {
      const info = await driver.getPage()
      console.log(`Title: ${info.title}`)
      console.log(`URL: ${info.url}`)
      console.log(`Headings:`)
      for (const h of (info.headings || [])) {
        console.log(`  <${h.tag}> ${h.text}`)
      }
      break
    }
    case "wait": {
      const ms = parseInt(args[0]) || 2000
      console.log(`Waiting ${ms}ms...`)
      await driver.wait(ms)
      const items = await driver.scan()
      if (items && Array.isArray(items)) {
        for (const el of items) {
          const parts = [`<${el.tag}>`]
          if (el.id) parts.push(`id="${el.id}"`)
          if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
          if (el.text) parts.push(`"${el.text.slice(0, 100)}"`)
          console.log(parts.join(' '))
        }
      }
      break
    }
    case "eval": {
      const result = await driver.evaluate(args.join(' '))
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "capture_tab": {
      // Capture the visible portion of the target tab as a PNG/JPEG.
      // Writes the decoded image to a temp file and prints a JSON line
      // with {path, width, height, mimeType, url, title} so the MCP
      // server can pick up the file and return it as image content.
      if (!useRelay) {
        console.error("capture_tab requires --relay mode")
        break
      }
      const capTabOpts = targetTabId ? { tabId: targetTabId } : {}
      // Parse optional flags: --selector, --format, --quality
      let selector, format = "png", quality
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--selector" || args[i] === "-s") selector = args[++i]
        else if (args[i] === "--format" || args[i] === "-f") format = args[++i]
        else if (args[i] === "--quality" || args[i] === "-q") quality = parseInt(args[++i])
      }
      const params = { format }
      if (selector) params.selector = selector
      if (quality) params.quality = quality
      const result = await driver.relay.command("capture_tab", params, capTabOpts)
      if (!result || !result.dataUrl) {
        console.error("capture_tab: no dataUrl in response")
        console.log(JSON.stringify(result, null, 2))
        break
      }
      // Strip data URL prefix and decode
      const match = result.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) {
        console.error("capture_tab: malformed data URL")
        break
      }
      const mimeType = match[1]
      const base64 = match[2]
      const ext = mimeType === "image/jpeg" ? "jpg" : "png"
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const dir = resolve(tmpdir(), "field-trip-captures")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const path = resolve(dir, `capture-${ts}.${ext}`)
      writeFileSync(path, Buffer.from(base64, "base64"))
      const out = {
        path,
        mimeType,
        width: result.width,
        height: result.height,
        cropped: !!result.cropped,
        selector: result.selector,
        url: result.url,
        title: result.title,
      }
      console.log(JSON.stringify(out, null, 2))
      break
    }
    case "agent_action": {
      // Generic passthrough for agent-tools native actions. Usage:
      //   tt agent_action <name> '<json params>' [--tab N]
      // Where <name> is one of: arrive, quick_scan, a11y_tree, a11y_issues,
      // describe_region, layout_audit, clickable_check, visual_snapshot,
      // visual_diff, changes_since, tab_health, session_state.
      if (!useRelay) {
        console.error("agent_action requires --relay mode")
        break
      }
      const [actionName, ...paramArgs] = args
      if (!actionName) {
        console.error("agent_action: missing action name")
        break
      }
      let params = {}
      if (paramArgs.length) {
        try {
          params = JSON.parse(paramArgs.join(' '))
        } catch (e) {
          console.error(`agent_action: invalid JSON params — ${e.message}`)
          break
        }
      }
      const agentTabOpts = targetTabId ? { tabId: targetTabId } : {}
      const result = await driver.relay.command(actionName, params, agentTabOpts)
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "tabs": {
      if (!useRelay) {
        console.error("The 'tabs' command requires --relay mode")
        break
      }
      const tabs = await driver.relay.listTabs()
      if (!tabs || !Array.isArray(tabs) || tabs.length === 0) {
        console.log("No open tabs found")
        break
      }
      console.log(`Open tabs (${tabs.length}):`)
      for (const t of tabs) {
        const marker = t.active ? " *" : "  "
        console.log(`${marker} [${t.id}] ${t.title}`)
        console.log(`         ${t.url}`)
      }
      break
    }
    case "activate": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const activateTabId = parseInt(args[0])
      if (isNaN(activateTabId)) { console.error("Usage: activate <tabId>"); break }
      const activated = await driver.relay.command("activate", {}, { tabId: activateTabId })
      console.log(`Activated: [${activateTabId}] ${activated?.title || ""}`)
      break
    }
    case "reload": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const rTabOpts = targetTabId ? { tabId: targetTabId } : {}
      const reloaded = await driver.relay.command("reload", {}, rTabOpts)
      console.log(`Reloaded: ${reloaded?.title || ""}`)
      break
    }
    case "back": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const bTabOpts = targetTabId ? { tabId: targetTabId } : {}
      const back = await driver.relay.command("back", {}, bTabOpts)
      console.log(`Back: ${back?.title || ""} — ${back?.url || ""}`)
      break
    }
    case "forward": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const fTabOpts = targetTabId ? { tabId: targetTabId } : {}
      const fwd = await driver.relay.command("forward", {}, fTabOpts)
      console.log(`Forward: ${fwd?.title || ""} — ${fwd?.url || ""}`)
      break
    }
    case "navigate": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const navUrl = args[0]
      if (!navUrl) { console.error("Usage: navigate <url>"); break }
      const nTabOpts = targetTabId ? { tabId: targetTabId } : {}
      const nav = await driver.relay.command("navigate", { url: navUrl }, nTabOpts)
      console.log(`Navigated: ${nav?.title || ""} — ${nav?.url || ""}`)
      break
    }
    case "new_tab": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const winIdx = args.indexOf("--window")
      const ntParams = { url: (winIdx === 0 ? args[2] : args[0]) || "about:blank" }
      if (winIdx !== -1 && args[winIdx + 1]) ntParams.window_id = parseInt(args[winIdx + 1])
      const newTab = await driver.relay.command("new_tab", ntParams)
      console.log(`New tab: [${newTab?.tabId}] in window ${newTab?.windowId ?? "?"} ${newTab?.url || ""}`)
      break
    }
    case "new_window": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const nwUrl = args[0] || "about:blank"
      const newWin = await driver.relay.command("new_window", { url: nwUrl })
      console.log(`New window: [win ${newWin?.windowId}] first tab [${newWin?.tabId}] ${newWin?.url || ""}`)
      break
    }
    case "tab_activity": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const taParams = {}
      if (targetTabId) taParams.tabId = targetTabId
      const act = await driver.relay.command("tab_activity", taParams)
      console.log(JSON.stringify(act, null, 2))
      break
    }
    case "close_tab": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const closeTabId = parseInt(args[0])
      if (isNaN(closeTabId)) { console.error("Usage: close_tab <tabId>"); break }
      const closed = await driver.relay.command("close_tab", {}, { tabId: closeTabId })
      console.log(`Closed: ${closed?.title || ""}`)
      break
    }
    case "claim_tab":
    case "release_tab":
    case "grant_tab": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const otId = targetTabId ?? parseInt(args[0])
      if (isNaN(otId)) { console.error(`Usage: ${cmd} --tab <tabId>`); break }
      const res = await driver.relay.command(cmd, { tabId: otId })
      console.log(JSON.stringify(res))
      break
    }
    case "list_claims":
    case "list_agents": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const res = await driver.relay.command(cmd, {})
      console.log(JSON.stringify(res, null, 2))
      break
    }
    case "zoom": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const zoomLevel = parseFloat(args[0]) || 1.0
      const zTabOpts = targetTabId ? { tabId: targetTabId } : {}
      await driver.relay.command("zoom", { level: zoomLevel }, zTabOpts)
      console.log(`Zoom: ${zoomLevel * 100}%`)
      break
    }
    case "spotlight": {
      const [selector, ...captionParts] = args
      if (!selector) {
        console.error("Usage: spotlight <selector> [caption text]")
        break
      }
      const caption = captionParts.join(' ') || ''
      const result = await driver.doSpotlight(selector, caption)
      console.log(`Spotlight: ${selector}${caption ? ' — "' + caption + '"' : ''}`)
      break
    }
    case "annotations": {
      if (!useRelay) { console.error("Requires --relay mode"); break }
      const subCmd = args[0] || "get"
      const aTabOpts = targetTabId ? { tabId: targetTabId } : {}

      if (subCmd === "list") {
        const result = await driver.relay.command("annotations", { action: "list" }, aTabOpts)
        console.log(JSON.stringify(result, null, 2))
      } else if (subCmd === "get") {
        const result = await driver.relay.command("annotations", { action: "get", url: "current" }, aTabOpts)
        console.log(JSON.stringify(result, null, 2))
      } else if (subCmd === "workflows") {
        const domain = args[1] || ""
        const result = await driver.relay.command("annotations", { action: "workflows", domain }, aTabOpts)
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.error("Usage: annotations [list|get|workflows <domain>]")
      }
      break
    }
    default:
      console.error(`Unknown command: ${cmd}`)
  }
} finally {
  driver.close()
}

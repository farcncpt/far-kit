#!/usr/bin/env node
/**
 * watch-and-validate.mjs — Monitors a dev server via CDP and validates after each HMR reload.
 *
 * Connects to a Chrome/Edge instance via CDP, listens for page reload events
 * (Page.loadEventFired, Page.frameNavigated), and runs validation checks after
 * each reload. Keeps running until killed (Ctrl+C).
 *
 * Usage:
 *   CDP_PORT=9222 node cli/watch-and-validate.mjs [--url http://localhost:3000]
 *
 * Environment:
 *   CDP_PORT — Chrome DevTools Protocol port (default: 9222)
 */

import http from "http"

const args = process.argv.slice(2)
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222")

function getFlagValue(name, fallback) {
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return fallback
}

const targetUrl = getFlagValue("--url", null)

// ─── Timestamp helper ───

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false })
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`)
}

function logOk(msg) {
  console.log(`[${ts()}] \u2713 ${msg}`)
}

function logWarn(msg) {
  console.log(`[${ts()}] \u26A0 ${msg}`)
}

function logFail(msg) {
  console.log(`[${ts()}] \u2717 ${msg}`)
}

// ─── CDP connection ───

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", (err) => {
      reject(new Error(`Cannot connect to CDP on port ${CDP_PORT}: ${err.message}`))
    })
  })

  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://")
  )
  if (!page) {
    console.error("No page tab found on CDP port " + CDP_PORT)
    process.exit(1)
  }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  let msgId = 0
  const eventListeners = new Map()

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.method) {
      const listeners = eventListeners.get(msg.method) || []
      for (const fn of listeners) fn(msg.params)
    }
  })

  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000)
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

  function onEvent(method, fn) {
    if (!eventListeners.has(method)) eventListeners.set(method, [])
    eventListeners.get(method).push(fn)
  }

  return { ws, send, evaluate, onEvent, pageInfo: page }
}

// ─── Validation checks (lightweight versions for speed) ───

async function runValidation(evaluate) {
  const results = { passed: true, issues: [] }

  // 1. Element scan
  const elements = await evaluate(`
    (() => {
      const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], h1, h2, h3, h4, label, img, form';
      const els = document.querySelectorAll(selectors);
      let total = 0, interactive = 0;
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        total++;
        if (['BUTTON','INPUT','SELECT','TEXTAREA','A'].includes(el.tagName) || el.getAttribute('role') === 'button') interactive++;
      }
      return { total, interactive };
    })()
  `)
  log(`Scanning... ${elements.total} elements found`)

  // 2. Console errors (check for any stored errors from the reload)
  const consoleErrors = await evaluate(`
    (() => {
      // Check if the page has an error overlay (Next.js / Vite / Webpack)
      const overlay = document.querySelector('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay');
      if (overlay) {
        return [overlay.textContent.trim().slice(0, 200)];
      }
      return [];
    })()
  `).catch(() => [])

  if (consoleErrors.length === 0) {
    logOk("No console errors")
  } else {
    logFail(`${consoleErrors.length} console error(s)`)
    for (const e of consoleErrors) {
      console.log(`         - ${e.slice(0, 150)}`)
    }
    results.passed = false
    results.issues.push(...consoleErrors.map((e) => ({ type: "console-error", message: e })))
  }

  // 3. Failed requests (check performance API)
  const networkIssues = await evaluate(`
    (() => {
      const entries = performance.getEntriesByType('resource');
      const failed = [];
      for (const e of entries) {
        if (e.transferSize === 0 && e.decodedBodySize === 0 && !e.name.startsWith('data:')) {
          // Possible failed request (0 bytes transferred and not a data URI)
          // Only flag if it's a script or stylesheet
          if (e.initiatorType === 'script' || e.initiatorType === 'link' || e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') {
            failed.push(e.name.split('/').pop().slice(0, 80));
          }
        }
      }
      return failed;
    })()
  `).catch(() => [])

  if (networkIssues.length === 0) {
    logOk("No failed requests")
  } else {
    logWarn(`${networkIssues.length} potentially failed request(s)`)
    for (const f of networkIssues.slice(0, 3)) {
      console.log(`         - ${f}`)
    }
    results.issues.push(...networkIssues.map((f) => ({ type: "network", message: f })))
  }

  // 4. Accessibility quick scan
  const a11yIssues = await evaluate(`
    (() => {
      const issues = [];
      // Buttons without labels
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label');
        if (!text && !ariaLabel && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')) {
          const id = el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : '';
          issues.push('button' + id + ' missing aria-label');
        }
      });
      // Images without alt
      document.querySelectorAll('img').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        if (el.getAttribute('alt') === null) {
          const src = (el.src || '').split('/').pop().slice(0, 40);
          issues.push('img[' + src + '] missing alt');
        }
      });
      // Inputs without labels
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), select, textarea').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')) {
          let hasLabel = false;
          if (el.id) hasLabel = !!document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (!hasLabel) hasLabel = !!el.closest('label');
          if (!hasLabel && !el.getAttribute('placeholder')) {
            const id = el.id ? '#' + el.id : el.name ? '[name="' + el.name + '"]' : '';
            issues.push(el.tagName.toLowerCase() + id + ' missing label');
          }
        }
      });
      return issues;
    })()
  `).catch(() => [])

  if (a11yIssues.length === 0) {
    logOk("No accessibility issues")
  } else {
    logWarn(`${a11yIssues.length} accessibility issue(s)`)
    for (const a of a11yIssues.slice(0, 5)) {
      console.log(`         - ${a}`)
    }
    results.issues.push(...a11yIssues.map((a) => ({ type: "accessibility", message: a })))
  }

  // 5. Link validation
  const linkCheck = await evaluate(`
    (() => {
      const links = document.querySelectorAll('a[href]');
      let total = 0, broken = 0;
      const brokenList = [];
      for (const a of links) {
        const style = getComputedStyle(a);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        total++;
        const href = a.getAttribute('href');
        if (!href || href === '#' || href === 'javascript:void(0)' || href === 'javascript:;') {
          broken++;
          brokenList.push('"' + (a.textContent || '').trim().slice(0, 40) + '" href="' + (href || '') + '"');
        }
      }
      return { total, broken, brokenList };
    })()
  `).catch(() => ({ total: 0, broken: 0, brokenList: [] }))

  if (linkCheck.broken === 0) {
    logOk(`All ${linkCheck.total} links valid`)
  } else {
    logWarn(`${linkCheck.broken} broken link(s) out of ${linkCheck.total}`)
    for (const l of linkCheck.brokenList.slice(0, 3)) {
      console.log(`         - ${l}`)
    }
    results.issues.push(...linkCheck.brokenList.map((l) => ({ type: "broken-link", message: l })))
  }

  if (results.issues.length > 0) results.passed = false

  return results
}

// ─── Main ───

async function main() {
  const cdp = await connectCDP()
  const { send, evaluate, onEvent, ws, pageInfo } = cdp

  // Navigate if URL specified
  if (targetUrl) {
    await send("Page.enable")
    await send("Page.navigate", { url: targetUrl })
    await new Promise((resolve) => {
      onEvent("Page.loadEventFired", resolve)
      setTimeout(resolve, 10000)
    })
    await new Promise((r) => setTimeout(r, 1000))
  }

  // Enable page domain for reload detection
  await send("Page.enable")
  await send("Runtime.enable")

  const currentUrl = await evaluate("location.href")
  log(`Watching: ${currentUrl}`)
  log(`CDP port: ${CDP_PORT}`)
  log(`Waiting for page reloads... (Ctrl+C to stop)\n`)

  // Run initial validation
  log("Initial scan")
  await runValidation(evaluate)
  console.log("")

  // Track whether we're currently validating to avoid overlapping runs
  let validating = false
  let pendingReload = false

  async function handleReload() {
    if (validating) {
      pendingReload = true
      return
    }
    validating = true
    pendingReload = false

    // Wait for page to settle after HMR
    await new Promise((r) => setTimeout(r, 1000))

    log("HMR reload detected")
    try {
      const result = await runValidation(evaluate)
      if (result.passed) {
        logOk("All checks passed")
      }
    } catch (err) {
      logFail(`Validation error: ${err.message}`)
    }
    console.log("")

    validating = false
    if (pendingReload) {
      handleReload()
    }
  }

  // Listen for page events that indicate a reload
  onEvent("Page.loadEventFired", () => {
    handleReload()
  })

  onEvent("Page.frameNavigated", (params) => {
    // Only trigger for top-level frame navigations
    if (!params.frame.parentId) {
      handleReload()
    }
  })

  // Also listen for runtime execution context changes (HMR often creates new contexts)
  onEvent("Runtime.executionContextCreated", (params) => {
    // Main world context for the top frame
    if (params.context.auxData?.isDefault && params.context.auxData?.frameId) {
      // Debounce — HMR may create multiple contexts
      // The loadEventFired handler will catch the full reload
    }
  })

  // Keep the process alive
  process.on("SIGINT", () => {
    log("Shutting down watcher")
    ws.close()
    process.exit(0)
  })

  // Heartbeat to detect disconnection
  const heartbeat = setInterval(async () => {
    try {
      await evaluate("1")
    } catch {
      log("CDP connection lost. Exiting.")
      clearInterval(heartbeat)
      ws.close()
      process.exit(1)
    }
  }, 30000)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(2)
})

#!/usr/bin/env node
/**
 * validate-page.mjs — Comprehensive page validation tool.
 *
 * Runs automated checks against a live page via CDP:
 *   - Interactive element scan
 *   - Console error/warning capture
 *   - Failed/slow network request detection
 *   - Accessibility audit (aria-labels, alt text, form labels)
 *   - Link validation (broken hrefs)
 *   - Visibility checks (zero-size, hidden elements that shouldn't be)
 *   - Responsive layout testing at multiple viewport widths
 *
 * Usage:
 *   CDP_PORT=9222 node cli/validate-page.mjs [--url URL] [--output report.json]
 *   CDP_PORT=9222 node cli/validate-page.mjs --responsive
 *   CDP_PORT=9222 node cli/validate-page.mjs --full
 *
 * Environment:
 *   CDP_PORT — Chrome DevTools Protocol port (default: 9222)
 */

import http from "http"
import { writeFileSync } from "fs"

// ─── Argument parsing ───

const args = process.argv.slice(2)
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222")

function getFlag(name) {
  return args.includes(name)
}

function getFlagValue(name, fallback) {
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return fallback
}

const targetUrl = getFlagValue("--url", null)
const outputFile = getFlagValue("--output", null)
const runResponsive = getFlag("--responsive") || getFlag("--full")
const runFull = getFlag("--full")
const RESPONSIVE_WIDTHS = [375, 768, 1024, 1440]

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
      const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000)
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

// ─── Check modules ───

/** Scan for interactive elements, headings, and totals. */
async function checkElements(evaluate) {
  return evaluate(`
    (() => {
      const all = document.querySelectorAll('*');
      let total = 0, interactive = 0, headings = 0, images = 0, forms = 0, links = 0;
      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        total++;
        const tag = el.tagName;
        if (['A'].includes(tag)) links++;
        if (['BUTTON','INPUT','SELECT','TEXTAREA'].includes(tag) || el.getAttribute('role') === 'button') interactive++;
        if (/^H[1-6]$/.test(tag)) headings++;
        if (tag === 'IMG') images++;
        if (tag === 'FORM') forms++;
      }
      return { total, interactive, headings, images, forms, links };
    })()
  `)
}

/** Collect console errors/warnings via Runtime and Log domains. */
async function checkConsole(send, onEvent, durationMs = 500) {
  const errors = []
  const warnings = []

  onEvent("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((a) => a.value || a.description || "").join(" ")
    if (params.type === "error") errors.push(text)
    else if (params.type === "warning") warnings.push(text)
  })

  onEvent("Runtime.exceptionThrown", (params) => {
    const desc =
      params.exceptionDetails?.exception?.description ||
      params.exceptionDetails?.text ||
      "Unknown error"
    errors.push(desc)
  })

  onEvent("Log.entryAdded", (params) => {
    const entry = params.entry
    if (entry.level === "error") errors.push(entry.text)
    else if (entry.level === "warning") warnings.push(entry.text)
  })

  await send("Runtime.enable")
  await send("Log.enable")

  // Listen for a short window to capture any in-flight errors
  await new Promise((r) => setTimeout(r, durationMs))

  await send("Runtime.disable").catch(() => {})
  await send("Log.disable").catch(() => {})

  return { errors, warnings }
}

/** Detect failed or slow network requests. */
async function checkNetwork(send, onEvent, evaluate, durationMs = 500) {
  const failed = []
  const slow = []
  const pending = new Map()

  onEvent("Network.requestWillBeSent", (params) => {
    pending.set(params.requestId, {
      url: params.request.url,
      start: params.timestamp,
    })
  })

  onEvent("Network.responseReceived", (params) => {
    const req = pending.get(params.requestId)
    if (!req) return
    const status = params.response.status
    if (status >= 400) {
      failed.push({ url: req.url, status })
    }
    const elapsed = (params.timestamp - req.start) * 1000
    if (elapsed > 3000) {
      slow.push({ url: req.url, ms: Math.round(elapsed) })
    }
    pending.delete(params.requestId)
  })

  onEvent("Network.loadingFailed", (params) => {
    const req = pending.get(params.requestId)
    if (!req) return
    failed.push({
      url: req.url,
      error: params.errorText || "loading failed",
    })
    pending.delete(params.requestId)
  })

  await send("Network.enable")

  // Trigger a small navigation/refetch to capture network activity, or just wait
  // We also pull performance entries for requests that already completed
  const perfEntries = await evaluate(`
    (() => {
      const entries = performance.getEntriesByType('resource');
      const results = { failed: [], slow: [] };
      for (const e of entries) {
        if (e.duration > 3000) {
          results.slow.push({ url: e.name, ms: Math.round(e.duration) });
        }
      }
      return results;
    })()
  `).catch(() => ({ failed: [], slow: [] }))

  await new Promise((r) => setTimeout(r, durationMs))
  await send("Network.disable").catch(() => {})

  // Merge performance entries
  for (const s of perfEntries.slow || []) {
    if (!slow.some((x) => x.url === s.url)) slow.push(s)
  }

  return { failed, slow }
}

/** Check accessibility issues via DOM inspection. */
async function checkAccessibility(evaluate) {
  return evaluate(`
    (() => {
      const issues = [];

      // Buttons without aria-label or text content
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const title = el.getAttribute('title');
        if (!text && !ariaLabel && !ariaLabelledby && !title) {
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + String(el.className).split(' ').filter(Boolean).join('.') : '';
          issues.push({
            type: 'missing-label',
            element: 'button' + id + cls,
            message: 'Button has no accessible name (no text, aria-label, aria-labelledby, or title)',
          });
        }
      });

      // Images without alt
      document.querySelectorAll('img').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const alt = el.getAttribute('alt');
        if (alt === null) {
          const src = (el.src || '').split('/').pop().slice(0, 60);
          issues.push({
            type: 'missing-alt',
            element: 'img[src="...' + src + '"]',
            message: 'Image missing alt attribute',
          });
        }
      });

      // Form inputs without labels
      document.querySelectorAll('input, select, textarea').forEach(el => {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const title = el.getAttribute('title');
        const placeholder = el.getAttribute('placeholder');
        let hasLabel = !!(ariaLabel || ariaLabelledby || title);

        if (!hasLabel && el.id) {
          hasLabel = !!document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        }
        if (!hasLabel) {
          hasLabel = !!el.closest('label');
        }

        if (!hasLabel && !placeholder) {
          const id = el.id ? '#' + el.id : '';
          const name = el.name ? '[name="' + el.name + '"]' : '';
          issues.push({
            type: 'input-no-label',
            element: el.tagName.toLowerCase() + id + name,
            message: 'Form input has no associated label, aria-label, or title',
          });
        }
      });

      // Links without href or with empty href
      document.querySelectorAll('a').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const text = (el.textContent || '').trim();
        if (!text && !el.getAttribute('aria-label')) {
          issues.push({
            type: 'link-no-text',
            element: 'a[href="' + (el.getAttribute('href') || '') + '"]',
            message: 'Link has no accessible text',
          });
        }
      });

      return issues;
    })()
  `)
}

/** Check for broken or empty links. */
async function checkLinks(evaluate) {
  return evaluate(`
    (() => {
      const links = document.querySelectorAll('a[href]');
      const broken = [];
      let total = 0;
      for (const a of links) {
        const style = getComputedStyle(a);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        total++;
        const href = a.getAttribute('href');
        if (!href || href === '#' || href === 'javascript:void(0)' || href === 'javascript:;') {
          broken.push({
            href: href || '(empty)',
            text: (a.textContent || '').trim().slice(0, 80),
          });
        }
      }
      return { broken, total };
    })()
  `)
}

/** Check for visibility issues: zero-size interactive elements, hidden elements with content. */
async function checkVisibility(evaluate) {
  return evaluate(`
    (() => {
      const issues = [];

      // Interactive elements that are zero-size but not display:none
      const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"]';
      document.querySelectorAll(interactiveSelectors).forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = el.getBoundingClientRect();
        if ((rect.width === 0 || rect.height === 0) && el.type !== 'hidden') {
          const id = el.id ? '#' + el.id : '';
          const text = (el.textContent || '').trim().slice(0, 60);
          issues.push({
            type: 'zero-size',
            element: el.tagName.toLowerCase() + id,
            text,
            message: 'Interactive element has zero width or height',
          });
        }
      });

      // Elements with overflow clipping important content
      document.querySelectorAll('main, [role="main"], .container, .content, article, section').forEach(el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (el.scrollWidth > rect.width + 5) {
          issues.push({
            type: 'overflow-x',
            element: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : ''),
            message: 'Element has horizontal overflow (scrollWidth: ' + el.scrollWidth + ', clientWidth: ' + Math.round(rect.width) + ')',
          });
        }
      });

      return issues;
    })()
  `)
}

/** Test responsive layouts at specified widths. */
async function checkResponsive(send, evaluate, widths) {
  const results = {}

  for (const width of widths) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width <= 768,
    })

    // Allow layout to settle
    await new Promise((r) => setTimeout(r, 600))

    const data = await evaluate(`
      (() => {
        const overflowing = [];
        const hidden = [];

        // Check body overflow
        if (document.body.scrollWidth > window.innerWidth + 2) {
          overflowing.push({
            element: 'body',
            scrollWidth: document.body.scrollWidth,
            viewportWidth: window.innerWidth,
          });
        }

        // Check major containers
        const containers = document.querySelectorAll('header, nav, main, footer, section, [role="main"], .container, .wrapper');
        for (const el of containers) {
          const rect = el.getBoundingClientRect();
          if (rect.right > window.innerWidth + 2) {
            const id = el.id ? '#' + el.id : '';
            const tag = el.tagName.toLowerCase();
            overflowing.push({
              element: tag + id,
              right: Math.round(rect.right),
              viewportWidth: window.innerWidth,
            });
          }
        }

        // Check for important elements that become hidden at this width
        const important = document.querySelectorAll('h1, nav, main, [role="navigation"], [role="main"], button[type="submit"], .cta, .hero');
        for (const el of important) {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display === 'none' || (rect.width === 0 && rect.height === 0)) {
            const id = el.id ? '#' + el.id : '';
            const text = (el.textContent || '').trim().slice(0, 60);
            hidden.push({
              element: el.tagName.toLowerCase() + id,
              text,
            });
          }
        }

        return { overflowing, hidden };
      })()
    `)

    results[String(width)] = data
  }

  // Reset viewport
  await send("Emulation.clearDeviceMetricsOverride").catch(() => {})

  return results
}

// ─── Report builder ───

function buildReport(url, checks) {
  const issues = []

  if (checks.console.errors.length > 0) {
    issues.push(`${checks.console.errors.length} console error(s)`)
  }
  if (checks.network.failed.length > 0) {
    issues.push(`${checks.network.failed.length} failed network request(s)`)
  }
  if (checks.accessibility.length > 0) {
    issues.push(`${checks.accessibility.length} accessibility issue(s)`)
  }
  if (checks.links.broken.length > 0) {
    issues.push(`${checks.links.broken.length} broken link(s)`)
  }
  if (checks.visibility && checks.visibility.length > 0) {
    issues.push(`${checks.visibility.length} visibility issue(s)`)
  }
  if (checks.responsive) {
    for (const [width, data] of Object.entries(checks.responsive)) {
      if (data.overflowing.length > 0) {
        issues.push(`${data.overflowing.length} overflow issue(s) at ${width}px`)
      }
    }
  }

  const passed = issues.length === 0
  const summary = passed ? "All checks passed" : `${issues.length} issue(s) found: ${issues.join(", ")}`

  return {
    url,
    timestamp: new Date().toISOString(),
    passed,
    checks: {
      elements: checks.elements,
      console: checks.console,
      network: checks.network,
      accessibility: { issues: checks.accessibility },
      links: checks.links,
      ...(checks.visibility ? { visibility: { issues: checks.visibility } } : {}),
      ...(checks.responsive ? { responsive: checks.responsive } : {}),
    },
    summary,
  }
}

// ─── Pretty console output ───

function printReport(report) {
  const ok = (msg) => console.log(`  \u2713 ${msg}`)
  const warn = (msg) => console.log(`  \u26A0 ${msg}`)
  const fail = (msg) => console.log(`  \u2717 ${msg}`)

  console.log(`\n=== Page Validation Report ===`)
  console.log(`URL: ${report.url}`)
  console.log(`Time: ${report.timestamp}\n`)

  // Elements
  const el = report.checks.elements
  console.log(`[Elements] ${el.total} total, ${el.interactive} interactive, ${el.headings} headings, ${el.images} images, ${el.forms} forms, ${el.links} links`)

  // Console
  if (report.checks.console.errors.length === 0) {
    ok("No console errors")
  } else {
    fail(`${report.checks.console.errors.length} console error(s):`)
    for (const e of report.checks.console.errors.slice(0, 5)) {
      console.log(`    - ${e.slice(0, 200)}`)
    }
  }
  if (report.checks.console.warnings.length > 0) {
    warn(`${report.checks.console.warnings.length} console warning(s)`)
  }

  // Network
  if (report.checks.network.failed.length === 0) {
    ok("No failed network requests")
  } else {
    fail(`${report.checks.network.failed.length} failed request(s):`)
    for (const f of report.checks.network.failed.slice(0, 5)) {
      console.log(`    - ${f.status || f.error}: ${f.url.slice(0, 120)}`)
    }
  }
  if (report.checks.network.slow.length > 0) {
    warn(`${report.checks.network.slow.length} slow request(s):`)
    for (const s of report.checks.network.slow.slice(0, 5)) {
      console.log(`    - ${s.ms}ms: ${s.url.slice(0, 120)}`)
    }
  }

  // Accessibility
  if (report.checks.accessibility.issues.length === 0) {
    ok("No accessibility issues")
  } else {
    warn(`${report.checks.accessibility.issues.length} accessibility issue(s):`)
    for (const a of report.checks.accessibility.issues) {
      console.log(`    - [${a.type}] ${a.element}: ${a.message}`)
    }
  }

  // Links
  if (report.checks.links.broken.length === 0) {
    ok(`All ${report.checks.links.total} links valid`)
  } else {
    warn(`${report.checks.links.broken.length} broken link(s) out of ${report.checks.links.total}:`)
    for (const l of report.checks.links.broken.slice(0, 10)) {
      console.log(`    - href="${l.href}" "${l.text}"`)
    }
  }

  // Visibility
  if (report.checks.visibility) {
    if (report.checks.visibility.issues.length === 0) {
      ok("No visibility issues")
    } else {
      warn(`${report.checks.visibility.issues.length} visibility issue(s):`)
      for (const v of report.checks.visibility.issues) {
        console.log(`    - [${v.type}] ${v.element}: ${v.message}`)
      }
    }
  }

  // Responsive
  if (report.checks.responsive) {
    console.log(`\n[Responsive Layout]`)
    for (const [width, data] of Object.entries(report.checks.responsive)) {
      const issues = data.overflowing.length + data.hidden.length
      if (issues === 0) {
        ok(`${width}px — no issues`)
      } else {
        warn(`${width}px — ${issues} issue(s)`)
        for (const o of data.overflowing) {
          console.log(`    - overflow: ${o.element} (right: ${o.right || o.scrollWidth}px > viewport: ${o.viewportWidth}px)`)
        }
        for (const h of data.hidden) {
          console.log(`    - hidden: ${h.element} "${h.text}"`)
        }
      }
    }
  }

  console.log(`\n${report.passed ? "PASSED" : "ISSUES FOUND"}: ${report.summary}\n`)
}

// ─── Main ───

async function main() {
  const cdp = await connectCDP()
  const { send, evaluate, onEvent, pageInfo, ws } = cdp

  // Navigate to target URL if specified
  if (targetUrl) {
    await send("Page.enable")
    await send("Page.navigate", { url: targetUrl })
    // Wait for load
    await new Promise((resolve) => {
      const handler = () => resolve()
      onEvent("Page.loadEventFired", handler)
      // Fallback timeout
      setTimeout(resolve, 10000)
    })
    await new Promise((r) => setTimeout(r, 1000))
  }

  const currentUrl = await evaluate("location.href")

  console.log(`Validating: ${currentUrl}`)
  console.log(`CDP port: ${CDP_PORT}`)

  // Run checks
  const elements = await checkElements(evaluate)
  console.log(`Scanning... ${elements.total} elements found`)

  const consoleResult = await checkConsole(send, onEvent)
  const networkResult = await checkNetwork(send, onEvent, evaluate)
  const accessibilityResult = await checkAccessibility(evaluate)
  const linksResult = await checkLinks(evaluate)

  let visibilityResult = null
  let responsiveResult = null

  if (runFull) {
    visibilityResult = await checkVisibility(evaluate)
  }

  if (runResponsive) {
    responsiveResult = await checkResponsive(send, evaluate, RESPONSIVE_WIDTHS)
  }

  const report = buildReport(currentUrl, {
    elements,
    console: consoleResult,
    network: networkResult,
    accessibility: accessibilityResult,
    links: linksResult,
    visibility: visibilityResult,
    responsive: responsiveResult,
  })

  printReport(report)

  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(report, null, 2))
    console.log(`Report saved to: ${outputFile}`)
  }

  ws.close()
  process.exit(report.passed ? 0 : 1)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(2)
})

#!/usr/bin/env node
/**
 * Build Loop Orchestrator — Autonomous build-validate loop for the AI Factory.
 *
 * The "eyes" of the agent: scans the browser DOM and compares against a project spec
 * to report what's missing, broken, or incorrect. The agent (Claude Code) does the
 * actual code editing, then runs build-loop again to verify.
 *
 * Usage:
 *   CDP_PORT=9222 node cli/build-loop.mjs --spec project-spec.json [--page home] [--fix-report] [--json]
 *
 * Flags:
 *   --spec <path>       Path to the project spec JSON file (required)
 *   --page <name>       Only check a specific page by name (optional, checks all if omitted)
 *   --fix-report        Output actionable fix instructions for each failure
 *   --json              Output results as JSON instead of formatted text
 *   --port <number>     CDP port (default: 9222 or CDP_PORT env)
 *   --timeout <ms>      Navigation timeout in ms (default: 10000)
 *   --verbose           Show extra diagnostic output
 */

import http from "http"
import fs from "fs"
import path from "path"

// ─── Parse flags ───

const rawArgs = process.argv.slice(2)

function getFlag(name) {
  const idx = rawArgs.indexOf(name)
  if (idx === -1) return null
  return rawArgs[idx + 1] || null
}

function hasFlag(name) {
  return rawArgs.includes(name)
}

const specPath = getFlag("--spec")
const pageFilter = getFlag("--page")
const fixReport = hasFlag("--fix-report")
const jsonOutput = hasFlag("--json")
const verbose = hasFlag("--verbose")
const CDP_PORT = parseInt(getFlag("--port") || process.env.CDP_PORT || "9222")
const NAV_TIMEOUT = parseInt(getFlag("--timeout") || "10000")

// ─── Usage ───

if (!specPath || hasFlag("--help") || hasFlag("-h")) {
  console.log(`
Build Loop Orchestrator — Autonomous build-validate loop

Usage:
  CDP_PORT=9222 node cli/build-loop.mjs --spec <path> [options]

Required:
  --spec <path>       Path to the project spec JSON file

Options:
  --page <name>       Only check a specific page (by name, case-insensitive)
  --fix-report        Include actionable fix instructions for failures
  --json              Output results as JSON
  --port <number>     CDP port (default: 9222 or CDP_PORT env var)
  --timeout <ms>      Navigation timeout (default: 10000)
  --verbose           Show extra diagnostic output

Spec format:
  {
    "name": "Project Name",
    "baseUrl": "http://localhost:3000",
    "pages": [
      {
        "name": "Home",
        "path": "/",
        "expectedElements": [
          { "description": "Nav bar", "selector": "nav", "required": true }
        ],
        "expectedText": ["Welcome"],
        "expectedLinks": ["/about"]
      }
    ]
  }

Examples:
  node cli/build-loop.mjs --spec cli/specs/portfolio-site.json
  node cli/build-loop.mjs --spec spec.json --page Home --fix-report
  node cli/build-loop.mjs --spec spec.json --json
`)
  process.exit(0)
}

// ─── Load spec ───

const resolvedSpecPath = path.resolve(specPath)
if (!fs.existsSync(resolvedSpecPath)) {
  console.error(`Error: Spec file not found: ${resolvedSpecPath}`)
  process.exit(1)
}

let spec
try {
  spec = JSON.parse(fs.readFileSync(resolvedSpecPath, "utf-8"))
} catch (e) {
  console.error(`Error: Failed to parse spec file: ${e.message}`)
  process.exit(1)
}

if (!spec.pages || !Array.isArray(spec.pages) || spec.pages.length === 0) {
  console.error("Error: Spec must contain a 'pages' array with at least one page")
  process.exit(1)
}

const baseUrl = (spec.baseUrl || "http://localhost:3000").replace(/\/$/, "")

// ─── CDP connection ───

async function connectCDP() {
  let targets
  try {
    targets = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve(JSON.parse(data)))
      }).on("error", reject)
    })
  } catch (e) {
    return { error: `Cannot connect to CDP on port ${CDP_PORT}. Is the browser running with --remote-debugging-port=${CDP_PORT}?` }
  }

  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://")
  )
  if (!page) {
    return { error: "No page tab found in CDP targets" }
  }

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

  async function navigate(url) {
    await send("Page.enable")
    await send("Page.navigate", { url })
    // Wait for load event
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), NAV_TIMEOUT)
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.method === "Page.loadEventFired") {
          ws.off("message", handler)
          clearTimeout(timeout)
          resolve()
        }
      }
      ws.on("message", handler)
    })
    // Extra settle time for client-side rendering
    await new Promise((r) => setTimeout(r, 1500))
  }

  return { ws, send, evaluate, navigate, page }
}

// ─── Inject the __ftQuery helper for :has-text() support ───

async function injectQueryHelper(evaluate) {
  await evaluate(`
    if (!window.__ftQuery) {
      window.__ftQuery = function(selector) {
        // Check if selector uses :has-text() pseudo-selector
        const hasTextMatch = selector.match(/^(.+?):has-text\\\\(['"](.+?)['"]\\\\)$/);
        if (hasTextMatch) {
          const [, tagPart, text] = hasTextMatch;
          const tag = tagPart.trim() || '*';
          const candidates = document.querySelectorAll(tag);
          const lower = text.toLowerCase();
          for (const el of candidates) {
            if (el.textContent && el.textContent.trim().toLowerCase().includes(lower)) {
              return el;
            }
          }
          return null;
        }

        // Check for container:has-text('X') child patterns
        const containerMatch = selector.match(/^(\\\\w+):has-text\\\\(['"](.+?)['"]\\\\)\\\\s+(.+)$/);
        if (containerMatch) {
          const [, container, text, child] = containerMatch;
          const containers = document.querySelectorAll(container);
          const lower = text.toLowerCase();
          for (const el of containers) {
            if (el.textContent && el.textContent.trim().toLowerCase().includes(lower)) {
              const found = el.querySelector(child);
              if (found) return found;
            }
          }
          return null;
        }

        // Standard querySelector
        try {
          return document.querySelector(selector);
        } catch (e) {
          return null;
        }
      };

      window.__ftQueryAll = function(selector) {
        const hasTextMatch = selector.match(/^(.+?):has-text\\\\(['"](.+?)['"]\\\\)$/);
        if (hasTextMatch) {
          const [, tagPart, text] = hasTextMatch;
          const tag = tagPart.trim() || '*';
          const candidates = document.querySelectorAll(tag);
          const lower = text.toLowerCase();
          const results = [];
          for (const el of candidates) {
            if (el.textContent && el.textContent.trim().toLowerCase().includes(lower)) {
              results.push(el);
            }
          }
          return results;
        }
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch (e) {
          return [];
        }
      };
    }
  `)
}

// ─── Check a single element against the DOM ───

async function checkElement(evaluate, element) {
  const { description, selector, required } = element
  // selector can be comma-separated alternatives
  const selectors = selector.split(",").map((s) => s.trim())

  const result = await evaluate(`
    (() => {
      const selectors = ${JSON.stringify(selectors)};
      for (const sel of selectors) {
        try {
          const el = window.__ftQuery(sel);
          if (el) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;

            const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
            const tag = el.tagName.toLowerCase();
            const childCount = el.children.length;
            const linkCount = el.querySelectorAll('a').length;
            const matchedSelector = sel;
            return {
              found: true,
              tag,
              text: text.slice(0, 120),
              childCount,
              linkCount,
              matchedSelector,
              rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
            };
          }
        } catch (e) {
          // selector parse error, try next
        }
      }
      return { found: false };
    })()
  `)

  return {
    description,
    selector,
    required: required !== false,
    ...result,
  }
}

// ─── Check text content on page ───

async function checkText(evaluate, textList) {
  if (!textList || textList.length === 0) return []

  return evaluate(`
    (() => {
      const bodyText = document.body.innerText || document.body.textContent || '';
      const texts = ${JSON.stringify(textList)};
      return texts.map(t => ({
        text: t,
        found: bodyText.toLowerCase().includes(t.toLowerCase()),
      }));
    })()
  `)
}

// ─── Check links on page ───

async function checkLinks(evaluate, linkList) {
  if (!linkList || linkList.length === 0) return []

  return evaluate(`
    (() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const hrefs = links.map(a => {
        try {
          return new URL(a.href).pathname;
        } catch {
          return a.getAttribute('href');
        }
      });
      const expected = ${JSON.stringify(linkList)};
      return expected.map(link => ({
        link,
        found: hrefs.some(h => h === link || h.startsWith(link + '/') || h.startsWith(link + '?')),
      }));
    })()
  `)
}

// ─── Check console errors ───

async function checkConsoleErrors(send) {
  // Enable console domain and collect errors
  try {
    await send("Console.enable")
  } catch {
    // might already be enabled
  }
  // Get any logged errors from Runtime
  try {
    const errors = []
    // We can't retroactively get console messages via CDP easily,
    // but we can check for uncaught exceptions via evaluate
    return errors
  } catch {
    return []
  }
}

// ─── Format output ───

function formatReport(specName, pageResults) {
  const lines = []
  lines.push("")
  lines.push(`=== Build Loop Report: ${specName} ===`)
  lines.push("")

  let totalChecks = 0
  let totalPassed = 0
  let pagesChecked = 0

  for (const page of pageResults) {
    pagesChecked++
    lines.push(`Page: ${page.name} (${page.path})`)

    // Element checks
    if (page.elements && page.elements.length > 0) {
      for (const el of page.elements) {
        totalChecks++
        if (el.found) {
          totalPassed++
          let detail = `found <${el.tag}>`
          if (el.linkCount > 0) detail += ` with ${el.linkCount} links`
          else if (el.childCount > 0) detail += ` with ${el.childCount} children`
          if (el.text && el.text.length > 0 && el.text.length < 80) detail += ` "${el.text}"`
          lines.push(`  \u2713 ${el.description} \u2014 ${detail}`)
        } else {
          const marker = el.required ? "\u2717" : "\u25CB"
          lines.push(`  ${marker} ${el.description} \u2014 NOT FOUND (expected ${el.selector})`)
          if (fixReport) {
            lines.push(`    \u2192 FIX: Add a matching element for "${el.description}" using selector: ${el.selector}`)
          }
        }
      }
    }

    // Text checks
    if (page.textResults && page.textResults.length > 0) {
      lines.push("")
      lines.push("  Text check:")
      for (const t of page.textResults) {
        totalChecks++
        if (t.found) {
          totalPassed++
          lines.push(`    \u2713 "${t.text}" found in page`)
        } else {
          lines.push(`    \u2717 "${t.text}" NOT found`)
          if (fixReport) {
            lines.push(`      \u2192 FIX: Add text content "${t.text}" to the page`)
          }
        }
      }
    }

    // Link checks
    if (page.linkResults && page.linkResults.length > 0) {
      lines.push("")
      lines.push("  Link check:")
      for (const l of page.linkResults) {
        totalChecks++
        if (l.found) {
          totalPassed++
          lines.push(`    \u2713 ${l.link} \u2014 link exists`)
        } else {
          lines.push(`    \u2717 ${l.link} \u2014 link NOT found`)
          if (fixReport) {
            lines.push(`      \u2192 FIX: Add an <a href="${l.link}"> link to the page`)
          }
        }
      }
    }

    // Navigation error
    if (page.navigationError) {
      lines.push(`  !! Navigation failed: ${page.navigationError}`)
    }

    // Score
    const pageChecks = (page.elements?.length || 0) + (page.textResults?.length || 0) + (page.linkResults?.length || 0)
    const pagePassed =
      (page.elements?.filter((e) => e.found).length || 0) +
      (page.textResults?.filter((t) => t.found).length || 0) +
      (page.linkResults?.filter((l) => l.found).length || 0)
    const pct = pageChecks > 0 ? Math.round((pagePassed / pageChecks) * 100) : 0
    lines.push("")
    lines.push(`  Score: ${pagePassed}/${pageChecks} checks passed (${pct}%)`)

    let status
    if (pct === 100) status = "PASSING"
    else if (pct >= 80) status = "ALMOST THERE"
    else if (pct >= 50) status = "NEEDS WORK"
    else status = "FAILING"
    lines.push(`  Status: ${status}`)
    lines.push("")
  }

  // Overall
  const overallPct = totalChecks > 0 ? Math.round((totalPassed / totalChecks) * 100) : 0
  lines.push(`Overall: ${pagesChecked}/${pageResults.length} pages checked, ${overallPct}% passing`)
  lines.push("")

  return lines.join("\n")
}

// ─── Main ───

async function main() {
  // Step 1: Connect to CDP
  if (verbose) console.error(`Connecting to CDP on port ${CDP_PORT}...`)

  const cdp = await connectCDP()
  if (cdp.error) {
    console.error(`Error: ${cdp.error}`)
    process.exit(1)
  }

  const { evaluate, navigate, ws } = cdp

  if (verbose) console.error(`Connected. Current page: ${cdp.page.url}`)

  try {
    // Filter pages if --page specified
    let pages = spec.pages
    if (pageFilter) {
      const lower = pageFilter.toLowerCase()
      pages = pages.filter((p) => p.name.toLowerCase() === lower || p.name.toLowerCase().includes(lower))
      if (pages.length === 0) {
        console.error(`Error: No page matching "${pageFilter}" found in spec`)
        console.error(`Available pages: ${spec.pages.map((p) => p.name).join(", ")}`)
        process.exit(1)
      }
    }

    const pageResults = []

    for (const page of pages) {
      const url = `${baseUrl}${page.path}`

      if (verbose) console.error(`\nNavigating to ${url}...`)

      const result = {
        name: page.name,
        path: page.path,
        url,
        elements: [],
        textResults: [],
        linkResults: [],
        navigationError: null,
      }

      // Navigate to the page
      try {
        await navigate(url)
      } catch (e) {
        result.navigationError = e.message
        pageResults.push(result)
        continue
      }

      // Inject query helper for :has-text() support
      await injectQueryHelper(evaluate)

      // Check expected elements
      if (page.expectedElements && page.expectedElements.length > 0) {
        for (const el of page.expectedElements) {
          const check = await checkElement(evaluate, el)
          result.elements.push(check)
        }
      }

      // Check expected text
      if (page.expectedText && page.expectedText.length > 0) {
        result.textResults = await checkText(evaluate, page.expectedText)
      }

      // Check expected links
      if (page.expectedLinks && page.expectedLinks.length > 0) {
        result.linkResults = await checkLinks(evaluate, page.expectedLinks)
      }

      pageResults.push(result)
    }

    // Output
    if (jsonOutput) {
      const jsonResult = {
        spec: spec.name || "Unnamed Project",
        timestamp: new Date().toISOString(),
        baseUrl,
        pages: pageResults.map((p) => {
          const checks =
            (p.elements?.length || 0) + (p.textResults?.length || 0) + (p.linkResults?.length || 0)
          const passed =
            (p.elements?.filter((e) => e.found).length || 0) +
            (p.textResults?.filter((t) => t.found).length || 0) +
            (p.linkResults?.filter((l) => l.found).length || 0)
          return {
            name: p.name,
            path: p.path,
            url: p.url,
            elements: p.elements,
            textResults: p.textResults,
            linkResults: p.linkResults,
            navigationError: p.navigationError,
            score: { passed, total: checks, pct: checks > 0 ? Math.round((passed / checks) * 100) : 0 },
          }
        }),
      }
      console.log(JSON.stringify(jsonResult, null, 2))
    } else {
      console.log(formatReport(spec.name || "Unnamed Project", pageResults))
    }

    // Exit with code based on results
    const allPassed = pageResults.every((p) => {
      const total = (p.elements?.length || 0) + (p.textResults?.length || 0) + (p.linkResults?.length || 0)
      const passed =
        (p.elements?.filter((e) => e.found).length || 0) +
        (p.textResults?.filter((t) => t.found).length || 0) +
        (p.linkResults?.filter((l) => l.found).length || 0)
      return total === passed && !p.navigationError
    })

    ws.close()
    process.exit(allPassed ? 0 : 1)
  } catch (e) {
    console.error(`Fatal error: ${e.message}`)
    if (verbose) console.error(e.stack)
    ws.close()
    process.exit(2)
  }
}

main()

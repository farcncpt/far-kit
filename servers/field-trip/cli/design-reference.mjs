#!/usr/bin/env node
/**
 * Design Reference — Capture and compare DOM snapshots as design references.
 *
 * Connects to a running page via CDP (Chrome DevTools Protocol) and captures
 * element positions, styles, and text as a JSON reference file. Can later
 * compare a live page against a saved reference to detect discrepancies.
 *
 * Usage:
 *   node cli/design-reference.mjs capture --name "hero-section" --selector "#hero"
 *   node cli/design-reference.mjs capture --name "full-page" --url http://localhost:3000/about
 *   node cli/design-reference.mjs compare --reference hero-section.json
 *   node cli/design-reference.mjs compare --name hero-section
 *   node cli/design-reference.mjs list
 *   node cli/design-reference.mjs show --name hero-section
 *
 * Environment:
 *   CDP_PORT=9222   — Chrome DevTools port (default: 9222)
 *   RELAY_PORT=9333 — WebSocket relay port (optional, uses CDP if not available)
 */

import fs from "node:fs"
import path from "node:path"
import http from "node:http"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REFERENCES_DIR = path.join(__dirname, "references")

const CDP_PORT = parseInt(process.env.CDP_PORT || "9222")

// ─── Logging ───

function progress(msg) {
  process.stderr.write(`\x1b[36m[design-ref]\x1b[0m ${msg}\n`)
}

function error(msg) {
  process.stderr.write(`\x1b[31m[design-ref] ERROR:\x1b[0m ${msg}\n`)
}

function warn(msg) {
  process.stderr.write(`\x1b[33m[design-ref] WARN:\x1b[0m ${msg}\n`)
}

// ─── CDP connection (reused from existing CLI patterns) ───

async function connectCDP(port = CDP_PORT) {
  const targets = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/json`, (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve(JSON.parse(data)))
      })
      .on("error", (err) => {
        reject(
          new Error(
            `Cannot connect to Chrome on port ${port}: ${err.message}\n` +
              `Start Chrome with: --remote-debugging-port=${port}`
          )
        )
      })
  })

  const page = targets.find(
    (t) =>
      t.type === "page" &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("devtools://") &&
      !t.url.startsWith("chrome-extension://")
  )
  if (!page) {
    throw new Error("No page tab found. Open a page in Chrome first.")
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
        () => reject(new Error(`CDP timeout on ${method}`)),
        15000
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
      throw new Error(
        result.exceptionDetails.exception?.description || "eval failed"
      )
    }
    return result.result?.value
  }

  return { ws, send, evaluate, page }
}

// ─── Element capture ───

function buildCaptureScript(selector, depth) {
  // This script runs in the browser context and captures element details
  return `
    (() => {
      const rootSelector = ${JSON.stringify(selector || "body")};
      const maxDepth = ${depth || 5};
      const root = document.querySelector(rootSelector);
      if (!root) return { error: 'Selector not found: ' + rootSelector };

      const elements = [];
      const STYLE_PROPS = [
        'fontSize', 'fontWeight', 'fontFamily', 'fontStyle',
        'color', 'backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'borderStyle',
        'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
        'display', 'position', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
        'width', 'height', 'maxWidth', 'minHeight',
        'textAlign', 'textDecoration', 'lineHeight', 'letterSpacing',
        'opacity', 'boxShadow', 'overflow', 'zIndex',
        'gridTemplateColumns', 'gridTemplateRows',
      ];

      function getSelector(el) {
        if (el.id) return '#' + el.id;
        const tag = el.tagName.toLowerCase();
        const classes = [...el.classList].filter(c => !c.startsWith('__')).slice(0, 3);
        let sel = tag;
        if (classes.length > 0) sel += '.' + classes.join('.');

        // Add nth-child if needed for uniqueness
        const parent = el.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(c => c.tagName === el.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(el) + 1;
            sel += ':nth-child(' + idx + ')';
          }
        }
        return sel;
      }

      function getPath(el) {
        const parts = [];
        let current = el;
        while (current && current !== document.body && parts.length < 5) {
          parts.unshift(getSelector(current));
          current = current.parentElement;
        }
        return parts.join(' > ');
      }

      function captureElement(el, depth) {
        if (depth > maxDepth) return;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const tag = el.tagName.toLowerCase();
        const text = el.childNodes.length > 0
          ? [...el.childNodes]
              .filter(n => n.nodeType === 3)
              .map(n => n.textContent.trim())
              .filter(Boolean)
              .join(' ')
              .slice(0, 200)
          : '';

        const styles = {};
        for (const prop of STYLE_PROPS) {
          const val = style[prop];
          if (val && val !== 'normal' && val !== 'none' && val !== '0px' && val !== 'auto' && val !== 'rgba(0, 0, 0, 0)' && val !== 'start') {
            styles[prop] = val;
          }
        }

        const entry = {
          selector: getPath(el),
          tag,
          id: el.id || undefined,
          className: el.className?.toString?.()?.trim()?.slice(0, 120) || undefined,
          text: text || undefined,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          href: el.href ? el.href.slice(0, 150) : undefined,
          src: el.src ? el.src.slice(0, 150) : undefined,
          alt: el.alt || undefined,
          type: el.type || undefined,
          name: el.name || undefined,
          placeholder: el.placeholder || undefined,
          dataTestid: el.getAttribute('data-testid') || undefined,
          dataSection: el.getAttribute('data-section') || undefined,
          styles,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          visible: rect.width > 0 && rect.height > 0 && style.opacity !== '0',
        };

        // Clean up undefined values
        for (const k of Object.keys(entry)) {
          if (entry[k] === undefined) delete entry[k];
        }

        elements.push(entry);

        // Recurse into children
        for (const child of el.children) {
          captureElement(child, depth + 1);
        }
      }

      captureElement(root, 0);

      return {
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        },
        rootSelector: rootSelector,
        rootRect: (() => {
          const r = root.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        })(),
        elementCount: elements.length,
        elements,
      };
    })()
  `
}

// ─── Comparison engine ───

function compareReferences(reference, current) {
  const issues = []
  const refElements = reference.elements || []
  const curElements = current.elements || []

  // Build lookup maps by selector
  const refMap = new Map()
  for (const el of refElements) {
    refMap.set(el.selector, el)
  }

  const curMap = new Map()
  for (const el of curElements) {
    curMap.set(el.selector, el)
  }

  // Check for missing elements
  for (const [selector, refEl] of refMap) {
    if (!curMap.has(selector)) {
      issues.push({
        type: "missing",
        severity: "error",
        selector,
        message: `Element missing: <${refEl.tag}> "${(refEl.text || "").slice(0, 50)}"`,
        expected: refEl,
      })
      continue
    }

    const curEl = curMap.get(selector)

    // Check text content
    if (refEl.text && curEl.text !== refEl.text) {
      issues.push({
        type: "text_changed",
        severity: "warning",
        selector,
        message: `Text changed`,
        expected: refEl.text,
        actual: curEl.text,
      })
    }

    // Check visibility
    if (refEl.visible && !curEl.visible) {
      issues.push({
        type: "invisible",
        severity: "error",
        selector,
        message: `Element no longer visible`,
      })
    }

    // Check styles
    if (refEl.styles && curEl.styles) {
      for (const [prop, expectedVal] of Object.entries(refEl.styles)) {
        const actualVal = curEl.styles[prop]
        if (!actualVal) {
          issues.push({
            type: "style_missing",
            severity: "warning",
            selector,
            property: prop,
            message: `Style property removed: ${prop}`,
            expected: expectedVal,
          })
          continue
        }

        // Fuzzy comparison for certain properties
        if (isSignificantStyleDiff(prop, expectedVal, actualVal)) {
          issues.push({
            type: "style_changed",
            severity: "warning",
            selector,
            property: prop,
            message: `Style changed: ${prop}`,
            expected: expectedVal,
            actual: actualVal,
          })
        }
      }
    }

    // Check position/size (with tolerance)
    if (refEl.rect && curEl.rect) {
      const tolerance = 10 // px
      const dx = Math.abs(refEl.rect.x - curEl.rect.x)
      const dy = Math.abs(refEl.rect.y - curEl.rect.y)
      const dw = Math.abs(refEl.rect.width - curEl.rect.width)
      const dh = Math.abs(refEl.rect.height - curEl.rect.height)

      if (dw > tolerance || dh > tolerance) {
        issues.push({
          type: "size_changed",
          severity: "warning",
          selector,
          message: `Size changed: ${refEl.rect.width}x${refEl.rect.height} -> ${curEl.rect.width}x${curEl.rect.height}`,
          expected: refEl.rect,
          actual: curEl.rect,
        })
      }

      if (dx > tolerance * 5 || dy > tolerance * 5) {
        issues.push({
          type: "position_shifted",
          severity: "info",
          selector,
          message: `Position shifted: (${refEl.rect.x},${refEl.rect.y}) -> (${curEl.rect.x},${curEl.rect.y})`,
          expected: refEl.rect,
          actual: curEl.rect,
        })
      }
    }
  }

  // Check for new elements (not in reference)
  for (const [selector, curEl] of curMap) {
    if (!refMap.has(selector)) {
      issues.push({
        type: "new_element",
        severity: "info",
        selector,
        message: `New element: <${curEl.tag}> "${(curEl.text || "").slice(0, 50)}"`,
      })
    }
  }

  return issues
}

function isSignificantStyleDiff(prop, expected, actual) {
  if (expected === actual) return false

  // For numeric values, allow small tolerance
  const numExpected = parseFloat(expected)
  const numActual = parseFloat(actual)
  if (!isNaN(numExpected) && !isNaN(numActual)) {
    // Tolerance based on property
    const tolerance = prop.includes("font") ? 1 : 2
    return Math.abs(numExpected - numActual) > tolerance
  }

  // For colors, normalize and compare
  if (prop.toLowerCase().includes("color")) {
    return normalizeColor(expected) !== normalizeColor(actual)
  }

  // String comparison
  return expected !== actual
}

function normalizeColor(color) {
  // Basic normalization — strip spaces in rgb/rgba
  return (color || "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/rgba?\(([^)]+)\)/, (_, args) => {
      const parts = args.split(",").map((p) => p.trim())
      return `rgba(${parts.join(",")})`
    })
}

// ─── Commands ───

async function cmdCapture(options) {
  const name = options.name
  const selector = options.selector || "body"
  const depth = parseInt(options.depth || "5")

  if (!name) {
    error("--name is required for capture")
    process.exit(1)
  }

  progress(`Connecting to Chrome on port ${CDP_PORT}...`)
  const { ws, evaluate, page } = await connectCDP()

  try {
    progress(`Capturing: "${name}" (selector: ${selector}, depth: ${depth})`)

    // Navigate to URL if specified
    if (options.url) {
      const currentUrl = await evaluate("location.href")
      if (currentUrl !== options.url) {
        progress(`Navigating to ${options.url}...`)
        await evaluate(`location.href = ${JSON.stringify(options.url)}`)
        // Wait for load
        await new Promise((r) => setTimeout(r, 3000))
        await evaluate(
          "new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', r); })"
        )
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    const result = await evaluate(buildCaptureScript(selector, depth))

    if (result.error) {
      error(result.error)
      process.exit(1)
    }

    // Build reference object
    const reference = {
      name,
      url: result.url,
      capturedAt: new Date().toISOString(),
      viewport: result.viewport,
      rootSelector: result.rootSelector,
      rootRect: result.rootRect,
      elementCount: result.elementCount,
      elements: result.elements,
    }

    // Ensure references directory exists
    if (!fs.existsSync(REFERENCES_DIR)) {
      fs.mkdirSync(REFERENCES_DIR, { recursive: true })
    }

    // Save reference
    const outputFile = options.output
      ? path.resolve(options.output)
      : path.join(REFERENCES_DIR, `${slugify(name)}.json`)

    fs.writeFileSync(outputFile, JSON.stringify(reference, null, 2) + "\n")

    progress(`Captured ${result.elementCount} elements`)
    progress(`Saved to: ${outputFile}`)

    // Print summary
    const tags = {}
    for (const el of result.elements) {
      tags[el.tag] = (tags[el.tag] || 0) + 1
    }
    progress(
      `Elements by tag: ${Object.entries(tags)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t}(${c})`)
        .join(", ")}`
    )
  } finally {
    ws.close()
  }
}

async function cmdCompare(options) {
  // Load reference
  let referencePath
  if (options.reference) {
    referencePath = path.resolve(options.reference)
  } else if (options.name) {
    referencePath = path.join(REFERENCES_DIR, `${slugify(options.name)}.json`)
  } else {
    error("--reference <file> or --name <name> is required")
    process.exit(1)
  }

  if (!fs.existsSync(referencePath)) {
    error(`Reference file not found: ${referencePath}`)
    process.exit(1)
  }

  const reference = JSON.parse(fs.readFileSync(referencePath, "utf-8"))
  progress(`Loaded reference: "${reference.name}" (${reference.elementCount} elements)`)
  progress(`Captured at: ${reference.capturedAt}`)

  // Connect and capture current state
  progress(`Connecting to Chrome on port ${CDP_PORT}...`)
  const { ws, evaluate } = await connectCDP()

  try {
    // Navigate to same URL if needed
    const currentUrl = await evaluate("location.href")
    if (options.url) {
      if (currentUrl !== options.url) {
        progress(`Navigating to ${options.url}...`)
        await evaluate(`location.href = ${JSON.stringify(options.url)}`)
        await new Promise((r) => setTimeout(r, 3000))
        await evaluate(
          "new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', r); })"
        )
        await new Promise((r) => setTimeout(r, 1000))
      }
    } else if (reference.url && currentUrl !== reference.url) {
      warn(
        `Current URL (${currentUrl}) differs from reference (${reference.url}).`
      )
      warn("Use --url to navigate, or ensure you're on the correct page.")
    }

    // Capture current state with same selector
    const selector = options.selector || reference.rootSelector || "body"
    const depth = parseInt(options.depth || "5")

    progress(`Capturing current state (selector: ${selector})...`)
    const current = await evaluate(buildCaptureScript(selector, depth))

    if (current.error) {
      error(current.error)
      process.exit(1)
    }

    // Compare
    progress("Comparing against reference...")
    const issues = compareReferences(reference, current)

    // Report
    const errors = issues.filter((i) => i.severity === "error")
    const warnings = issues.filter((i) => i.severity === "warning")
    const infos = issues.filter((i) => i.severity === "info")

    console.log("")
    console.log(
      `Design Reference Comparison: "${reference.name}"`
    )
    console.log("=".repeat(60))
    console.log(
      `Reference: ${reference.elementCount} elements (captured ${reference.capturedAt})`
    )
    console.log(`Current:   ${current.elementCount} elements`)
    console.log("")

    if (issues.length === 0) {
      console.log("\x1b[32mPASS\x1b[0m — No discrepancies found.")
    } else {
      if (errors.length > 0) {
        console.log(`\x1b[31mERRORS (${errors.length}):\x1b[0m`)
        for (const issue of errors) {
          console.log(`  [ERROR] ${issue.message}`)
          console.log(`          Selector: ${issue.selector}`)
          if (issue.expected && typeof issue.expected === "string")
            console.log(`          Expected: ${issue.expected}`)
          if (issue.actual) console.log(`          Actual: ${issue.actual}`)
        }
        console.log("")
      }

      if (warnings.length > 0) {
        console.log(`\x1b[33mWARNINGS (${warnings.length}):\x1b[0m`)
        for (const issue of warnings) {
          console.log(`  [WARN] ${issue.message}`)
          console.log(`         Selector: ${issue.selector}`)
          if (issue.expected && typeof issue.expected === "string")
            console.log(`         Expected: ${issue.expected}`)
          if (issue.actual && typeof issue.actual === "string")
            console.log(`         Actual: ${issue.actual}`)
          if (issue.property) console.log(`         Property: ${issue.property}`)
        }
        console.log("")
      }

      if (infos.length > 0) {
        console.log(`\x1b[36mINFO (${infos.length}):\x1b[0m`)
        for (const issue of infos) {
          console.log(`  [INFO] ${issue.message}`)
          console.log(`         Selector: ${issue.selector}`)
        }
        console.log("")
      }

      console.log(
        `Summary: ${errors.length} errors, ${warnings.length} warnings, ${infos.length} info`
      )

      // Write detailed report as JSON if --report specified
      if (options.report) {
        const reportPath = path.resolve(options.report)
        const report = {
          reference: reference.name,
          referenceFile: referencePath,
          comparedAt: new Date().toISOString(),
          referenceUrl: reference.url,
          currentUrl: current.url,
          referenceElements: reference.elementCount,
          currentElements: current.elementCount,
          summary: {
            errors: errors.length,
            warnings: warnings.length,
            info: infos.length,
            total: issues.length,
          },
          issues,
        }
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")
        progress(`Detailed report saved to: ${reportPath}`)
      }
    }

    // Exit code based on severity
    if (errors.length > 0) process.exit(1)
  } finally {
    ws.close()
  }
}

function cmdList() {
  if (!fs.existsSync(REFERENCES_DIR)) {
    console.log("No references directory found.")
    console.log(`Expected at: ${REFERENCES_DIR}`)
    return
  }

  const files = fs
    .readdirSync(REFERENCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()

  if (files.length === 0) {
    console.log("No design references saved yet.")
    console.log(
      `Capture one with: node cli/design-reference.mjs capture --name "my-section" --selector "#section"`
    )
    return
  }

  console.log(`Design References (${files.length}):`)
  console.log("")

  for (const file of files) {
    try {
      const ref = JSON.parse(
        fs.readFileSync(path.join(REFERENCES_DIR, file), "utf-8")
      )
      const date = ref.capturedAt
        ? new Date(ref.capturedAt).toLocaleDateString()
        : "?"
      console.log(
        `  ${ref.name || file.replace(".json", "")}` +
          `\t${ref.elementCount || "?"} elements` +
          `\t${ref.rootSelector || "body"}` +
          `\t${date}`
      )
      if (ref.url) console.log(`  \t${ref.url}`)
    } catch {
      console.log(`  ${file}\t(invalid JSON)`)
    }
  }
}

function cmdShow(options) {
  const name = options.name
  if (!name) {
    error("--name is required")
    process.exit(1)
  }

  const refPath = path.join(REFERENCES_DIR, `${slugify(name)}.json`)
  if (!fs.existsSync(refPath)) {
    error(`Reference not found: ${refPath}`)
    process.exit(1)
  }

  const ref = JSON.parse(fs.readFileSync(refPath, "utf-8"))

  console.log(`Reference: ${ref.name}`)
  console.log(`URL: ${ref.url}`)
  console.log(`Captured: ${ref.capturedAt}`)
  console.log(
    `Viewport: ${ref.viewport?.width}x${ref.viewport?.height} @${ref.viewport?.devicePixelRatio}x`
  )
  console.log(`Selector: ${ref.rootSelector}`)
  console.log(`Elements: ${ref.elementCount}`)
  console.log("")

  for (const el of ref.elements) {
    const parts = [`<${el.tag}>`]
    if (el.id) parts.push(`id="${el.id}"`)
    if (el.role) parts.push(`role="${el.role}"`)
    if (el.dataTestid) parts.push(`data-testid="${el.dataTestid}"`)
    if (el.dataSection) parts.push(`data-section="${el.dataSection}"`)

    const styleSummary = []
    if (el.styles?.fontSize) styleSummary.push(`font:${el.styles.fontSize}`)
    if (el.styles?.fontWeight) styleSummary.push(`weight:${el.styles.fontWeight}`)
    if (el.styles?.color) styleSummary.push(`color:${el.styles.color.slice(0, 20)}`)
    if (el.styles?.display) styleSummary.push(`display:${el.styles.display}`)

    if (styleSummary.length > 0) parts.push(`[${styleSummary.join(", ")}]`)

    if (el.rect) {
      parts.push(`${el.rect.width}x${el.rect.height}@(${el.rect.x},${el.rect.y})`)
    }

    if (el.text) parts.push(`"${el.text.slice(0, 60)}"`)

    console.log(`  ${el.selector}`)
    console.log(`    ${parts.join(" ")}`)
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

// ─── Main ───

function printUsage() {
  console.error(`
Design Reference — Capture and compare DOM snapshots

Commands:
  capture     Capture current page state as a design reference
  compare     Compare live page against a saved reference
  list        List all saved references
  show        Show details of a saved reference

Capture options:
  --name <name>         Reference name (required)
  --selector <sel>      CSS selector for root element (default: "body")
  --url <url>           Navigate to URL before capturing
  --depth <n>           Max DOM depth to traverse (default: 5)
  --output <path>       Custom output path (default: cli/references/<name>.json)

Compare options:
  --reference <path>    Path to reference JSON file
  --name <name>         Reference name (looks in cli/references/)
  --url <url>           Navigate to URL before comparing
  --selector <sel>      Override root selector
  --depth <n>           Max DOM depth (default: 5)
  --report <path>       Save detailed comparison report as JSON

Show options:
  --name <name>         Reference name to show

Environment:
  CDP_PORT=9222         Chrome DevTools port

Examples:
  node cli/design-reference.mjs capture --name hero --selector "#hero"
  node cli/design-reference.mjs capture --name full-page --url http://localhost:3000
  node cli/design-reference.mjs compare --name hero
  node cli/design-reference.mjs compare --reference ./my-ref.json --report diff.json
  node cli/design-reference.mjs list
  node cli/design-reference.mjs show --name hero
`)
}

async function main() {
  let args
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        name: { type: "string" },
        selector: { type: "string" },
        url: { type: "string" },
        depth: { type: "string" },
        output: { type: "string", short: "o" },
        reference: { type: "string" },
        report: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    })
  } catch (e) {
    error(e.message)
    printUsage()
    process.exit(1)
  }

  const command = args.positionals[0]

  if (args.values.help || !command) {
    printUsage()
    process.exit(args.values.help ? 0 : 1)
  }

  try {
    switch (command) {
      case "capture":
        await cmdCapture(args.values)
        break
      case "compare":
        await cmdCompare(args.values)
        break
      case "list":
        cmdList()
        break
      case "show":
        cmdShow(args.values)
        break
      default:
        error(`Unknown command: ${command}`)
        printUsage()
        process.exit(1)
    }
  } catch (e) {
    error(e.message)
    process.exit(1)
  }
}

main()

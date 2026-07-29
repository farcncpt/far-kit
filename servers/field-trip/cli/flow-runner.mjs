#!/usr/bin/env node
/**
 * flow-runner.mjs — Executes a series of browser actions and validates each step.
 *
 * Takes a flow definition (JSON file or inline JSON) and runs each step sequentially
 * via CDP: navigate, click, type, wait, scan, assert. Reports pass/fail per step.
 *
 * Supported actions:
 *   navigate  — go to a URL
 *   click     — click an element by selector or text
 *   type      — type into an input (uses native setter for React compatibility)
 *   wait      — pause for N milliseconds
 *   scan      — scan page elements (logs results)
 *   eval      — evaluate arbitrary JS expression
 *   assert    — run an assertion check
 *   viewport  — resize the viewport (for responsive testing)
 *
 * Assertion checks:
 *   elementExists  — selector matches at least one visible element
 *   elementText    — element's textContent matches expected value
 *   elementVisible — element is visible (not display:none, non-zero size)
 *   elementCount   — number of elements matching selector equals expected
 *   urlMatches     — current URL contains the pattern string
 *
 * Usage:
 *   CDP_PORT=9222 node cli/flow-runner.mjs --flow flows/checkout.json
 *   CDP_PORT=9222 node cli/flow-runner.mjs --inline '[{"action":"navigate","url":"http://localhost:3000"},{"action":"assert","check":"elementExists","selector":"h1"}]'
 *
 * Environment:
 *   CDP_PORT — Chrome DevTools Protocol port (default: 9222)
 */

import http from "http"
import { readFileSync } from "fs"

const args = process.argv.slice(2)
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222")

function getFlagValue(name, fallback) {
  const idx = args.indexOf(name)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return fallback
}

const flowFile = getFlagValue("--flow", null)
const inlineFlow = getFlagValue("--inline", null)

if (!flowFile && !inlineFlow) {
  console.error(`Usage:
  node cli/flow-runner.mjs --flow <path-to-flow.json>
  node cli/flow-runner.mjs --inline '<json-array-of-steps>'`)
  process.exit(1)
}

// ─── Load flow definition ───

let flow
if (flowFile) {
  try {
    const raw = readFileSync(flowFile, "utf-8")
    flow = JSON.parse(raw)
  } catch (err) {
    console.error(`Failed to load flow file: ${err.message}`)
    process.exit(1)
  }
} else {
  try {
    const parsed = JSON.parse(inlineFlow)
    // Support both array of steps and object with { name, steps }
    flow = Array.isArray(parsed) ? { name: "Inline Flow", steps: parsed } : parsed
  } catch (err) {
    console.error(`Failed to parse inline flow: ${err.message}`)
    process.exit(1)
  }
}

// Normalize: if flow is { name, steps } use it; if array, wrap it
if (Array.isArray(flow)) {
  flow = { name: "Flow", steps: flow }
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

  return { ws, send, evaluate, onEvent }
}

// ─── Step executors ───

async function executeStep(step, send, evaluate, onEvent, stepIndex) {
  const label = `Step ${stepIndex + 1}: ${step.action}`

  switch (step.action) {
    case "navigate": {
      await send("Page.enable")
      await send("Page.navigate", { url: step.url })
      // Wait for page load
      await new Promise((resolve) => {
        const handler = () => resolve()
        onEvent("Page.loadEventFired", handler)
        setTimeout(resolve, 15000)
      })
      // Additional settle time
      await new Promise((r) => setTimeout(r, step.waitAfter || 1000))
      const currentUrl = await evaluate("location.href")
      return { passed: true, message: `Navigated to ${currentUrl}` }
    }

    case "click": {
      const selector = step.selector
      const result = await evaluate(`
        (() => {
          let el = null;
          // Try selector first
          try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}
          // Try by ID
          if (!el) el = document.getElementById(${JSON.stringify(selector)});
          // Try by aria-label
          if (!el) el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(selector)}) + ']');
          // Try by text content
          if (!el) {
            const lower = ${JSON.stringify(selector)}.toLowerCase();
            const candidates = [...document.querySelectorAll('button, a, [role="button"], span, div, label')];
            for (const c of candidates) {
              const text = (c.textContent || '').trim().toLowerCase();
              if (text === lower || (text.length < 200 && text.includes(lower))) {
                el = c;
                break;
              }
            }
          }
          if (!el) return { found: false };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.click();
          return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
        })()
      `)
      if (!result.found) {
        return { passed: false, message: `Element not found: ${selector}` }
      }
      // Wait after click for any transitions
      await new Promise((r) => setTimeout(r, step.waitAfter || 500))
      return { passed: true, message: `Clicked <${result.tag}> "${result.text}"` }
    }

    case "type": {
      const result = await evaluate(`
        (() => {
          let el = null;
          try { el = document.querySelector(${JSON.stringify(step.selector)}); } catch(e) {}
          if (!el) el = document.getElementById(${JSON.stringify(step.selector)});
          if (!el) {
            // Find by label text
            const lower = ${JSON.stringify(step.selector)}.toLowerCase();
            const labels = document.querySelectorAll('label');
            for (const label of labels) {
              if (label.textContent.trim().toLowerCase().includes(lower)) {
                const forId = label.getAttribute('for');
                if (forId) el = document.getElementById(forId);
                if (!el) el = label.querySelector('input, textarea, select');
                if (el) break;
              }
            }
          }
          if (!el) return { found: false };
          el.focus();
          el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
          // Use native setter for React compatibility
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;
          if (nativeSetter) {
            nativeSetter.call(el, ${JSON.stringify(step.value)});
          } else {
            el.value = ${JSON.stringify(step.value)};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, tag: el.tagName.toLowerCase(), value: el.value };
        })()
      `)
      if (!result.found) {
        return { passed: false, message: `Input not found: ${step.selector}` }
      }
      return { passed: true, message: `Typed "${step.value}" into <${result.tag}>` }
    }

    case "wait": {
      const ms = step.ms || 1000
      await new Promise((r) => setTimeout(r, ms))
      return { passed: true, message: `Waited ${ms}ms` }
    }

    case "scan": {
      const elements = await evaluate(`
        (() => {
          const selectors = 'a, button, input, select, textarea, [role="button"], h1, h2, h3, label, img';
          const els = document.querySelectorAll(selectors);
          let total = 0, interactive = 0;
          const items = [];
          for (const el of els) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            total++;
            const tag = el.tagName;
            if (['BUTTON','INPUT','SELECT','TEXTAREA','A'].includes(tag) || el.getAttribute('role') === 'button') interactive++;
            const text = (el.textContent || '').trim().slice(0, 80);
            if (text || ['INPUT','SELECT','TEXTAREA'].includes(tag)) {
              items.push(tag.toLowerCase() + (el.id ? '#' + el.id : '') + (text ? ' "' + text + '"' : ''));
            }
          }
          return { total, interactive, items: items.slice(0, 30) };
        })()
      `)
      return { passed: true, message: `Scanned ${elements.total} elements (${elements.interactive} interactive)`, data: elements }
    }

    case "eval": {
      const value = await evaluate(step.expression)
      return { passed: true, message: `Evaluated: ${JSON.stringify(value)}`, data: value }
    }

    case "viewport": {
      await send("Emulation.setDeviceMetricsOverride", {
        width: step.width || 1280,
        height: step.height || 900,
        deviceScaleFactor: step.deviceScaleFactor || 1,
        mobile: step.mobile || false,
      })
      await new Promise((r) => setTimeout(r, 600))
      return { passed: true, message: `Viewport set to ${step.width || 1280}x${step.height || 900}${step.mobile ? " (mobile)" : ""}` }
    }

    case "assert": {
      return executeAssert(step, evaluate)
    }

    default:
      return { passed: false, message: `Unknown action: ${step.action}` }
  }
}

async function executeAssert(step, evaluate) {
  switch (step.check) {
    case "elementExists": {
      const exists = await evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          return true;
        })()
      `)
      if (exists) {
        return { passed: true, message: `Element exists: ${step.selector}` }
      }
      return { passed: false, message: `Element NOT found: ${step.selector}` }
    }

    case "elementText": {
      const text = await evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return null;
          return (el.textContent || '').trim();
        })()
      `)
      if (text === null) {
        return { passed: false, message: `Element NOT found: ${step.selector}` }
      }
      const expected = step.expected
      const matches = step.exact === false
        ? text.toLowerCase().includes(expected.toLowerCase())
        : text === expected
      if (matches) {
        return { passed: true, message: `Text matches: "${expected}"` }
      }
      return { passed: false, message: `Text mismatch: expected "${expected}", got "${text.slice(0, 100)}"` }
    }

    case "elementVisible": {
      const visible = await evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(step.selector)});
          if (!el) return { found: false };
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            found: true,
            visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
            display: style.display,
            visibility: style.visibility,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })()
      `)
      if (!visible.found) {
        return { passed: false, message: `Element NOT found: ${step.selector}` }
      }
      if (visible.visible) {
        return { passed: true, message: `Element is visible: ${step.selector} (${visible.width}x${visible.height})` }
      }
      return { passed: false, message: `Element NOT visible: ${step.selector} (display:${visible.display}, visibility:${visible.visibility}, ${visible.width}x${visible.height})` }
    }

    case "elementCount": {
      const count = await evaluate(`
        (() => {
          const els = document.querySelectorAll(${JSON.stringify(step.selector)});
          let visible = 0;
          for (const el of els) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            visible++;
          }
          return visible;
        })()
      `)
      const expected = step.expected
      const op = step.operator || "eq"
      let pass = false
      switch (op) {
        case "eq": pass = count === expected; break
        case "gte": pass = count >= expected; break
        case "gt": pass = count > expected; break
        case "lte": pass = count <= expected; break
        case "lt": pass = count < expected; break
        default: pass = count === expected
      }
      if (pass) {
        return { passed: true, message: `Element count ${op} ${expected}: got ${count} for ${step.selector}` }
      }
      return { passed: false, message: `Element count failed: expected ${op} ${expected}, got ${count} for ${step.selector}` }
    }

    case "urlMatches": {
      const url = await evaluate("location.href")
      const pattern = step.pattern
      if (url.includes(pattern)) {
        return { passed: true, message: `URL matches: "${pattern}" in "${url}"` }
      }
      return { passed: false, message: `URL mismatch: "${pattern}" not found in "${url}"` }
    }

    default:
      return { passed: false, message: `Unknown assertion check: ${step.check}` }
  }
}

// ─── Main ───

async function main() {
  const cdp = await connectCDP()
  const { ws, send, evaluate, onEvent } = cdp

  console.log(`\n=== Flow Runner: ${flow.name || "Unnamed Flow"} ===`)
  console.log(`Steps: ${flow.steps.length}`)
  console.log(`CDP port: ${CDP_PORT}\n`)

  let passed = 0
  let failed = 0
  const results = []

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i]
    const stepLabel = step.description || `${step.action}${step.selector ? " " + step.selector : ""}${step.url ? " " + step.url : ""}${step.check ? " " + step.check : ""}`

    try {
      const result = await executeStep(step, send, evaluate, onEvent, i)
      results.push({ step: i + 1, ...step, ...result })

      if (result.passed) {
        console.log(`  \u2713 Step ${i + 1}: ${stepLabel}`)
        if (result.message) console.log(`    ${result.message}`)
        passed++
      } else {
        console.log(`  \u2717 Step ${i + 1}: ${stepLabel}`)
        console.log(`    FAILED: ${result.message}`)
        failed++
        // If step has continueOnFail, keep going; otherwise stop
        if (!step.continueOnFail && !flow.continueOnFail) {
          console.log(`\n  Stopping flow due to failure at step ${i + 1}`)
          break
        }
      }
    } catch (err) {
      console.log(`  \u2717 Step ${i + 1}: ${stepLabel}`)
      console.log(`    ERROR: ${err.message}`)
      failed++
      results.push({ step: i + 1, ...step, passed: false, message: err.message })
      if (!step.continueOnFail && !flow.continueOnFail) {
        console.log(`\n  Stopping flow due to error at step ${i + 1}`)
        break
      }
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${flow.steps.length} steps ===\n`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(2)
})

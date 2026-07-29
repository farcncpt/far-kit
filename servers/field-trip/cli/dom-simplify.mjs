#!/usr/bin/env node
/**
 * DOM Simplification Engine — 4 levels of DOM comprehension.
 *
 * Connects via CDP to a running Chrome instance and produces progressively
 * simplified representations of the page DOM.
 *
 * Levels:
 *   0  Raw      — every element with full attributes (same as deep-scan)
 *   1  Regions  — elements clustered by Y-position, typed, merged, stripped
 *   2  Semantic — JSON map with page purpose, form state, nav, actions
 *   3  Intent   — pure action sequence with suggested interaction flow
 *
 * Usage:
 *   CDP_PORT=9225 node cli/dom-simplify.mjs --level 0
 *   CDP_PORT=9225 node cli/dom-simplify.mjs --level 1
 *   CDP_PORT=9225 node cli/dom-simplify.mjs --level 2
 *   CDP_PORT=9225 node cli/dom-simplify.mjs --level 3
 *   CDP_PORT=9225 node cli/dom-simplify.mjs --detect
 *   CDP_PORT=9225 node cli/dom-simplify.mjs --level 2 --output semantic.json
 */

import http from "http"
import { writeFileSync } from "fs"

// ─── Argument parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2)

function flag(name) {
  return args.includes(name)
}

function param(name, fallback) {
  const idx = args.indexOf(name)
  if (idx === -1 || !args[idx + 1]) return fallback
  return args[idx + 1]
}

const detectOnly = flag("--detect")
const level = detectOnly ? -1 : parseInt(param("--level", "1"))
const outputFile = param("--output", null)
const CDP_PORT = parseInt(process.env.CDP_PORT || param("--port", "9222"))

if (!detectOnly && (level < 0 || level > 3)) {
  console.error("Error: --level must be 0, 1, 2, or 3")
  process.exit(1)
}

if (flag("--help") || flag("-h")) {
  console.log(`
DOM Simplification Engine

  --level 0          Raw scan (all elements, all attributes)
  --level 1          Structured regions (clustered, typed, merged)
  --level 2          Semantic map (JSON: purpose, forms, nav, actions)
  --level 3          Intent layer (action sequence for agent execution)
  --detect           Framework detection only
  --output <file>    Write JSON output to file
  --port <number>    CDP port (default: 9222, or CDP_PORT env)
  `)
  process.exit(0)
}

// ─── CDP connection (same pattern as tt.mjs) ────────────────────────────────

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => resolve(JSON.parse(data)))
      })
      .on("error", (err) => {
        reject(new Error(`Cannot connect to Chrome on port ${CDP_PORT}: ${err.message}`))
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
    console.error("No page tab found on port " + CDP_PORT)
    process.exit(1)
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
        20000
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

// ─── In-browser scripts ─────────────────────────────────────────────────────

/** Returns the raw scan JS expression (runs inside the browser). */
const SCAN_RAW_EXPR = `
(() => {
  const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], h1, h2, h3, h4, h5, h6, p, span, div, label, li, td, th, [data-testid], [aria-label], summary, details, nav, header, footer, main, aside, form, fieldset, legend, img[alt]';
  const els = document.querySelectorAll(selectors);
  const items = [];
  const seen = new Set();

  for (const el of els) {
    // Skip extension overlay
    if (el.closest('#field-trip-root')) continue;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (parseFloat(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const tag = el.tagName.toLowerCase();
    const isInteractive = ['a','button','input','select','textarea'].includes(tag) ||
      ['button','link','tab','menuitem','checkbox','radio','switch','option'].includes(el.getAttribute('role') || '');
    const isHeading = /^h[1-6]$/.test(tag);
    const isLandmark = ['nav','header','footer','main','aside','form'].includes(tag);

    const ownText = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .join(' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const fullText = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300);

    // For non-interactive, non-heading, non-landmark elements, skip containers and dupes
    if (!isInteractive && !isHeading && !isLandmark) {
      if (fullText.length > 300) continue;
      if (!fullText && tag !== 'img') continue;
      if (seen.has(fullText)) continue;
    }
    if (fullText) seen.add(fullText);

    const item = {
      tag,
      text: fullText.slice(0, 200),
      ownText: ownText ? ownText.slice(0, 200) : undefined,
      id: el.id || undefined,
      name: el.name || undefined,
      type: el.type || undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      dataTestid: el.getAttribute('data-testid') || undefined,
      href: tag === 'a' ? el.getAttribute('href') : undefined,
      alt: tag === 'img' ? el.getAttribute('alt') : undefined,
      value: (el.value !== undefined && el.value !== '') ? String(el.value).slice(0, 200) : undefined,
      checked: (el.type === 'checkbox' || el.type === 'radio') ? el.checked : undefined,
      disabled: el.disabled === true ? true : undefined,
      required: el.required === true ? true : undefined,
      selected: el.getAttribute('aria-selected') === 'true' ? true : (el.getAttribute('aria-current') === 'true' ? true : undefined),
      expanded: el.getAttribute('aria-expanded') != null ? el.getAttribute('aria-expanded') === 'true' : undefined,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      interactive: isInteractive,
      heading: isHeading,
      landmark: isLandmark,
      cursor: style.cursor === 'pointer' ? true : undefined,
      forAttr: tag === 'label' ? el.getAttribute('for') : undefined,
      tagName: el.tagName,
      childCount: el.children.length,
      className: (el.className || '').toString().slice(0, 100) || undefined,
    };

    // Build a stable selector
    if (el.id) {
      item.selector = '#' + CSS.escape(el.id);
    } else if (el.getAttribute('data-testid')) {
      item.selector = '[data-testid="' + CSS.escape(el.getAttribute('data-testid')) + '"]';
    } else if (el.getAttribute('aria-label')) {
      item.selector = tag + '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]';
    } else if (el.getAttribute('name')) {
      item.selector = tag + '[name="' + CSS.escape(el.getAttribute('name')) + '"]';
    } else if (tag === 'input' && el.type) {
      // Build a path-based selector
      const parent = el.parentElement;
      if (parent) {
        const inputs = Array.from(parent.querySelectorAll('input[type="' + el.type + '"]'));
        const idx = inputs.indexOf(el);
        if (inputs.length === 1) {
          item.selector = (parent.id ? '#' + CSS.escape(parent.id) + ' ' : '') + 'input[type="' + el.type + '"]';
        } else {
          item.selector = (parent.id ? '#' + CSS.escape(parent.id) + ' ' : '') + 'input[type="' + el.type + '"]:nth-of-type(' + (idx + 1) + ')';
        }
      }
    }

    items.push(item);
  }

  items.sort((a, b) => a.y - b.y);
  return items;
})()
`

/** Framework detection script. Runs inside the browser. */
const DETECT_FRAMEWORK_EXPR = `
(() => {
  const results = [];

  // React
  try {
    const bodyKeys = Object.keys(document.body || {});
    const hasReactFiber = bodyKeys.some(k => k.startsWith('__reactFiber')) ||
      !!document.querySelector('[data-reactroot]');
    const allEls = document.querySelectorAll('*');
    let reactFound = hasReactFiber;
    if (!reactFound) {
      for (const el of allEls) {
        if (Object.keys(el).some(k => k.startsWith('__reactFiber'))) {
          reactFound = true;
          break;
        }
      }
    }
    if (reactFound) {
      let version = null;
      try { version = window.React?.version || null; } catch {}
      // Try __REACT_DEVTOOLS_GLOBAL_HOOK__
      if (!version) {
        try {
          const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
          if (hook && hook.renderers) {
            for (const [, renderer] of hook.renderers) {
              if (renderer.version) { version = renderer.version; break; }
            }
          }
        } catch {}
      }
      results.push({
        name: 'react',
        version: version || 'detected',
        stateAccess: '__reactFiber / __reactProps on elements',
      });
    }
  } catch {}

  // Vue
  try {
    if (window.__VUE__) {
      results.push({ name: 'vue', version: '3.x', stateAccess: '__vue_app__ on mount element' });
    } else if (window.Vue) {
      results.push({ name: 'vue', version: window.Vue.version || '2.x', stateAccess: '__vue__ on elements' });
    } else {
      const vueEl = document.querySelector('[data-v-app]') || document.querySelector('[data-v-]');
      if (vueEl) {
        results.push({ name: 'vue', version: 'detected', stateAccess: '__vue__ / __vue_app__' });
      }
    }
  } catch {}

  // Angular
  try {
    const ngVersion = document.querySelector('[ng-version]');
    if (ngVersion) {
      results.push({
        name: 'angular',
        version: ngVersion.getAttribute('ng-version') || 'detected',
        stateAccess: 'ng.getComponent() / __ngContext__',
      });
    } else if (window.ng || document.querySelector('[_nghost]') ||
               document.querySelector('[_ngcontent]')) {
      results.push({ name: 'angular', version: 'detected', stateAccess: 'ng.getComponent()' });
    }
  } catch {}

  // Svelte
  try {
    const svelteEl = document.querySelector('[class*="svelte-"]');
    if (svelteEl) {
      results.push({ name: 'svelte', version: 'detected', stateAccess: '__svelte_meta on elements' });
    }
  } catch {}

  // Lit
  try {
    if (window.litElementVersions) {
      results.push({
        name: 'lit',
        version: window.litElementVersions?.[0] || 'detected',
        stateAccess: 'element properties',
      });
    }
  } catch {}

  // Web Components (Shadow DOM)
  try {
    const allEls = document.querySelectorAll('*');
    let hasShadow = false;
    for (const el of allEls) {
      if (el.shadowRoot) { hasShadow = true; break; }
    }
    if (hasShadow) {
      results.push({ name: 'web-components', version: 'shadow-dom', stateAccess: 'shadowRoot traversal' });
    }
  } catch {}

  // Next.js
  try {
    if (window.__NEXT_DATA__ || document.querySelector('#__next')) {
      results.push({
        name: 'next.js',
        version: window.__NEXT_DATA__?.buildId ? 'app-router' : 'detected',
        stateAccess: '__NEXT_DATA__ / React fiber tree',
      });
    }
  } catch {}

  // Nuxt
  try {
    if (window.__NUXT__ || document.querySelector('#__nuxt')) {
      results.push({ name: 'nuxt', version: 'detected', stateAccess: '__NUXT__ store' });
    }
  } catch {}

  if (results.length === 0) {
    results.push({ name: 'vanilla', version: 'n/a', stateAccess: 'standard DOM' });
  }

  return results;
})()
`

/** Page metadata script. */
const PAGE_META_EXPR = `
(() => {
  const title = document.title || '';
  const url = location.href;
  const metaDesc = document.querySelector('meta[name="description"]');
  const h1 = document.querySelector('h1');
  return {
    title,
    url,
    description: metaDesc ? metaDesc.getAttribute('content') : null,
    h1Text: h1 ? h1.textContent.trim().slice(0, 200) : null,
  };
})()
`

// ─── Level 0: Raw scan ──────────────────────────────────────────────────────

function formatLevel0(items) {
  const lines = []
  let lastY = -100
  for (const el of items) {
    if (el.y - lastY > 30) lines.push("")
    lastY = el.y

    const marker = el.interactive ? ">>>" : "   "
    const parts = [`${marker} <${el.tag}>`]
    if (el.id) parts.push(`id="${el.id}"`)
    if (el.name) parts.push(`name="${el.name}"`)
    if (el.type) parts.push(`type="${el.type}"`)
    if (el.dataTestid) parts.push(`testid="${el.dataTestid}"`)
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
    if (el.role) parts.push(`role="${el.role}"`)
    if (el.cursor) parts.push(`[clickable]`)
    if (el.disabled) parts.push(`[disabled]`)
    if (el.required) parts.push(`[required]`)
    if (el.checked !== undefined) parts.push(el.checked ? `[checked]` : `[unchecked]`)
    if (el.selected) parts.push(`[selected]`)
    if (el.value) parts.push(`val="${el.value}"`)
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`)
    if (el.text) parts.push(`"${el.text.slice(0, 150)}"`)
    if (el.selector) parts.push(`-> ${el.selector}`)
    lines.push(parts.join(" "))
  }
  return lines.join("\n")
}

// ─── Level 1: Structured Regions ─────────────────────────────────────────────

const REGION_GAP = 40

function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

function isHashId(s) {
  return /^[0-9a-f]{16,}$/i.test(s) || /^[A-Za-z0-9_-]{20,}$/.test(s)
}

function shouldStripId(id) {
  if (!id) return false
  return isUUID(id) || isHashId(id)
}

function inferRegionType(elements) {
  const tags = elements.map((e) => e.tag)
  const roles = elements.map((e) => e.role).filter(Boolean)
  const landmarks = elements.filter((e) => e.landmark).map((e) => e.tag)

  if (landmarks.includes("nav") || roles.includes("tab") || roles.includes("menuitem"))
    return "navigation"
  if (landmarks.includes("header")) return "header"
  if (landmarks.includes("footer")) return "footer"
  if (landmarks.includes("aside")) return "sidebar"

  const formInputs = elements.filter((e) =>
    ["input", "select", "textarea"].includes(e.tag)
  )
  if (formInputs.length >= 2) return "form"
  if (formInputs.length === 1 && elements.length <= 4) return "form"

  const buttons = elements.filter(
    (e) =>
      e.tag === "button" ||
      e.role === "button" ||
      (e.tag === "a" && e.cursor)
  )
  if (buttons.length >= 2 && buttons.length === elements.filter((e) => e.interactive).length)
    return "actions"

  const headings = elements.filter((e) => e.heading)
  if (headings.length > 0 && formInputs.length === 0) return "content"

  const links = elements.filter((e) => e.tag === "a")
  if (links.length >= 3) return "navigation"

  return "content"
}

function findLabelForInput(input, allElements) {
  // 1. Check for attribute
  if (input.forAttr || input.ariaLabel || input.placeholder) {
    return input.ariaLabel || input.placeholder || null
  }

  // 2. Look for a label element pointing to this input via for= matching id
  if (input.id) {
    const label = allElements.find(
      (e) => e.tag === "label" && e.forAttr === input.id
    )
    if (label) return label.text
  }

  // 3. Look for nearest preceding label by position
  const candidates = allElements.filter(
    (e) =>
      e.tag === "label" &&
      Math.abs(e.y - input.y) < 40 &&
      e.x <= input.x + 20
  )
  if (candidates.length > 0) {
    // Closest vertically
    candidates.sort(
      (a, b) => Math.abs(a.y - input.y) - Math.abs(b.y - input.y)
    )
    return candidates[0].text
  }

  // 4. Check preceding text-bearing element within same region band
  const preceding = allElements.filter(
    (e) =>
      !e.interactive &&
      e.text &&
      e.y <= input.y + 5 &&
      e.y >= input.y - 30 &&
      e.x < input.x
  )
  if (preceding.length > 0) {
    return preceding[preceding.length - 1].text
  }

  return input.name || input.id || null
}

function classifyButton(el) {
  const text = (el.text || el.ariaLabel || "").toLowerCase()
  const destructive = /delete|remove|destroy|discard|clear all/
  const primary = /submit|save|continue|next|confirm|done|create|add|apply|update|sign in|log in|send|pay|checkout|finish|complete/
  const secondary = /cancel|back|close|dismiss|skip|reset|go back|previous|no thanks/

  if (destructive.test(text)) return "destructive"
  if (primary.test(text)) return "primary"
  if (secondary.test(text)) return "secondary"

  // Check type=submit
  if (el.type === "submit") return "primary"

  return "default"
}

function mergeRedundantElements(elements) {
  // Merge parent/child elements that share the same text
  const merged = []
  const skip = new Set()

  for (let i = 0; i < elements.length; i++) {
    if (skip.has(i)) continue
    const el = elements[i]

    // Check if any later element at the same position has the same text
    for (let j = i + 1; j < elements.length; j++) {
      if (skip.has(j)) continue
      const other = elements[j]
      if (
        Math.abs(el.y - other.y) < 5 &&
        Math.abs(el.x - other.x) < 5 &&
        el.text === other.text &&
        el.text
      ) {
        // Keep the more specific (interactive) one, or the one with more info
        if (other.interactive && !el.interactive) {
          skip.add(i)
        } else {
          skip.add(j)
        }
      }
    }

    if (!skip.has(i)) {
      merged.push(el)
    }
  }

  return merged
}

function clusterIntoRegions(items) {
  if (items.length === 0) return []

  const merged = mergeRedundantElements(items)
  const regions = []
  let currentRegion = { elements: [merged[0]], yMin: merged[0].y, yMax: merged[0].y }

  for (let i = 1; i < merged.length; i++) {
    const el = merged[i]
    if (el.y - currentRegion.yMax > REGION_GAP) {
      regions.push(currentRegion)
      currentRegion = { elements: [el], yMin: el.y, yMax: el.y }
    } else {
      currentRegion.elements.push(el)
      currentRegion.yMax = Math.max(currentRegion.yMax, el.y)
    }
  }
  regions.push(currentRegion)

  return regions
}

function formatInputDescription(el) {
  const parts = []
  const inputType = el.type || "text"
  parts.push(`[${inputType} input`)

  if (el.value) {
    parts.push(`, value="${el.value}"`)
  } else {
    parts.push(`, empty`)
  }
  if (el.required) parts.push(`, required`)
  if (el.disabled) parts.push(`, disabled`)
  if (el.placeholder) parts.push(`, placeholder="${el.placeholder}"`)
  parts.push(`]`)
  return parts.join("")
}

function formatLevel1(items, pageMeta) {
  const regions = clusterIntoRegions(items)
  const lines = []

  if (pageMeta) {
    lines.push(`PAGE: ${pageMeta.title || pageMeta.h1Text || pageMeta.url}`)
    lines.push(`URL: ${pageMeta.url}`)
    lines.push("")
  }

  for (const region of regions) {
    const type = inferRegionType(region.elements)
    const yRange = `y: ${region.yMin}-${region.yMax}`

    // Try to find a heading for the region name
    const heading = region.elements.find((e) => e.heading)
    const regionName = heading
      ? heading.text.slice(0, 60)
      : type.charAt(0).toUpperCase() + type.slice(1)

    lines.push(`REGION "${regionName}" (${yRange}) [${type}]:`)

    // Group buttons into action bars
    const buttons = region.elements.filter(
      (e) => e.tag === "button" || e.role === "button"
    )
    const nonButtons = region.elements.filter(
      (e) => e.tag !== "button" && e.role !== "button"
    )

    for (const el of nonButtons) {
      // Skip purely structural landmarks that contain nothing themselves
      if (el.landmark && !el.ownText && el.childCount > 0) continue

      const indent = "  "

      if (["input", "textarea"].includes(el.tag)) {
        const label = findLabelForInput(el, items)
        const desc = formatInputDescription(el)
        const cleanLabel = label
          ? label.replace(/[:\*]$/, "").trim()
          : el.name || "unnamed"
        lines.push(`${indent}- ${cleanLabel} ${desc}`)
      } else if (el.tag === "select") {
        const label = findLabelForInput(el, items)
        const cleanLabel = label
          ? label.replace(/[:\*]$/, "").trim()
          : el.name || "unnamed"
        const val = el.value ? `, selected="${el.value}"` : ""
        lines.push(`${indent}- ${cleanLabel} [select${val}]`)
      } else if (el.tag === "a") {
        const display = el.text || el.ariaLabel || el.href || "link"
        const sel = el.selected ? " (active)" : ""
        lines.push(`${indent}  Link: "${display.slice(0, 80)}"${sel}`)
      } else if (el.heading) {
        // Already used as region name, but show sub-headings
        if (el !== heading) {
          lines.push(`${indent}  ${el.tag.toUpperCase()}: ${el.text.slice(0, 100)}`)
        }
      } else if (el.tag === "label") {
        // Labels are shown with their inputs, skip standalone unless no input follows
        const hasInput = region.elements.some(
          (other) =>
            ["input", "select", "textarea"].includes(other.tag) &&
            (other.name === el.forAttr ||
              (Math.abs(other.y - el.y) < 40 && other.x > el.x - 20))
        )
        if (!hasInput) {
          lines.push(`${indent}  Label: "${el.text.slice(0, 80)}"`)
        }
      } else if (el.tag === "img") {
        lines.push(`${indent}  Image: "${el.alt || "no alt"}"`)
      } else if (el.role === "tab") {
        const sel = el.selected ? " (active)" : ""
        lines.push(`${indent}  Tab: "${el.text.slice(0, 60)}"${sel}`)
      } else if (el.role === "checkbox" || el.type === "checkbox") {
        const label = el.ariaLabel || el.text || el.name || "checkbox"
        const state = el.checked ? "checked" : "unchecked"
        lines.push(`${indent}  [${state}] ${label}`)
      } else if (el.role === "radio" || el.type === "radio") {
        const label = el.ariaLabel || el.text || el.name || "radio"
        const state = el.checked ? "selected" : "unselected"
        lines.push(`${indent}  (${state}) ${label}`)
      } else if (el.text && !el.landmark) {
        // Strip IDs from display
        const cleanId = el.id && !shouldStripId(el.id) ? ` #${el.id}` : ""
        lines.push(`${indent}  "${el.text.slice(0, 120)}"${cleanId}`)
      }
    }

    // Render action bar
    if (buttons.length > 0) {
      const btnLabels = buttons.map((b) => {
        const label = b.text || b.ariaLabel || "button"
        const cls = classifyButton(b)
        if (cls === "primary") return `${label} (primary)`
        if (cls === "destructive") return `${label} (destructive)`
        return label
      })
      lines.push(`  Actions: [${btnLabels.join("] [")}]`)
    }

    lines.push("")
  }

  return lines.join("\n")
}

// ─── Level 2: Semantic Map ───────────────────────────────────────────────────

function buildSemanticMap(items, pageMeta, frameworkInfo) {
  const regions = clusterIntoRegions(items)

  // Infer page purpose
  const formInputs = items.filter((e) =>
    ["input", "select", "textarea"].includes(e.tag)
  )
  const allButtons = items.filter(
    (e) => e.tag === "button" || e.role === "button"
  )
  const headings = items.filter((e) => e.heading)
  const links = items.filter((e) => e.tag === "a")

  let pageType = "unknown"
  if (formInputs.length >= 3) pageType = "form"
  else if (items.filter((e) => e.role === "tab").length >= 2) pageType = "tabbed"
  else if (links.length > 10 && formInputs.length < 2) pageType = "listing"
  else if (headings.length > 0 && formInputs.length < 2 && links.length < 5)
    pageType = "detail"
  else if (allButtons.length > 3 && formInputs.length < 2)
    pageType = "dashboard"

  // Build sections from regions
  const sections = []
  for (const region of regions) {
    const type = inferRegionType(region.elements)
    const heading = region.elements.find((e) => e.heading)

    if (type === "form") {
      const fields = []
      const inputs = region.elements.filter((e) =>
        ["input", "select", "textarea"].includes(e.tag)
      )
      let filledCount = 0

      for (const inp of inputs) {
        const label = findLabelForInput(inp, items)
        const field = {
          label: label
            ? label.replace(/[:\*]$/, "").trim()
            : inp.name || "unnamed",
          type: inp.tag === "select" ? "select" : inp.type || "text",
          empty: !inp.value,
          value: inp.value || null,
        }
        if (inp.required) field.required = true
        if (inp.disabled) field.disabled = true
        if (inp.placeholder) field.placeholder = inp.placeholder
        if (inp.value) filledCount++
        fields.push(field)
      }

      sections.push({
        name: heading ? heading.text.slice(0, 60) : "Form",
        type: "form",
        completeness: `${filledCount}/${inputs.length} fields filled`,
        fields,
      })
    } else if (type === "navigation") {
      const navItems = region.elements
        .filter((e) => e.tag === "a" || e.role === "tab" || e.role === "menuitem")
        .map((e) => ({
          label: (e.text || e.ariaLabel || "").slice(0, 60),
          active: !!e.selected,
          href: e.href || undefined,
        }))

      // Detect nav style
      const tabs = region.elements.filter((e) => e.role === "tab")
      let navStyle = "links"
      if (tabs.length >= 2) navStyle = "tabs"
      else if (region.elements.some((e) => e.role === "menuitem"))
        navStyle = "menu"

      // Detect breadcrumbs (multiple links on same Y with separators)
      const navLinks = region.elements.filter((e) => e.tag === "a")
      const sameY =
        navLinks.length >= 2 &&
        navLinks.every((l) => Math.abs(l.y - navLinks[0].y) < 5)
      if (sameY && navLinks.length <= 6) navStyle = "breadcrumb"

      sections.push({
        name: heading ? heading.text.slice(0, 60) : "Navigation",
        type: "navigation",
        style: navStyle,
        items: navItems,
      })
    } else if (type === "actions") {
      // Handled at top level
    } else {
      // Content section
      const texts = region.elements
        .filter((e) => e.text && !e.landmark)
        .map((e) => e.text.slice(0, 120))
        .slice(0, 10)

      if (texts.length > 0) {
        sections.push({
          name: heading ? heading.text.slice(0, 60) : "Content",
          type: "content",
          items: texts,
        })
      }
    }
  }

  // Classify actions
  const actions = {}
  for (const btn of allButtons) {
    const cls = classifyButton(btn)
    const entry = {
      label: (btn.text || btn.ariaLabel || "button").slice(0, 60),
      enabled: !btn.disabled,
      selector: btn.selector || undefined,
    }
    if (cls === "primary" && !actions.primary) actions.primary = entry
    else if (cls === "destructive" && !actions.destructive)
      actions.destructive = entry
    else if (cls === "secondary" && !actions.secondary) actions.secondary = entry
    else {
      if (!actions.other) actions.other = []
      actions.other.push(entry)
    }
  }

  // Detect current state
  const state = {}
  const activeTab = items.find((e) => e.role === "tab" && e.selected)
  if (activeTab) state.activeTab = activeTab.text.slice(0, 60)

  const errorElements = items.filter(
    (e) =>
      e.role === "alert" ||
      (e.className && /error|invalid|danger/i.test(e.className)) ||
      (e.ariaLabel && /error/i.test(e.ariaLabel))
  )
  if (errorElements.length > 0) {
    state.errors = errorElements.map((e) => e.text.slice(0, 100))
  }

  const loadingElements = items.filter(
    (e) =>
      e.role === "progressbar" ||
      (e.className && /loading|spinner|skeleton/i.test(e.className)) ||
      (e.ariaLabel && /loading/i.test(e.ariaLabel))
  )
  if (loadingElements.length > 0) state.loading = true

  if (formInputs.length > 0) {
    const filled = formInputs.filter((e) => e.value).length
    if (filled === 0) state.formState = "empty"
    else if (filled === formInputs.length) state.formState = "complete"
    else state.formState = "partial"
  }

  // Detect navigation context (breadcrumbs, back links)
  const navigation = {}
  const breadcrumbRegion = regions.find((r) => {
    const rLinks = r.elements.filter((e) => e.tag === "a")
    return (
      rLinks.length >= 2 &&
      rLinks.length <= 6 &&
      rLinks.every((l) => Math.abs(l.y - rLinks[0].y) < 5) &&
      r.yMin < 150
    )
  })
  if (breadcrumbRegion) {
    navigation.breadcrumb = breadcrumbRegion.elements
      .filter((e) => e.tag === "a" || (e.text && !e.interactive))
      .map((e) => e.text.slice(0, 40))
  }

  const backLink = items.find(
    (e) =>
      e.tag === "a" &&
      (e.text || "").toLowerCase().match(/^(back|go back|← back|previous)/)
  )
  if (backLink) navigation.back = backLink.href || backLink.text

  const result = {
    page: pageMeta?.h1Text || pageMeta?.title || "Unknown",
    url: pageMeta?.url || "",
    purpose: inferPagePurpose(pageMeta, pageType, formInputs, headings),
    type: pageType,
    state,
    sections,
    actions: Object.keys(actions).length > 0 ? actions : undefined,
    navigation: Object.keys(navigation).length > 0 ? navigation : undefined,
    framework: frameworkInfo && frameworkInfo.length > 0 ? frameworkInfo : undefined,
  }

  return result
}

function inferPagePurpose(pageMeta, pageType, formInputs, headings) {
  const title = (
    pageMeta?.h1Text ||
    pageMeta?.title ||
    ""
  ).toLowerCase()
  const desc = (pageMeta?.description || "").toLowerCase()

  if (pageType === "form") {
    if (title.match(/create|new|add/)) return `Form to create a new item`
    if (title.match(/edit|update|modify/)) return `Form to edit an existing item`
    if (title.match(/login|sign in|log in/)) return `Authentication form`
    if (title.match(/register|sign up|create account/)) return `Registration form`
    if (title.match(/search|filter/)) return `Search/filter interface`
    if (title.match(/settings|preferences|config/)) return `Settings configuration`
    return `Form with ${formInputs.length} fields`
  }

  if (pageType === "listing") return `List/catalog view`
  if (pageType === "detail") return `Detail view`
  if (pageType === "dashboard") return `Dashboard`
  if (pageType === "tabbed") return `Tabbed interface`

  if (desc) return desc.slice(0, 120)
  return title.slice(0, 120) || "Web page"
}

// ─── Level 3: Intent Layer ───────────────────────────────────────────────────

function buildIntentLayer(items, pageMeta, semanticMap) {
  const steps = []

  // Determine a logical interaction flow
  const regions = clusterIntoRegions(items)

  // 1. If there's a form, the intent is to fill it
  const formInputs = items.filter((e) =>
    ["input", "select", "textarea"].includes(e.tag)
  )
  const emptyInputs = formInputs.filter((e) => !e.value && !e.disabled)

  // 2. Active navigation (tabs, links the user might need)
  const activeTabs = items.filter((e) => e.role === "tab" && !e.selected)

  // 3. Buttons
  const allButtons = items.filter(
    (e) =>
      (e.tag === "button" || e.role === "button") && !e.disabled
  )

  // Build step sequence: focus on empty form fields first, then primary action
  let stepIdx = 0

  for (const inp of emptyInputs) {
    const label = findLabelForInput(inp, items)
    const cleanLabel = label
      ? label.replace(/[:\*]$/, "").trim()
      : inp.name || inp.placeholder || "field"

    if (inp.tag === "select") {
      steps.push({
        step: ++stepIdx,
        action: "select",
        target: cleanLabel,
        selector: inp.selector || undefined,
        type: "select",
        required: inp.required || false,
      })
    } else if (inp.tag === "textarea") {
      steps.push({
        step: ++stepIdx,
        action: "type",
        target: cleanLabel,
        selector: inp.selector || undefined,
        type: "textarea",
        required: inp.required || false,
      })
    } else if (
      inp.type === "checkbox" ||
      inp.role === "checkbox"
    ) {
      steps.push({
        step: ++stepIdx,
        action: "check",
        target: cleanLabel,
        selector: inp.selector || undefined,
      })
    } else if (inp.type === "radio" || inp.role === "radio") {
      steps.push({
        step: ++stepIdx,
        action: "select",
        target: cleanLabel,
        selector: inp.selector || undefined,
        type: "radio",
      })
    } else {
      steps.push({
        step: ++stepIdx,
        action: "type",
        target: cleanLabel,
        selector: inp.selector || undefined,
        type: inp.type || "text",
        required: inp.required || false,
        placeholder: inp.placeholder || undefined,
      })
    }
  }

  // Add standalone checkboxes/radios that aren't input tags
  const standAloneChecks = items.filter(
    (e) =>
      (e.role === "checkbox" || e.role === "radio" || e.role === "switch") &&
      !["input"].includes(e.tag) &&
      !e.disabled
  )
  for (const chk of standAloneChecks) {
    const label = chk.ariaLabel || chk.text || "option"
    steps.push({
      step: ++stepIdx,
      action: chk.role === "radio" ? "select" : "toggle",
      target: label.slice(0, 80),
      selector: chk.selector || undefined,
      currentState: chk.checked ? "checked" : "unchecked",
    })
  }

  // Add primary action button last
  const primaryBtn = allButtons.find(
    (b) => classifyButton(b) === "primary"
  )
  if (primaryBtn) {
    steps.push({
      step: ++stepIdx,
      action: "click",
      target: (primaryBtn.text || primaryBtn.ariaLabel || "Submit").slice(0, 60),
      selector: primaryBtn.selector || undefined,
      classification: "primary",
    })
  }

  // Add secondary/other buttons as alternatives
  const secondaryBtns = allButtons.filter(
    (b) => classifyButton(b) === "secondary"
  )
  const alternatives = secondaryBtns.map((b) => ({
    action: "click",
    target: (b.text || b.ariaLabel || "button").slice(0, 60),
    selector: b.selector || undefined,
    classification: "secondary",
  }))

  const destructiveBtns = allButtons.filter(
    (b) => classifyButton(b) === "destructive"
  )
  for (const d of destructiveBtns) {
    alternatives.push({
      action: "click",
      target: (d.text || d.ariaLabel || "button").slice(0, 60),
      selector: d.selector || undefined,
      classification: "destructive",
    })
  }

  // Determine suggested task
  let suggestedTask = "Interact with the page"
  if (semanticMap) {
    if (semanticMap.type === "form" && emptyInputs.length > 0) {
      suggestedTask = `Fill out the "${semanticMap.page}" form (${emptyInputs.length} empty fields)`
    } else if (semanticMap.type === "form" && emptyInputs.length === 0) {
      suggestedTask = `Review and submit the "${semanticMap.page}" form`
    } else if (semanticMap.type === "listing") {
      suggestedTask = `Browse or select from the list`
    } else if (semanticMap.type === "detail") {
      suggestedTask = `Review "${semanticMap.page}" details`
    }
  }

  const result = {
    page: pageMeta?.h1Text || pageMeta?.title || "Unknown",
    suggestedTask,
    totalSteps: steps.length,
    steps,
  }

  if (alternatives.length > 0) {
    result.alternatives = alternatives
  }

  // Add navigation context
  if (semanticMap?.navigation) {
    result.navigation = semanticMap.navigation
  }

  return result
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function output(data, isJSON = false) {
  const text = isJSON ? JSON.stringify(data, null, 2) : String(data)

  if (outputFile) {
    writeFileSync(outputFile, text, "utf-8")
    console.log(`Output written to ${outputFile}`)
  } else {
    console.log(text)
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { ws, evaluate, page } = await connectCDP()

  console.error(`Tab: ${page.title}`)
  console.error(`URL: ${page.url}`)
  console.error("")

  try {
    // Framework detection
    if (detectOnly) {
      const frameworks = await evaluate(DETECT_FRAMEWORK_EXPR)
      console.log("Detected Frameworks:")
      console.log("====================")
      for (const fw of frameworks) {
        console.log(`  ${fw.name} (${fw.version})`)
        console.log(`    State access: ${fw.stateAccess}`)
      }
      return
    }

    // Level 0: Raw scan
    if (level === 0) {
      const items = await evaluate(SCAN_RAW_EXPR)
      console.error(`Scanned ${items.length} elements\n`)
      output(formatLevel0(items))
      return
    }

    // All higher levels need the raw scan + page metadata
    const [items, pageMeta, frameworkInfo] = await Promise.all([
      evaluate(SCAN_RAW_EXPR),
      evaluate(PAGE_META_EXPR),
      evaluate(DETECT_FRAMEWORK_EXPR),
    ])

    console.error(`Scanned ${items.length} elements`)
    console.error(
      `Framework: ${frameworkInfo.map((f) => `${f.name} (${f.version})`).join(", ")}`
    )
    console.error("")

    if (level === 1) {
      output(formatLevel1(items, pageMeta))
      return
    }

    // Level 2: Semantic Map
    const semanticMap = buildSemanticMap(items, pageMeta, frameworkInfo)

    if (level === 2) {
      output(semanticMap, true)
      return
    }

    // Level 3: Intent Layer
    if (level === 3) {
      const intentLayer = buildIntentLayer(items, pageMeta, semanticMap)
      output(intentLayer, true)
      return
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})

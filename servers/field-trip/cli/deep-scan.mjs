#!/usr/bin/env node
/** Deep page scanner — gets ALL visible text and elements for context */

import http from "http"

const port = parseInt(process.argv[2] || "9222")

const targets = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let data = ""
    res.on("data", (c) => (data += c))
    res.on("end", () => resolve(JSON.parse(data)))
  }).on("error", reject)
})

const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"))
if (!page) { console.error("No page tab found"); process.exit(1) }

console.log(`Tab: ${page.title}\nURL: ${page.url}\n`)

const { WebSocket } = await import("ws")
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((resolve) => ws.on("open", resolve))

let msgId = 0
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === id) {
        ws.off("message", handler)
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
    throw new Error(result.exceptionDetails.exception?.description || "eval failed")
  }
  return result.result?.value
}

// Action: click, type, or just scan
const action = process.argv[3] || "scan"
const actionArg = process.argv[4] || ""
const actionVal = process.argv[5] || ""

if (action === "scan") {
  // Deep scan — get all visible content organized by sections
  const data = await evaluate(`
    (() => {
      const sections = [];

      // Get all visible text blocks
      const allElements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, div, label, a, button, input, select, textarea, li, td, th, [role="heading"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="listitem"], [data-testid]');
      const items = [];
      const seen = new Set();

      for (const el of allElements) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        // Skip if parent already captured this text
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
        if (!text && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') continue;

        // For non-interactive elements, skip duplicates
        const isInteractive = ['A','BUTTON','INPUT','SELECT','TEXTAREA'].includes(el.tagName) || el.getAttribute('role') === 'button';
        if (!isInteractive && seen.has(text)) continue;
        if (text) seen.add(text);

        // Only include leaf-ish elements (text length < 300 to avoid big containers)
        if (!isInteractive && text.length > 300) continue;

        items.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 150),
          id: el.id || undefined,
          name: el.name || undefined,
          type: el.type || undefined,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          dataTestid: el.getAttribute('data-testid') || undefined,
          value: (el.value !== undefined && el.value !== '') ? String(el.value).slice(0, 80) : undefined,
          y: Math.round(rect.y),
          interactive: isInteractive,
        });
      }

      // Sort by vertical position
      items.sort((a, b) => a.y - b.y);

      return { elements: items.slice(0, 150), total: items.length };
    })()
  `)

  console.log(`Total elements: ${data.total} (showing ${data.elements.length})\n`)

  let lastY = -100
  for (const el of data.elements) {
    if (el.y - lastY > 30) console.log('') // visual separator for vertical gaps
    lastY = el.y

    const marker = el.interactive ? '>>>' : '   '
    const parts = [`${marker} <${el.tag}>`]
    if (el.id) parts.push(`id="${el.id}"`)
    if (el.name) parts.push(`name="${el.name}"`)
    if (el.type) parts.push(`type="${el.type}"`)
    if (el.dataTestid) parts.push(`testid="${el.dataTestid}"`)
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
    if (el.role) parts.push(`role="${el.role}"`)
    if (el.value) parts.push(`val="${el.value}"`)
    if (el.text) parts.push(`"${el.text}"`)
    console.log(parts.join(' '))
  }
} else if (action === "click") {
  // Click an element by ID or selector
  const clicked = await evaluate(`
    (() => {
      let el = document.getElementById(${JSON.stringify(actionArg)});
      if (!el) el = document.querySelector(${JSON.stringify(actionArg)});
      if (!el) return { success: false, error: 'not found' };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      return { success: true, tag: el.tagName, text: (el.textContent||'').trim().slice(0, 100) };
    })()
  `)
  console.log(clicked.success ? `Clicked: <${clicked.tag}> "${clicked.text}"` : `Failed: ${clicked.error}`)
} else if (action === "type") {
  const typed = await evaluate(`
    (() => {
      let el = document.getElementById(${JSON.stringify(actionArg)});
      if (!el) el = document.querySelector(${JSON.stringify(actionArg)});
      if (!el) return { success: false, error: 'not found' };
      el.focus();
      el.value = ${JSON.stringify(actionVal)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, tag: el.tagName, value: el.value };
    })()
  `)
  console.log(typed.success ? `Typed "${typed.value}" into <${typed.tag}>` : `Failed: ${typed.error}`)
}

ws.close()

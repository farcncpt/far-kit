#!/usr/bin/env node
/** Quick page scanner — connects to CDP and dumps interactive elements */

import http from "http"

const port = parseInt(process.argv[2] || "9222")

// Get targets
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

// Connect via WebSocket
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

// Scan the page
const data = await evaluate(`
  (() => {
    const result = { title: document.title, url: location.href };
    const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], h1, h2, h3, h4, label, span[class*="title"], span[class*="header"], div[class*="nav"] > *, [data-testid]');
    const items = [];
    for (const el of interactive) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 150);
      if (!text && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') continue;
      items.push({
        tag: el.tagName.toLowerCase(),
        text,
        type: el.type || undefined,
        name: el.name || undefined,
        id: el.id || undefined,
        role: el.getAttribute('role') || undefined,
        href: (el.href || '').slice(0, 100) || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        value: el.value !== undefined && el.value !== '' ? String(el.value).slice(0, 50) : undefined,
        dataTestid: el.getAttribute('data-testid') || undefined,
        className: (el.className || '').toString().slice(0, 80) || undefined,
      });
    }
    result.elements = items.slice(0, 120);
    result.totalFound = interactive.length;
    return result;
  })()
`)

console.log(`Found ${data.totalFound} interactive elements (showing ${data.elements.length}):\n`)

for (const el of data.elements) {
  const parts = [`<${el.tag}>`]
  if (el.id) parts.push(`id="${el.id}"`)
  if (el.name) parts.push(`name="${el.name}"`)
  if (el.type) parts.push(`type="${el.type}"`)
  if (el.role) parts.push(`role="${el.role}"`)
  if (el.dataTestid) parts.push(`data-testid="${el.dataTestid}"`)
  if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
  if (el.value) parts.push(`value="${el.value}"`)
  if (el.text) parts.push(`"${el.text.slice(0, 80)}"`)
  console.log(`  ${parts.join(' ')}`)
}

ws.close()

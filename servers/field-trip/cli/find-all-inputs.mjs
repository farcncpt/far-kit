#!/usr/bin/env node
import http from "http"
const port = 9222
const targets = await new Promise((r, j) => { http.get(`http://127.0.0.1:${port}/json`, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => r(JSON.parse(d))); }).on("error", j) })
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
const { WebSocket } = await import("ws")
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise(r => ws.on("open", r))
let msgId = 0
const send = (m, p = {}) => new Promise(r => { const id = ++msgId; const h = raw => { const msg = JSON.parse(raw.toString()); if (msg.id === id) { ws.off("message", h); r(msg.result) } }; ws.on("message", h); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.value }

// Get the full ttoContainer content - buttons, checkboxes, links
const result = await ev(`
  (() => {
    const container = document.querySelector('#ttoContainer') || document.querySelector('#contentRegion');
    if (!container) return { error: 'no container' };

    const items = [];
    const els = container.querySelectorAll('button, input, a, [role="button"], label');
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      items.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        type: el.type || '',
        name: el.name || '',
        text: (el.textContent || '').trim().slice(0, 80),
        ariaLabel: el.getAttribute('aria-label') || '',
        checked: el.checked || false,
        y: Math.round(rect.y),
        visible: rect.height > 0,
      });
    }
    return { containerHeight: container.scrollHeight, items };
  })()
`)

console.log("Container height:", result.containerHeight)
for (const el of (result.items || [])) {
  if (!el.visible) continue;
  const check = el.checked ? '[x]' : (el.type === 'checkbox' ? '[ ]' : '')
  console.log(`y=${el.y} <${el.tag}> ${el.type} ${check} id="${el.id}" "${el.text.slice(0,60)}"`)
}

ws.close()

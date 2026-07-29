#!/usr/bin/env node
/** Scroll down and find all buttons on page */
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

// Scroll the main content area down
await ev(`
  const sw = document.querySelector('#scroll_wrapper');
  if (sw) sw.scrollTop = sw.scrollHeight;
  else window.scrollTo(0, document.body.scrollHeight);
  'scrolled'
`)

await new Promise(r => setTimeout(r, 1000))

// Find all buttons
const buttons = await ev(`
  (() => {
    const btns = document.querySelectorAll('button');
    return Array.from(btns).map(b => ({
      id: b.id,
      text: b.textContent.trim().slice(0, 60),
      ariaLabel: b.getAttribute('aria-label') || '',
      visible: getComputedStyle(b).display !== 'none',
      y: b.getBoundingClientRect().y,
    })).filter(b => b.visible && b.text);
  })()
`)

for (const b of buttons) {
  console.log(`y=${b.y} id="${b.id}" aria="${b.ariaLabel}" "${b.text}"`)
}

ws.close()

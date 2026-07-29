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

const search = process.argv[2] || "Holding"
const result = await ev(`
  (() => {
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      if (!row.textContent.includes(${JSON.stringify(search)})) continue;
      const buttons = row.querySelectorAll('button');
      return Array.from(buttons).map(b => ({ id: b.id, ariaLabel: b.getAttribute('aria-label'), text: b.textContent.trim().slice(0, 40) }));
    }
    return [];
  })()
`)
console.log(JSON.stringify(result, null, 2))
ws.close()

#!/usr/bin/env node
import http from "http"
const port = 9222
const targets = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let data = ""
    res.on("data", (c) => (data += c))
    res.on("end", () => resolve(JSON.parse(data)))
  }).on("error", reject)
})
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://"))
const { WebSocket } = await import("ws")
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((resolve) => ws.on("open", resolve))
let msgId = 0
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === id) { ws.off("message", handler); resolve(msg.result) }
    }
    ws.on("message", handler)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "fail")
  return r.result?.value
}

const result = await evaluate(`
  (() => {
    // Find all expense category rows
    const rows = document.querySelectorAll('tr');
    const results = [];
    for (const row of rows) {
      const text = (row.textContent || '').trim();
      if (text.length < 5 || text.length > 200) continue;

      // Look for expense-related rows
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 2) continue;

      const buttons = row.querySelectorAll('button');
      const links = row.querySelectorAll('a');
      const allClickable = [...buttons, ...links];

      results.push({
        text: text.slice(0, 120),
        cellTexts: cells.map(c => c.textContent.trim().slice(0, 60)),
        buttons: Array.from(buttons).map(b => ({
          id: b.id || '',
          text: b.textContent.trim().slice(0, 40),
          ariaLabel: b.getAttribute('aria-label') || '',
        })),
        links: Array.from(links).map(a => ({
          id: a.id || '',
          text: a.textContent.trim().slice(0, 40),
          href: (a.href || '').slice(0, 80),
        })),
        rowId: row.id || '',
        cursor: getComputedStyle(row).cursor,
      });
    }
    return results;
  })()
`)

for (const row of result) {
  console.log(`\\nRow: "${row.text.slice(0, 80)}"`)
  console.log(`  Cells: ${JSON.stringify(row.cellTexts)}`)
  if (row.buttons.length) console.log(`  Buttons: ${JSON.stringify(row.buttons)}`)
  if (row.links.length) console.log(`  Links: ${JSON.stringify(row.links)}`)
  if (row.cursor === 'pointer') console.log(`  [Row is clickable]`)
}

ws.close()

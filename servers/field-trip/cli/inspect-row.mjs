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
  return r.result?.value
}

const result = await evaluate(`
  (() => {
    // Find the Clothing retail row and see what's clickable
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      if (!row.textContent || !row.textContent.includes('Clothing retail')) continue;

      // Check all elements in this row
      const allEls = row.querySelectorAll('*');
      const info = [];
      for (const el of allEls) {
        info.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          text: (el.textContent || '').trim().slice(0, 80),
          className: (el.className || '').toString().slice(0, 60),
          cursor: getComputedStyle(el).cursor,
          role: el.getAttribute('role') || '',
          tabindex: el.getAttribute('tabindex') || '',
          hasClick: typeof el.onclick === 'function',
        });
      }

      // Also check the row itself
      return {
        rowCursor: getComputedStyle(row).cursor,
        rowRole: row.getAttribute('role') || '',
        rowTabindex: row.getAttribute('tabindex') || '',
        rowId: row.id || '',
        elements: info,
        html: row.outerHTML.slice(0, 1000),
      };
    }
    return null;
  })()
`)

console.log("Row:", result?.rowCursor, result?.rowRole, result?.rowId)
console.log("\\nElements in row:")
for (const el of (result?.elements || [])) {
  if (el.cursor === 'pointer' || el.role || el.tabindex || el.hasClick) {
    console.log(`  <${el.tag}> cursor=${el.cursor} role=${el.role} id=${el.id} text="${el.text.slice(0,60)}"`)
  }
}
console.log("\\nHTML:", result?.html?.slice(0, 800))

ws.close()

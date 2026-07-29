#!/usr/bin/env node
/** Read all form field values from the current TurboTax page */
import http from "http"
const port = 9222
const targets = await new Promise((r, j) => { http.get(`http://127.0.0.1:${port}/json`, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => r(JSON.parse(d))); }).on("error", j) })
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
const { WebSocket } = await import("ws")
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise(r => ws.on("open", r))
let msgId = 0
const send = (m, p = {}) => new Promise(r => { const id = ++msgId; const h = raw => { const msg = JSON.parse(raw.toString()); if (msg.id === id) { ws.off("message", h); r(msg.result) } }; ws.on("message", h); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return null; return r.result?.value }

const result = await ev(`
  (() => {
    const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
    const fields = [];
    for (const el of inputs) {
      if (!el.value && !el.id) continue;
      // Find the label
      let label = '';
      // Check for preceding label or sibling text
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') label = prev.textContent.trim();
      if (!label) {
        const labelEl = document.querySelector('label[for="' + el.id + '"]');
        if (labelEl) label = labelEl.textContent.trim();
      }
      if (!label) {
        // Check parent row for label text
        const row = el.closest('tr, div, td');
        if (row) {
          const labels = row.querySelectorAll('label, span.label, td:first-child');
          for (const l of labels) {
            const t = l.textContent.trim();
            if (t && t.length < 100 && t !== el.value) {
              label = t;
              break;
            }
          }
        }
      }
      fields.push({
        id: el.id,
        value: el.value,
        label: label.slice(0, 100),
      });
    }

    // Also get radio buttons that are checked
    const radios = document.querySelectorAll('input[type="radio"]:checked');
    for (const r of radios) {
      let label = '';
      const next = r.nextElementSibling;
      if (next) label = next.textContent.trim();
      if (!label) {
        const parent = r.closest('td, div');
        if (parent) label = parent.textContent.trim().slice(0, 80);
      }
      fields.push({
        id: r.id,
        value: '[SELECTED]',
        label: label.slice(0, 100),
      });
    }

    return fields;
  })()
`)

// Group and display
const withValues = result.filter(f => f.value && f.value !== '0' && f.value !== '$0')
console.log("=== FORM FIELDS WITH VALUES ===\\n")
for (const f of withValues) {
  const labelPart = f.label ? ` (${f.label})` : ''
  console.log(`  ${f.id}${labelPart}: ${f.value}`)
}

ws.close()

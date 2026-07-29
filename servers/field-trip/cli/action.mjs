#!/usr/bin/env node
/** Action script — click elements, type text, or run custom JS via CDP */

import http from "http"

const port = parseInt(process.argv[2] || "9222")
const action = process.argv[3] // "click", "type", "eval"
const arg1 = process.argv[4]   // selector or expression
const arg2 = process.argv[5]   // value (for type)

const targets = await new Promise((resolve, reject) => {
  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let data = ""
    res.on("data", (c) => (data += c))
    res.on("end", () => resolve(JSON.parse(data)))
  }).on("error", reject)
})

const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"))
if (!page) { console.error("No page tab found"); process.exit(1) }

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

if (action === "click") {
  const result = await evaluate(`
    (() => {
      // Try by ID first
      let el = document.getElementById(${JSON.stringify(arg1)});
      // Try querySelector
      if (!el) try { el = document.querySelector(${JSON.stringify(arg1)}); } catch(e) {}
      // Try finding by text content
      if (!el) {
        const all = document.querySelectorAll('a, button, td, tr, div[role="button"], span');
        const lower = ${JSON.stringify(arg1)}.toLowerCase();
        for (const candidate of all) {
          const text = (candidate.textContent || '').trim().toLowerCase();
          if (text === lower || text.includes(lower)) {
            el = candidate;
            break;
          }
        }
      }
      if (!el) return { success: false, error: 'Element not found: ' + ${JSON.stringify(arg1)} };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      return { success: true, tag: el.tagName, text: (el.textContent||'').trim().slice(0, 120) };
    })()
  `)
  console.log(JSON.stringify(result, null, 2))

} else if (action === "type") {
  const result = await evaluate(`
    (() => {
      let el = document.getElementById(${JSON.stringify(arg1)});
      if (!el) try { el = document.querySelector(${JSON.stringify(arg1)}); } catch(e) {}
      if (!el) return { success: false, error: 'not found' };
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = ${JSON.stringify(arg2)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      return { success: true, value: el.value };
    })()
  `)
  console.log(JSON.stringify(result, null, 2))

} else if (action === "eval") {
  const result = await evaluate(arg1)
  console.log(JSON.stringify(result, null, 2))

} else if (action === "find") {
  // Find all elements matching text
  const result = await evaluate(`
    (() => {
      const lower = ${JSON.stringify(arg1)}.toLowerCase();
      const all = document.querySelectorAll('*');
      const results = [];
      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .join(' ');
        const fullText = (el.textContent || '').trim();
        if (ownText.toLowerCase().includes(lower) || (fullText.length < 100 && fullText.toLowerCase().includes(lower))) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          results.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            className: (el.className||'').toString().slice(0,80) || undefined,
            text: fullText.slice(0, 150),
            ownText: ownText.slice(0, 150) || undefined,
            clickable: el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.onclick != null,
            y: Math.round(rect.y),
          });
        }
      }
      return results.slice(0, 30);
    })()
  `)
  console.log(JSON.stringify(result, null, 2))

} else {
  console.log("Usage: node action.mjs <port> <click|type|eval|find> <selector|text> [value]")
}

ws.close()

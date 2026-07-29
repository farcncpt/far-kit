#!/usr/bin/env node
/**
 * React-compatible typing via CDP Input.dispatchKeyEvent
 * Usage: node cli/react-type.mjs <selector> <text>
 */
import http from "http"

const port = 9222
const selector = process.argv[2]
const text = process.argv[3]

if (!selector || !text) {
  console.log("Usage: node react-type.mjs <css-selector> <text>")
  process.exit(1)
}

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
await new Promise((r) => ws.on("open", r))

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

// Focus the element
const found = await evaluate(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.focus();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Clear existing value using React-compatible method
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, '');
    } else {
      el.value = '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { tag: el.tagName, id: el.id };
  })()
`)

if (!found) {
  console.error(`Element not found: ${selector}`)
  ws.close()
  process.exit(1)
}

// Type each character using CDP Input events
for (const char of text) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    text: char,
    key: char,
    code: char >= "0" && char <= "9" ? `Digit${char}` : `Key${char.toUpperCase()}`,
    windowsVirtualKeyCode: char.charCodeAt(0),
    nativeVirtualKeyCode: char.charCodeAt(0),
  })
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: char,
    code: char >= "0" && char <= "9" ? `Digit${char}` : `Key${char.toUpperCase()}`,
    windowsVirtualKeyCode: char.charCodeAt(0),
    nativeVirtualKeyCode: char.charCodeAt(0),
  })
}

// Read back the value
const value = await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`)
console.log(`Typed "${value}" into ${found.tag} (${found.id})`)

ws.close()

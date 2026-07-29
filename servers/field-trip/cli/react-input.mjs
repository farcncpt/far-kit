#!/usr/bin/env node
/**
 * React-compatible input via native value setter + InputEvent
 * This is the method that works with React controlled components.
 * Usage: node cli/react-input.mjs <selector> <text>
 */
import http from "http"

const port = 9222
const selector = process.argv[2]
const text = process.argv[3]

if (!selector || text === undefined) {
  console.log("Usage: node react-input.mjs <css-selector> <text>")
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
  if (r.exceptionDetails) {
    console.error("Eval error:", r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return null
  }
  return r.result?.value
}

// The key trick: React uses a fiber-based system. To set a value on a controlled input,
// we need to use the native HTMLInputElement.prototype.value setter, THEN dispatch
// an 'input' event. React's onChange handler internally listens for this.
const result = await evaluate(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { success: false, error: 'not found' };

    // Focus the element
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    // Get the native value setter - this bypasses React's synthetic setter
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (!nativeSetter) {
      return { success: false, error: 'no native setter found' };
    }

    // Clear first
    nativeSetter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // Set the new value using the native setter
    nativeSetter.call(el, ${JSON.stringify(text)});

    // Dispatch input event - this is what React listens to
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // Also try InputEvent which some React versions prefer
    try {
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: ${JSON.stringify(text)},
      }));
    } catch(e) {}

    // Dispatch change event
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Blur to finalize
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

    return { success: true, value: el.value, id: el.id };
  })()
`)

if (result?.success) {
  console.log(`Set "${result.value}" in ${result.id}`)
} else {
  console.error(`Failed: ${result?.error || 'unknown'}`)
}

ws.close()

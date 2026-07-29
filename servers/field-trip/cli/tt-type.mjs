#!/usr/bin/env node
/**
 * Type into TurboTax React inputs by triggering React's onChange directly.
 * Usage: node cli/tt-type.mjs <selector> <value>
 */
import http from "http"

const port = 9222
const selector = process.argv[2]
const text = process.argv[3]

if (!selector || text === undefined) {
  console.log("Usage: node tt-type.mjs <css-selector> <text>")
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
  return new Promise((resolve) => {
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
  if (r.exceptionDetails) { console.error("Error:", r.exceptionDetails.exception?.description); return null }
  return r.result?.value
}

// Step 1: Focus the element
await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)

// Step 2: Use the React internal fiber to trigger onChange directly
const result = await evaluate(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { success: false, error: 'not found' };

    // Find the React props key
    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
    if (!propsKey) return { success: false, error: 'no react props' };

    const props = el[propsKey];

    // Use native setter to set the value on the DOM element
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(el, ${JSON.stringify(text)});

    // Create a synthetic-like event object that React's onChange expects
    const event = new Event('input', { bubbles: true });
    // React reads event.target.value to get the new value
    Object.defineProperty(event, 'target', { value: el, writable: false });

    // Dispatch the event — React's delegated event listener at the root will catch this
    el.dispatchEvent(event);

    // Also call onChange directly if it exists on props
    if (typeof props.onChange === 'function') {
      try {
        props.onChange({ target: el, currentTarget: el, type: 'change', preventDefault: ()=>{}, stopPropagation: ()=>{} });
      } catch(e) {
        // Some React onChange handlers may throw if synthetic event fields are missing
      }
    }

    // Trigger blur to commit
    if (typeof props.onBlur === 'function') {
      try {
        props.onBlur({ target: el, currentTarget: el, type: 'blur', preventDefault: ()=>{}, stopPropagation: ()=>{} });
      } catch(e) {}
    }
    el.dispatchEvent(new Event('blur', { bubbles: true }));

    return { success: true, value: el.value, id: el.id };
  })()
`)

if (result?.success) {
  console.log(`Set "${result.value}" in ${result.id}`)
} else {
  console.error(`Failed: ${result?.error}`)
}

// Also verify the React state updated
const reactValue = await evaluate(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
    return el[propsKey]?.value;
  })()
`)
console.log(`React state value: "${reactValue}"`)

ws.close()

#!/usr/bin/env node
/** Inspect a React input element's internal state and event listeners */
import http from "http"

const port = 9222
const selector = process.argv[2] || "#SE-Generic-Expenses-Amt-Input-0"

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
  if (r.exceptionDetails) { console.error(r.exceptionDetails.exception?.description); return null }
  return r.result?.value
}

const result = await evaluate(`
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: 'not found' };

    // Check for React fiber
    const reactKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('__reactProps'));
    const reactPropsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));

    let reactProps = null;
    if (reactPropsKey) {
      const props = el[reactPropsKey];
      reactProps = {
        hasOnChange: typeof props.onChange === 'function',
        hasOnInput: typeof props.onInput === 'function',
        hasOnBlur: typeof props.onBlur === 'function',
        hasValue: 'value' in props,
        propValue: props.value,
        type: props.type,
        name: props.name,
        maxLength: props.maxLength,
        placeholder: props.placeholder,
        allPropKeys: Object.keys(props).filter(k => !k.startsWith('__')),
      };
    }

    return {
      tag: el.tagName,
      id: el.id,
      type: el.type,
      value: el.value,
      name: el.name,
      className: (el.className || '').slice(0, 100),
      placeholder: el.placeholder,
      maxLength: el.maxLength,
      reactKey: reactKey || 'none',
      reactPropsKey: reactPropsKey || 'none',
      reactProps,
      dataAttributes: Object.fromEntries(
        Array.from(el.attributes)
          .filter(a => a.name.startsWith('data-'))
          .map(a => [a.name, a.value])
      ),
      allKeys: Object.keys(el).filter(k => k.startsWith('__')),
    };
  })()
`)

console.log(JSON.stringify(result, null, 2))

ws.close()

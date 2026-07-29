#!/usr/bin/env node
/** Click all "No" options on TurboTax OTS onramp questions, then find Continue */
import http from "http"
const port = 9222
const targets = await new Promise((r, j) => { http.get(`http://127.0.0.1:${port}/json`, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => r(JSON.parse(d))); }).on("error", j) })
const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
const { WebSocket } = await import("ws")
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise(r => ws.on("open", r))
let msgId = 0
const send = (m, p = {}) => new Promise(r => { const id = ++msgId; const h = raw => { const msg = JSON.parse(raw.toString()); if (msg.id === id) { ws.off("message", h); r(msg.result) } }; ws.on("message", h); ws.send(JSON.stringify({ id, method: m, params: p })) })
const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) { console.error(r.exceptionDetails.exception?.description); return null; } return r.result?.value }

let lastCount = 0
for (let round = 0; round < 30; round++) {
  await new Promise(r => setTimeout(r, 2000))

  const result = await ev(`
    (() => {
      // Find all unchecked "No" radio buttons with onramp pattern
      const noButtons = document.querySelectorAll('input[type="radio"][id*="choice-no"]:not(:checked)');
      let clicked = 0;
      for (const btn of noButtons) {
        btn.click();
        clicked++;
      }

      // Also check for "No, I don't" type labels
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        const text = label.textContent.trim().toLowerCase();
        if (text.startsWith("no,") || text === "no") {
          const radio = label.previousElementSibling || label.querySelector('input[type="radio"]');
          if (radio && radio.type === 'radio' && !radio.checked) {
            radio.click();
            clicked++;
          }
        }
      }

      // Count total checked "no" options
      const checked = document.querySelectorAll('input[type="radio"][id*="choice-no"]:checked');

      // Look for Continue/Done button
      const container = document.querySelector('#ttoContainer') || document.querySelector('#scroll_wrapper');
      const allButtons = container ? container.querySelectorAll('button') : document.querySelectorAll('button');
      let continueBtn = null;
      for (const btn of allButtons) {
        const text = btn.textContent.trim();
        const aria = btn.getAttribute('aria-label') || '';
        if (text === 'Continue' || text === 'Done' || text === 'Keep going' ||
            aria.includes('Continue') || aria.includes('Done') ||
            btn.id.includes('action_Next') || btn.id.includes('action_Done') ||
            btn.id.includes('Action-Next')) {
          continueBtn = { id: btn.id, text };
          break;
        }
      }

      return { clicked, totalChecked: checked.length, continueBtn };
    })()
  `)

  console.log(`Round \${round + 1}: clicked=\${result?.clicked}, totalChecked=\${result?.totalChecked}`)

  if (result?.continueBtn) {
    console.log(`Continue button found: id="\${result.continueBtn.id}" text="\${result.continueBtn.text}"`)
    await ev(`document.getElementById(\${JSON.stringify(result.continueBtn.id)}).click()`)
    console.log("Clicked Continue!")
    break
  }

  if (result?.totalChecked === lastCount && result?.clicked === 0 && round > 3) {
    console.log("No more questions appearing")
    break
  }
  lastCount = result?.totalChecked || 0
}

await new Promise(r => setTimeout(r, 3000))
const p = await ev(`({ h1: document.querySelector('h1')?.textContent?.trim() || '', url: location.href })`)
console.log(`Now on: \${p?.h1}`)

ws.close()

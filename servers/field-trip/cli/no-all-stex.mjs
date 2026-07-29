#!/usr/bin/env node
/** Click "No" on all STEX (suggested expense) questions, then find Continue */
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

// Click all "No" radio buttons in STEX questions
let lastCount = 0
for (let round = 0; round < 20; round++) {
  await new Promise(r => setTimeout(r, 1500))

  const result = await ev(`
    (() => {
      // Find all unchecked "No" radio buttons (choices-1 pattern)
      const noButtons = document.querySelectorAll('input[type="radio"][id*="choices-1"]:not(:checked)');
      let clicked = 0;
      for (const btn of noButtons) {
        if (btn.id.includes('stex') || btn.id.includes('template')) {
          btn.click();
          clicked++;
        }
      }

      // Check if Continue button appeared
      const allButtons = document.querySelectorAll('button');
      let continueBtn = null;
      for (const btn of allButtons) {
        if (btn.id.includes('action_Next') || btn.id.includes('action_Done') ||
            (btn.getAttribute('aria-label') || '').includes('Continue') ||
            (btn.textContent || '').trim() === 'Continue') {
          continueBtn = { id: btn.id, text: btn.textContent.trim() };
          break;
        }
      }

      // Count total checked
      const checked = document.querySelectorAll('input[type="radio"][id*="choices-1"]:checked');
      return { clicked, totalChecked: checked.length, continueBtn };
    })()
  `)

  console.log(`Round ${round + 1}: clicked=${result?.clicked}, totalChecked=${result?.totalChecked}`)

  if (result?.continueBtn) {
    console.log(`Continue button found: id="${result.continueBtn.id}" text="${result.continueBtn.text}"`)
    // Click it
    await ev(`document.getElementById(${JSON.stringify(result.continueBtn.id)}).click()`)
    console.log("Clicked Continue!")
    break
  }

  if (result?.totalChecked === lastCount && result?.clicked === 0) {
    console.log("No more questions appearing, looking for Continue...")
    // Scroll to bottom
    await ev(`document.querySelector('#scroll_wrapper')?.scrollTo(0, 99999) || window.scrollTo(0, 99999)`)
    await new Promise(r => setTimeout(r, 1000))

    const btn = await ev(`
      (() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const t = b.textContent.trim();
          if (t === 'Continue' || t === 'Done' || t === 'Next') return { id: b.id, text: t };
        }
        return null;
      })()
    `)
    if (btn) {
      console.log(`Found: id="${btn.id}" text="${btn.text}"`)
      await ev(`document.getElementById(${JSON.stringify(btn.id)}).click()`)
      console.log("Clicked!")
      break
    }
  }
  lastCount = result?.totalChecked || 0
}

await new Promise(r => setTimeout(r, 2000))
const page2 = await ev(`({ title: document.title, h1: document.querySelector('h1')?.textContent?.trim() || '' })`)
console.log(`Now on: ${page2?.h1}`)

ws.close()

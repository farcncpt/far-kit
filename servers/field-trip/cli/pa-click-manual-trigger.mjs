#!/usr/bin/env node
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-click" })

// Click "Manually trigger a flow" in the panel
console.log("Clicking 'Manually trigger a flow'...")
const res = await relay.command("eval", {
  expression: `
    (() => {
      const panel = document.querySelector('.ms-Panel-content');
      if (!panel) return 'no panel';
      const els = panel.querySelectorAll('button, div[tabindex="0"], [role="option"]');
      for (const el of els) {
        const text = (el.textContent || '').trim();
        if (text.startsWith('Manually trigger a flow') && el.getBoundingClientRect().height > 30) {
          el.click();
          return 'clicked: ' + text.slice(0, 40);
        }
      }
      // Try the first item that mentions "Manually"
      for (const el of els) {
        if ((el.textContent || '').includes('Manually trigger')) {
          el.click();
          return 'clicked by partial match';
        }
      }
      return 'not found';
    })()
  `
})
console.log("Result:", res)

await new Promise(r => setTimeout(r, 4000))

// Check what's on the canvas now
const canvas = await relay.command("eval", {
  expression: `
    (() => {
      const wf = document.querySelector('[aria-label="Workflow canvas"]');
      const text = wf ? wf.textContent.replace(/\\s+/g, ' ').slice(0, 400) : 'no canvas';

      // Look for "+" or "Add an action" button
      const buttons = document.querySelectorAll('button');
      const actionButtons = [];
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label') || btn.textContent.trim();
        if (label.includes('Insert') || label.includes('Add an action') || label.includes('new step') || label === '+') {
          actionButtons.push({ label: label.slice(0, 50), id: btn.id });
        }
      }

      return { canvasText: text, actionButtons };
    })()
  `
})

console.log("\nCanvas:", canvas.canvasText?.slice(0, 200))
console.log("\nAction buttons found:")
for (const b of (canvas.actionButtons || [])) {
  console.log(`  id="${b.id}" — "${b.label}"`)
}

relay.close()

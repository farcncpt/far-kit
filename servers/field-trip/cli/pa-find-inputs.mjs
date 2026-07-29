#!/usr/bin/env node
/** Find ALL input elements on Power Automate including the panel search */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-inputs" })

const page = await relay.command("page")
console.log(`Page: ${page.title}\n`)

// First, make sure the trigger panel is open
console.log("Opening trigger panel...")
await relay.command("eval", {
  expression: `
    (() => {
      const trigger = document.querySelector('[aria-label="Add a trigger"]');
      if (trigger) { trigger.click(); return 'clicked trigger'; }
      return 'trigger not found';
    })()
  `
})
await new Promise(r => setTimeout(r, 2000))

// Find ALL inputs on the page
const inputs = await relay.command("eval", {
  expression: `
    (() => {
      const allInputs = document.querySelectorAll('input, textarea, [role="searchbox"], [role="combobox"], [contenteditable="true"]');
      const results = [];
      for (const el of allInputs) {
        const rect = el.getBoundingClientRect();
        results.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          name: el.name || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.placeholder || '',
          role: el.getAttribute('role') || '',
          className: (el.className || '').toString().slice(0, 80),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0,
          value: (el.value || '').slice(0, 30),
        });
      }
      return results;
    })()
  `
})

console.log(`Found ${inputs.length} inputs:\n`)
for (const inp of inputs) {
  const vis = inp.visible ? '' : ' [HIDDEN]'
  console.log(`  <${inp.tag}> type="${inp.type}" id="${inp.id}" aria="${inp.ariaLabel}" placeholder="${inp.placeholder}" at (${inp.x},${inp.y}) ${inp.w}x${inp.h}${vis}`)
}

// Also check for the panel itself
console.log("\n=== Panel detection ===")
const panels = await relay.command("eval", {
  expression: `
    (() => {
      const panels = document.querySelectorAll('[role="dialog"], [role="complementary"], [class*="Panel"], [class*="panel"], [class*="flyout"], [class*="Flyout"], [class*="drawer"], [class*="Drawer"]');
      return Array.from(panels).map(p => ({
        tag: p.tagName.toLowerCase(),
        role: p.getAttribute('role'),
        ariaLabel: p.getAttribute('aria-label') || '',
        className: (p.className || '').toString().slice(0, 80),
        width: Math.round(p.getBoundingClientRect().width),
        height: Math.round(p.getBoundingClientRect().height),
        inputCount: p.querySelectorAll('input').length,
        buttonCount: p.querySelectorAll('button').length,
      }));
    })()
  `
})

for (const p of panels) {
  console.log(`  <${p.tag}> role="${p.role}" aria="${p.ariaLabel}" class="${p.className}" ${p.width}x${p.height} — ${p.inputCount} inputs, ${p.buttonCount} buttons`)
}

relay.close()

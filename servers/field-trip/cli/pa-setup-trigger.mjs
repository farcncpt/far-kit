#!/usr/bin/env node
/** Detailed exploration of the trigger selection process */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-setup" })

console.log("Connected. Let me explore the page step by step.\n")

// First, dump everything visible on the page to understand the current state
console.log("=== FULL PAGE STATE ===\n")
const state = await relay.command("eval", {
  expression: `
    (() => {
      const allEls = document.querySelectorAll('button, input, [role="button"], [role="tab"], [role="option"], [role="listitem"], [role="textbox"], a, h1, h2, h3, div[tabindex="0"]');
      const items = [];
      const seen = new Set();
      for (const el of allEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const key = text + '|' + ariaLabel;
        if (seen.has(key)) continue;
        seen.add(key);

        // Skip really long text (containers)
        if (text.length > 120) continue;

        items.push({
          text,
          ariaLabel,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          id: el.id || '',
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items.slice(0, 60);
    })()
  `
})

for (const el of state) {
  const location = `(${el.x},${el.y}) ${el.w}x${el.h}`
  const aria = el.ariaLabel ? ` aria="${el.ariaLabel}"` : ''
  const id = el.id ? ` id="${el.id}"` : ''
  console.log(`  <${el.tag}>${id}${aria} "${el.text}" @ ${location}`)
}

// Now click the trigger node on the canvas
console.log("\n=== CLICKING TRIGGER NODE ON CANVAS ===\n")
const click1 = await relay.command("eval", {
  expression: `
    (() => {
      // The "Add a trigger" is a node on the react-flow canvas
      // Find it and click it
      const nodes = document.querySelectorAll('[data-testid], [class*="node"], [class*="Node"]');
      for (const node of nodes) {
        const text = (node.textContent || '').trim();
        if (text.includes('Add a trigger') && node.getBoundingClientRect().width > 100) {
          node.click();
          return { clicked: true, text: text.slice(0, 60), tag: node.tagName };
        }
      }

      // Try clicking the div with role="button" that says "Add a trigger"
      const btns = document.querySelectorAll('div[role="button"], button');
      for (const btn of btns) {
        if (btn.textContent?.trim() === 'Add a trigger') {
          btn.click();
          return { clicked: true, text: 'Add a trigger', method: 'exact match' };
        }
      }

      // Try aria-label
      const ariaBtn = document.querySelector('[aria-label="Add a trigger"]');
      if (ariaBtn) {
        ariaBtn.click();
        return { clicked: true, method: 'aria-label' };
      }

      return { clicked: false };
    })()
  `
})
console.log("Click:", JSON.stringify(click1))

await new Promise(r => setTimeout(r, 3000))

// Check what appeared
console.log("\n=== AFTER CLICKING TRIGGER — WHAT'S NEW ===\n")
const afterClick = await relay.command("eval", {
  expression: `
    (() => {
      // Check for panels, dialogs, search inputs
      const panels = document.querySelectorAll('.ms-Panel, [role="dialog"], [class*="panel"], [class*="Panel"]');
      const inputs = document.querySelectorAll('input');
      const panelInfo = [];

      for (const p of panels) {
        const rect = p.getBoundingClientRect();
        if (rect.width < 100) continue;
        panelInfo.push({
          class: (p.className || '').toString().slice(0, 80),
          role: p.getAttribute('role'),
          ariaLabel: p.getAttribute('aria-label') || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.height > 0,
        });
      }

      // Find all items in any open panel
      const allClickable = document.querySelectorAll('.ms-Panel button, .ms-Panel [role="option"], .ms-Panel div[tabindex="0"]');
      const panelItems = [];
      const seen = new Set();
      for (const el of allClickable) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 15 || rect.width > 500) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        if (!text || seen.has(text) || text.length < 2) continue;
        seen.add(text);
        panelItems.push({ text, y: Math.round(rect.y) });
      }
      panelItems.sort((a, b) => a.y - b.y);

      return {
        panelCount: panelInfo.length,
        panels: panelInfo,
        inputCount: inputs.length,
        panelItems: panelItems.slice(0, 30),
      };
    })()
  `
})

console.log(`Panels: ${afterClick.panelCount}, Inputs: ${afterClick.inputCount}`)
console.log(`\nPanel items (${afterClick.panelItems?.length}):`)
for (const item of (afterClick.panelItems || [])) {
  console.log(`  ${item.text}`)
}

// If we see "Manually trigger a flow" in the panel items, click it
const manualTrigger = afterClick.panelItems?.find(i => i.text.includes('Manually trigger'))
if (manualTrigger) {
  console.log(`\n>>> Found "Manually trigger a flow" — clicking it!`)
  await relay.command("eval", {
    expression: `
      (() => {
        const panel = document.querySelector('.ms-Panel');
        if (!panel) return 'no panel';
        const els = panel.querySelectorAll('button, div[tabindex="0"], [role="option"]');
        for (const el of els) {
          if (el.textContent.trim().includes('Manually trigger a flow')) {
            el.click();
            return 'clicked';
          }
        }
        return 'not found in panel';
      })()
    `
  })

  await new Promise(r => setTimeout(r, 3000))

  // Verify trigger was placed
  const verify = await relay.command("eval", {
    expression: `
      (() => {
        const canvas = document.querySelector('[aria-label="Workflow canvas"]');
        const text = canvas?.textContent?.replace(/\\s+/g, ' ')?.slice(0, 300) || '';
        const hasPlus = !!document.querySelector('[aria-label*="Insert a new step"]');
        const hasAddAction = text.includes('Add an action') || text.includes('+');
        return { canvasText: text, hasPlus, hasAddAction };
      })()
    `
  })
  console.log("\nCanvas after trigger:", JSON.stringify(verify, null, 2))
}

relay.close()
console.log("\nDone!")

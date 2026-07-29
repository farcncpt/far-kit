#!/usr/bin/env node
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-v2" })

// Step 1: Click the "Add a trigger" node on the canvas to open the panel
console.log("Step 1: Clicking 'Add a trigger' on canvas...")
await relay.command("eval", {
  expression: `
    (() => {
      const node = document.querySelector('[aria-label="Add a trigger"]');
      if (node) { node.click(); return 'clicked'; }
      // Also try the div button
      const divs = document.querySelectorAll('div[role="button"]');
      for (const d of divs) {
        if (d.textContent.trim().includes('Add a trigger')) { d.click(); return 'clicked div'; }
      }
      return 'not found';
    })()
  `
})
await new Promise(r => setTimeout(r, 2500))

// Step 2: Check that the panel is open and search input exists
console.log("Step 2: Checking panel state...")
const panelState = await relay.command("eval", {
  expression: `
    (() => {
      const searchInput = document.querySelector('input[aria-label="Search for an action or connector"]');
      const panel = document.querySelector('.ms-Panel');
      const isOpen = panel && panel.classList.contains('is-open');

      // Directly look for "Manually trigger a flow" text anywhere
      const allText = document.body.innerText;
      const hasManual = allText.includes('Manually trigger a flow');

      return {
        panelOpen: isOpen,
        hasSearch: !!searchInput,
        hasManualTrigger: hasManual,
      };
    })()
  `
})
console.log("Panel:", JSON.stringify(panelState))

if (!panelState.hasManualTrigger) {
  console.log("'Manually trigger a flow' not visible. Searching for it...")
  await relay.command("eval", {
    expression: `
      (() => {
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (!input) return 'no input';
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'Manually trigger');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'searched';
      })()
    `
  })
  await new Promise(r => setTimeout(r, 2500))
}

// Step 3: Find and click the exact "Manually trigger a flow" element
console.log("Step 3: Finding and clicking trigger...")
const clickResult = await relay.command("eval", {
  expression: `
    (() => {
      // Walk ALL elements looking for one that says "Manually trigger a flow"
      const all = document.querySelectorAll('*');
      const candidates = [];
      for (const el of all) {
        // Check direct text content (not nested)
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .join('');

        const fullText = (el.textContent || '').trim();

        if (ownText.includes('Manually trigger a flow') || (fullText === 'Manually trigger a flow')) {
          const rect = el.getBoundingClientRect();
          candidates.push({
            tag: el.tagName.toLowerCase(),
            text: fullText.slice(0, 60),
            ownText: ownText.slice(0, 60),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            clickable: el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tabIndex >= 0 || getComputedStyle(el).cursor === 'pointer',
            className: (el.className || '').toString().slice(0, 60),
          });
        }
      }

      // Sort by specificity — prefer smaller, clickable elements
      candidates.sort((a, b) => (a.w * a.h) - (b.w * b.h));

      if (candidates.length === 0) return { found: false };

      // Click the most specific (smallest) clickable candidate
      const target = candidates.find(c => c.clickable) || candidates[0];
      const el = document.elementFromPoint(target.x + target.w / 2, target.y + target.h / 2);
      if (el) el.click();

      return {
        found: true,
        clicked: target,
        allCandidates: candidates.slice(0, 5),
      };
    })()
  `
})
console.log("Click result:", JSON.stringify(clickResult, null, 2))

await new Promise(r => setTimeout(r, 4000))

// Step 4: Verify trigger was placed
console.log("\nStep 4: Verifying trigger placement...")
const verify = await relay.command("eval", {
  expression: `
    (() => {
      const canvas = document.querySelector('[aria-label="Workflow canvas"]');
      const text = canvas ? canvas.textContent.replace(/\\s+/g, ' ').slice(0, 500) : '';

      // Check for the "+" button or "Add an action" that appears after a trigger is placed
      const allButtons = document.querySelectorAll('button, [role="button"]');
      const relevant = [];
      for (const btn of allButtons) {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').trim();
        if (label.includes('action') || label.includes('step') || label.includes('+') || label.includes('Insert')) {
          relevant.push(label.slice(0, 60));
        }
      }

      return {
        triggerPlaced: text.includes('Manually trigger a flow') && !text.startsWith('Add a trigger'),
        canvasText: text.slice(0, 300),
        actionButtons: relevant,
      };
    })()
  `
})
console.log(JSON.stringify(verify, null, 2))

if (verify.triggerPlaced) {
  console.log("\n✓ TRIGGER PLACED! Now ready to add actions.")
} else {
  console.log("\n✗ Trigger not yet placed. The canvas still shows:", verify.canvasText?.slice(0, 100))
}

relay.close()

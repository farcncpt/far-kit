#!/usr/bin/env node
/** Add a manual trigger to the Power Automate flow, then open the actions panel */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-trigger" })

const page = await relay.command("page")
console.log(`Page: ${page.title}\n`)

// Step 1: Make sure trigger panel is open
console.log("=== Step 1: Opening trigger panel ===")
await relay.command("eval", {
  expression: `
    (() => {
      const btn = document.querySelector('[aria-label="Add a trigger"]');
      if (btn) { btn.click(); return 'clicked Add a trigger'; }
      return 'not found';
    })()
  `
})
await new Promise(r => setTimeout(r, 2000))

// Step 2: Search for "Manually trigger a flow" in the panel search
console.log("=== Step 2: Searching for 'Manually trigger a flow' ===")
await relay.command("eval", {
  expression: `
    (() => {
      const input = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (!input) return 'no panel search';
      input.focus();
      input.click();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, 'Manually trigger');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'typed: Manually trigger';
    })()
  `
})
await new Promise(r => setTimeout(r, 2500))

// Step 3: Find and click "Manually trigger a flow"
console.log("=== Step 3: Clicking 'Manually trigger a flow' ===")
const clickResult = await relay.command("eval", {
  expression: `
    (() => {
      const panel = document.querySelector('.ms-Panel-content, .ms-Panel-scrollableContent');
      if (!panel) return { error: 'no panel' };

      // Find all clickable elements in the panel
      const els = panel.querySelectorAll('button, [role="option"], [role="button"], div[tabindex="0"]');
      for (const el of els) {
        const text = (el.textContent || '').trim();
        if (text.includes('Manually trigger a flow') && !text.includes('See more')) {
          el.click();
          return { clicked: true, text: text.slice(0, 60) };
        }
      }

      // Also try finding by aria-label
      const byLabel = panel.querySelector('[aria-label*="Manually trigger"]');
      if (byLabel) {
        byLabel.click();
        return { clicked: true, method: 'aria-label' };
      }

      // List what IS there so we can debug
      const visible = [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 15) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        if (text.length > 3 && text.length < 100) visible.push(text);
      }
      return { clicked: false, visibleItems: visible.slice(0, 15) };
    })()
  `
})
console.log("Click result:", JSON.stringify(clickResult, null, 2))

await new Promise(r => setTimeout(r, 3000))

// Step 4: Check if trigger was added — look for the "+" button to add actions
console.log("\n=== Step 4: Checking if trigger was added ===")
const afterTrigger = await relay.command("eval", {
  expression: `
    (() => {
      // Look for indicators that a trigger was placed
      const addAction = document.querySelector('[aria-label*="add action"], [aria-label*="Add an action"], button[class*="add"]');
      const plusButton = document.querySelector('[aria-label*="Insert a new step"]');
      const triggerNode = document.querySelector('[data-automation-id*="trigger"], [aria-label*="Manually trigger"]');

      // Also scan the workflow canvas for any nodes
      const canvas = document.querySelector('[aria-label="Workflow canvas"]');
      let canvasText = '';
      if (canvas) canvasText = canvas.textContent.trim().replace(/\\s+/g, ' ').slice(0, 300);

      return {
        hasAddAction: !!addAction,
        addActionLabel: addAction?.getAttribute('aria-label') || addAction?.textContent?.trim()?.slice(0, 50),
        hasPlusButton: !!plusButton,
        hasTriggerNode: !!triggerNode,
        triggerNodeText: triggerNode?.textContent?.trim()?.slice(0, 50),
        canvasPreview: canvasText,
        url: location.href,
      };
    })()
  `
})
console.log(JSON.stringify(afterTrigger, null, 2))

// Step 5: If trigger was added, try to find the "+" or "Add an action" button
if (afterTrigger.hasAddAction || afterTrigger.hasPlusButton || afterTrigger.canvasPreview.includes('action')) {
  console.log("\n=== Step 5: Opening actions panel ===")

  const openActions = await relay.command("eval", {
    expression: `
      (() => {
        // Try various ways to open the action panel
        const addAction = document.querySelector('[aria-label*="Insert a new step"]');
        if (addAction) { addAction.click(); return { clicked: 'Insert a new step' }; }

        const plus = document.querySelector('[aria-label*="add action"], [aria-label*="Add an action"]');
        if (plus) { plus.click(); return { clicked: plus.getAttribute('aria-label') }; }

        // Try finding a "+" icon button
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const label = btn.getAttribute('aria-label') || btn.textContent.trim();
          if (label.includes('+') || label.includes('Add') || label.includes('Insert') || label.includes('new step')) {
            btn.click();
            return { clicked: label.slice(0, 50) };
          }
        }

        return { clicked: false };
      })()
    `
  })
  console.log("Actions panel:", JSON.stringify(openActions))

  await new Promise(r => setTimeout(r, 2000))

  // Step 6: Now scan the actions panel
  console.log("\n=== Step 6: Scanning actions panel ===")
  const actionsPanel = await relay.command("eval", {
    expression: `
      (() => {
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        const panel = document.querySelector('.ms-Panel-content');
        if (!panel) return { hasPanel: false };

        const items = [];
        const seen = new Set();
        const els = panel.querySelectorAll('button, [role="option"], [role="listitem"], div[tabindex="0"]');
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 15 || rect.width > 600) continue;
          const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
          if (!text || seen.has(text) || text.length < 3) continue;
          if (['All', 'Built-in', 'Standard', 'Premium', 'Custom', 'Favorites', 'Filter', 'Close panel', 'Close'].includes(text)) continue;
          seen.add(text);
          items.push({ text, y: Math.round(rect.y) });
        }
        items.sort((a, b) => a.y - b.y);

        return {
          hasPanel: true,
          hasSearch: !!input,
          searchPlaceholder: input?.placeholder,
          itemCount: items.length,
          items: items.slice(0, 30),
        };
      })()
    `
  })
  console.log(`Panel: ${actionsPanel.itemCount} items, search: ${actionsPanel.hasSearch}`)
  if (actionsPanel.items) {
    for (const item of actionsPanel.items) {
      console.log(`  ${item.text}`)
    }
  }
}

relay.close()
console.log("\nDone!")

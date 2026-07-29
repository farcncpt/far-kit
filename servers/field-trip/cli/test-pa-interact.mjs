#!/usr/bin/env node
/** Interact with Power Automate flow editor */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-interact" })

const page = await relay.command("page")
console.log(`Page: ${page.title} — ${page.url}\n`)

// Click "Add a trigger" using eval (the button has role="button" on a div)
console.log("=== Clicking 'Add a trigger' ===")
const clickResult = await relay.command("eval", {
  expression: `
    (() => {
      const trigger = document.querySelector('[aria-label="Add a trigger"]');
      if (!trigger) {
        // Try finding by text
        const divs = document.querySelectorAll('div[role="button"]');
        for (const d of divs) {
          if (d.textContent.includes('Add a trigger')) {
            d.click();
            return { clicked: true, method: 'text-match', text: d.textContent.trim().slice(0, 50) };
          }
        }
        return { clicked: false, error: 'not found' };
      }
      trigger.click();
      return { clicked: true, method: 'aria-label' };
    })()
  `
})
console.log(JSON.stringify(clickResult))

await new Promise(r => setTimeout(r, 3000))

// Scan what appeared after clicking
console.log("\n=== TRIGGER SELECTION PANEL ===\n")
const triggerPanel = await relay.command("eval", {
  expression: `
    (() => {
      // Look for the trigger selection panel
      const panels = document.querySelectorAll('[role="dialog"], [role="complementary"], .ms-Panel, [class*="panel"], [class*="Panel"]');
      const results = [];

      // Find all visible interactive elements
      const els = document.querySelectorAll('button, a, input, [role="button"], [role="option"], [role="listitem"], [role="tab"]');
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text && !el.getAttribute('aria-label')) continue;
        // Only show new elements (y > 0 and likely in the panel area)
        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          role: el.getAttribute('role') || undefined,
          y: Math.round(rect.y),
        });
      }

      results.sort((a, b) => a.y - b.y);

      // Also look for trigger categories/connectors
      const connectors = document.querySelectorAll('[class*="connector"], [class*="trigger"], [data-automation-id*="trigger"]');

      return {
        panelCount: panels.length,
        elements: results.slice(0, 40),
        connectorElements: connectors.length,
      };
    })()
  `
})

if (triggerPanel?.elements) {
  console.log(`Found ${triggerPanel.elements.length} elements:\n`)
  for (const el of triggerPanel.elements) {
    const parts = [`<${el.tag}>`]
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
    if (el.role) parts.push(`role="${el.role}"`)
    if (el.text) parts.push(`"${el.text.slice(0, 70)}"`)
    console.log(`  ${parts.join(' ')}`)
  }
}

// Check for the MsFlowSdk API
console.log("\n=== MsFlowSdk API ===\n")
const sdkInfo = await relay.command("eval", {
  expression: `
    (() => {
      if (typeof window.MsFlowSdk !== 'function' && typeof window.MsFlowSdk !== 'object') {
        return { available: false };
      }
      const sdk = typeof window.MsFlowSdk === 'function' ? new window.MsFlowSdk() : window.MsFlowSdk;
      const keys = Object.keys(sdk || {});
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(sdk) || {});
      return {
        available: true,
        type: typeof window.MsFlowSdk,
        instanceKeys: keys.slice(0, 20),
        protoMethods: proto.filter(m => m !== 'constructor').slice(0, 20),
      };
    })()
  `
})
console.log(JSON.stringify(sdkInfo, null, 2))

relay.close()
console.log("\nDone!")

#!/usr/bin/env node
/**
 * Deep catalog — searches Power Automate, clicks "See all" to expand results,
 * then reads every available trigger/action for each connector.
 */
import { connectRelay } from "./relay-client.mjs"
import { writeFileSync, mkdirSync } from "fs"

const relay = await connectRelay({ port: 9333, name: "pa-deep" })

console.log("Connected.\n")

const targetConnectors = [
  "SharePoint",
  "Excel Online",
  "OneDrive for Business",
  "Compose",
  "Condition",
  "Apply to each",
  "HTTP",
  "Variable",
  "Switch",
  "Do until",
  "Scope",
  "Terminate",
  "Filter array",
  "Select",
  "Parse JSON",
  "Outlook",
]

const catalog = {
  platform: "Microsoft Power Automate",
  catalogedAt: new Date().toISOString(),
  connectors: {},
}

async function searchConnector(term) {
  // Type search term
  await relay.command("eval", {
    expression: `
      (() => {
        const input = document.querySelector('input[aria-label*="Search"]');
        if (!input) return { error: 'no input' };
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(input, ${JSON.stringify(term)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true };
      })()
    `
  })

  await new Promise(r => setTimeout(r, 2500))

  // First, dump ALL visible text in the panel to understand the structure
  const panelDump = await relay.command("eval", {
    expression: `
      (() => {
        // Get all text content visible in the connector panel area
        const allEls = document.querySelectorAll('*');
        const items = [];
        const seen = new Set();

        for (const el of allEls) {
          // Only leaf-ish elements with direct text
          if (el.children.length > 3) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join(' ').trim();

          const fullText = (el.textContent || '').trim().replace(/\\s+/g, ' ');

          // We want items in the right side panel (x > 300 typically) and below the toolbar
          if (rect.x < 250 && rect.y < 400) continue;

          const text = ownText || (fullText.length < 80 ? fullText : '');
          if (!text || seen.has(text) || text.length < 2) continue;
          seen.add(text);

          items.push({
            text,
            tag: el.tagName.toLowerCase(),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            clickable: ['A','BUTTON'].includes(el.tagName) || el.getAttribute('role') === 'button' || getComputedStyle(el).cursor === 'pointer',
            ariaLabel: el.getAttribute('aria-label') || undefined,
          });
        }

        items.sort((a, b) => a.y - b.y);
        return items.slice(0, 40);
      })()
    `
  })

  return panelDump
}

// Ensure trigger panel is open
await relay.command("eval", {
  expression: `
    (() => {
      const trigger = document.querySelector('[aria-label="Add a trigger"]');
      if (trigger) { trigger.click(); return { clicked: true }; }
      return { clicked: false };
    })()
  `
})
await new Promise(r => setTimeout(r, 2000))

// Catalog each connector
for (const connector of targetConnectors) {
  console.log(`\n=== ${connector} ===`)

  const results = await searchConnector(connector)

  if (Array.isArray(results) && results.length > 0) {
    // Filter out UI chrome, keep actual connector items
    const connectorItems = results.filter(r =>
      !['All', 'Built-in', 'Standard', 'Premium', 'Custom', 'Favorites',
        'Filter', 'Close panel', 'Close', 'Next', 'Like', 'Dislike',
        'Got it', 'Test this flow', 'Submit'].includes(r.text) &&
      !r.text.startsWith('Make sure AI') &&
      !r.text.startsWith('Welcome back') &&
      r.text.length > 2 && r.text.length < 100
    )

    catalog.connectors[connector] = connectorItems.map(r => ({
      name: r.text,
      clickable: r.clickable,
    }))

    for (const r of connectorItems) {
      const marker = r.clickable ? '>>>' : '   '
      console.log(`  ${marker} ${r.text}`)
    }
    console.log(`  (${connectorItems.length} items)`)
  } else {
    console.log(`  No results`)
    catalog.connectors[connector] = []
  }

  await new Promise(r => setTimeout(r, 300))
}

// Save
try { mkdirSync("cli/catalogs", { recursive: true }) } catch {}
writeFileSync("cli/catalogs/power-automate-deep.json", JSON.stringify(catalog, null, 2))
console.log("\nSaved to cli/catalogs/power-automate-deep.json")

relay.close()

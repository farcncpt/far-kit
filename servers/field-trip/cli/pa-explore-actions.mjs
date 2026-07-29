#!/usr/bin/env node
/**
 * Systematically explore Power Automate's action panel structure.
 * Opens the actions panel, reads all categories, then searches key connectors.
 */
import { connectRelay } from "./relay-client.mjs"
import { writeFileSync, mkdirSync } from "fs"

const relay = await connectRelay({ port: 9333, name: "pa-explore" })
console.log("Connected.\n")

const catalog = {
  platform: "Microsoft Power Automate",
  catalogedAt: new Date().toISOString(),
  trigger: "Manually trigger a flow",
  panelStructure: {},
  connectors: {},
}

// Step 1: Click "+" to open the actions panel
console.log("=== Step 1: Opening actions panel ===\n")
const openResult = await relay.command("eval", {
  expression: `
    (() => {
      // Find the "Insert a new action" button
      const btn = document.querySelector('[aria-label*="Insert a new action"]');
      if (btn) { btn.click(); return { clicked: true, label: btn.getAttribute('aria-label') }; }
      return { clicked: false };
    })()
  `
})
console.log("Open result:", JSON.stringify(openResult))
await new Promise(r => setTimeout(r, 3000))

// Step 2: Read the full panel structure
console.log("\n=== Step 2: Full panel structure ===\n")
const panelStructure = await relay.command("eval", {
  expression: `
    (() => {
      const panel = document.querySelector('.ms-Panel-content, .ms-Panel-scrollableContent');
      if (!panel) return { error: 'no panel found' };

      // Get the search input
      const search = document.querySelector('input[aria-label="Search for an action or connector"]');

      // Get filter tabs
      const tabs = [];
      const tabEls = document.querySelectorAll('[id*="InteractionTag"], [role="tab"]');
      for (const t of tabEls) {
        const text = t.textContent.trim();
        const aria = t.getAttribute('aria-label') || '';
        if (text && text.length < 30) tabs.push({ text, aria, selected: t.getAttribute('aria-selected') === 'true' });
      }

      // Get ALL visible items in the panel with their full structure
      const items = [];
      const seen = new Set();

      // Walk through all elements in the panel
      const panelEls = panel.querySelectorAll('*');
      for (const el of panelEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 15 || rect.width > 600) continue;

        // Get own text (not nested children)
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .filter(t => t.length > 0)
          .join(' ');

        if (!ownText || seen.has(ownText) || ownText.length < 2 || ownText.length > 120) continue;
        seen.add(ownText);

        const isConnector = el.closest('[class*="connector"], [class*="Connector"], [data-is-focusable]');
        const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tabIndex >= 0;
        const img = el.querySelector('img') || el.previousElementSibling?.querySelector('img');

        items.push({
          text: ownText,
          tag: el.tagName.toLowerCase(),
          y: Math.round(rect.y),
          h: Math.round(rect.height),
          isButton,
          hasIcon: !!img,
          className: (el.className || '').toString().slice(0, 40),
        });
      }

      items.sort((a, b) => a.y - b.y);

      return {
        hasSearch: !!search,
        searchPlaceholder: search?.placeholder,
        tabs,
        itemCount: items.length,
        items: items.slice(0, 50),
      };
    })()
  `
})

console.log(`Search: ${panelStructure.hasSearch}`)
console.log(`Tabs: ${panelStructure.tabs?.map(t => t.text).join(', ')}`)
console.log(`\nPanel items (${panelStructure.itemCount}):\n`)

let currentSection = ''
for (const item of (panelStructure.items || [])) {
  // Detect section headers vs action items
  if (item.hasIcon && item.text.length > 3) {
    console.log(`\n  📦 ${item.text}`)
  } else if (item.isButton && item.text !== 'See more') {
    console.log(`    → ${item.text}`)
  } else if (item.text === 'See more') {
    console.log(`    [See more...]`)
  } else {
    console.log(`    ${item.text}`)
  }
}

catalog.panelStructure = panelStructure

// Step 3: Search for each key connector and read its actions
console.log("\n\n=== Step 3: Cataloging key connectors ===\n")

const connectors = [
  "SharePoint",
  "Excel Online",
  "OneDrive for Business",
  "Office 365 Outlook",
  "Microsoft Teams",
  "Approvals",
  "Compose",
  "Condition",
  "Apply to each",
  "Variable",
  "Switch",
  "HTTP",
  "Parse JSON",
  "Filter array",
  "Select",
  "Scope",
  "Terminate",
  "Do until",
  "Delay",
]

async function searchAndCatalog(term) {
  // Clear and type
  await relay.command("eval", {
    expression: `
      (() => {
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (!input) return 'no input';
        input.focus();
        input.click();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(input, ${JSON.stringify(term)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
      })()
    `
  })

  await new Promise(r => setTimeout(r, 2500))

  // Read results — focus on items with own text content
  const results = await relay.command("eval", {
    expression: `
      (() => {
        const panel = document.querySelector('.ms-Panel-content');
        if (!panel) return [];

        const items = [];
        const seen = new Set();

        const els = panel.querySelectorAll('*');
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 40 || rect.height < 10 || rect.width > 600) continue;

          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .filter(t => t.length > 0)
            .join(' ');

          if (!ownText || seen.has(ownText) || ownText.length < 3 || ownText.length > 120) continue;
          // Skip UI chrome
          if (['All', 'Built-in', 'Standard', 'Premium', 'Custom', 'See more',
               'Filter', 'Close panel', 'Close', 'Favorites', 'By connector',
               'Sort results', 'Ungroup actions'].includes(ownText)) continue;
          if (ownText.includes('suggestions available')) continue;
          seen.add(ownText);

          const img = el.querySelector('img') || el.closest('[class*="item"]')?.querySelector('img');
          const isAction = rect.h > 15 && rect.h < 50;
          const isConnectorHeader = !!img && rect.h >= 20;

          items.push({
            text: ownText,
            isConnector: isConnectorHeader,
            isAction,
            y: Math.round(rect.y),
          });
        }

        items.sort((a, b) => a.y - b.y);
        return items.slice(0, 40);
      })()
    `
  })

  return results
}

for (const connector of connectors) {
  console.log(`\n--- ${connector} ---`)
  const results = await searchAndCatalog(connector)

  if (Array.isArray(results) && results.length > 0) {
    const actions = results.filter(r =>
      !['Add a trigger', 'Add an action'].includes(r.text) &&
      r.text.length > 3
    )

    catalog.connectors[connector] = actions.map(r => r.text)

    for (const r of actions) {
      const prefix = r.isConnector ? '📦' : '  →'
      console.log(`  ${prefix} ${r.text}`)
    }
  } else {
    console.log("  (no results)")
    catalog.connectors[connector] = []
  }

  await new Promise(r => setTimeout(r, 300))
}

// Clear search
await relay.command("eval", {
  expression: `
    (() => {
      const input = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `
})

// Save catalog
try { mkdirSync("cli/catalogs", { recursive: true }) } catch {}
writeFileSync("cli/catalogs/power-automate-actions.json", JSON.stringify(catalog, null, 2))

const totalActions = Object.values(catalog.connectors).reduce((sum, items) => sum + items.length, 0)
console.log(`\n\nCatalog saved: cli/catalogs/power-automate-actions.json`)
console.log(`Total: ${Object.keys(catalog.connectors).length} connectors, ${totalActions} actions`)

relay.close()

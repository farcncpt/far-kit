#!/usr/bin/env node
/**
 * Catalog Power Automate using the CORRECT panel search input.
 * The panel search is: aria="Search for an action or connector"
 */
import { connectRelay } from "./relay-client.mjs"
import { writeFileSync, mkdirSync } from "fs"

const relay = await connectRelay({ port: 9333, name: "pa-panel-catalog" })

const page = await relay.command("page")
console.log(`Page: ${page.title}\n`)

const targetConnectors = [
  "SharePoint",
  "Excel Online (Business)",
  "OneDrive for Business",
  "Compose",
  "Condition",
  "Apply to each",
  "HTTP",
  "Initialize variable",
  "Set variable",
  "Switch",
  "Do until",
  "Scope",
  "Terminate",
  "Filter array",
  "Select",
  "Parse JSON",
  "Office 365 Outlook",
  "Microsoft Teams",
  "Approval",
  "Send an HTTP request",
]

const catalog = {
  platform: "Microsoft Power Automate",
  catalogedAt: new Date().toISOString(),
  connectors: {},
}

async function searchInPanel(term) {
  // Use the PANEL search input, not the top bar
  const typed = await relay.command("eval", {
    expression: `
      (() => {
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (!input) return { error: 'Panel search input not found' };
        input.focus();
        input.click();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(input, ${JSON.stringify(term)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, value: input.value };
      })()
    `
  })

  if (typed?.error) {
    console.log(`  Search error: ${typed.error}`)
    return []
  }

  await new Promise(r => setTimeout(r, 2500))

  // Read results from the PANEL (ms-Panel content area)
  const results = await relay.command("eval", {
    expression: `
      (() => {
        // Target the panel content area specifically
        const panel = document.querySelector('.ms-Panel-content, .ms-Panel-scrollableContent');
        if (!panel) return [];

        const items = [];
        const seen = new Set();

        // Find clickable items within the panel
        const els = panel.querySelectorAll('button, [role="option"], [role="listitem"], [role="button"], div[tabindex="0"]');
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 50 || rect.height < 20) continue;
          if (rect.width > 600) continue; // Skip the panel container itself

          const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
          if (!text || seen.has(text) || text.length < 3) continue;

          // Skip UI chrome
          if (['All', 'Built-in', 'Standard', 'Premium', 'Custom', 'Favorites',
               'See all', 'Close panel', 'Close', 'Filter', 'By connector',
               'Show more results'].includes(text.trim())) continue;
          if (text.includes('suggestions available')) continue;

          seen.add(text);

          const ariaLabel = el.getAttribute('aria-label') || '';
          const dataAutomationId = el.getAttribute('data-automation-id') || '';
          const img = el.querySelector('img');

          items.push({
            name: text,
            ariaLabel: ariaLabel || undefined,
            automationId: dataAutomationId || undefined,
            hasIcon: !!img,
            iconSrc: img?.src?.split('/').pop()?.split('?')[0] || undefined,
            y: Math.round(rect.y),
            h: Math.round(rect.height),
          });
        }

        items.sort((a, b) => a.y - b.y);
        return items.slice(0, 30);
      })()
    `
  })

  return results
}

// Ensure panel is open
console.log("Opening trigger/action panel...")
await relay.command("eval", {
  expression: `
    (() => {
      const trigger = document.querySelector('[aria-label="Add a trigger"]');
      if (trigger) { trigger.click(); return 'clicked'; }
      return 'not found';
    })()
  `
})
await new Promise(r => setTimeout(r, 2000))

// Catalog each connector
for (const connector of targetConnectors) {
  console.log(`\n=== ${connector} ===`)

  const results = await searchInPanel(connector)

  if (Array.isArray(results) && results.length > 0) {
    catalog.connectors[connector] = results.map(r => ({
      name: r.name,
      automationId: r.automationId,
      hasIcon: r.hasIcon,
    }))

    for (const r of results) {
      const icon = r.hasIcon ? '📦' : '  '
      console.log(`  ${icon} ${r.name}`)
    }
    console.log(`  (${results.length} results)`)
  } else {
    console.log(`  No results found`)
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

// Save
try { mkdirSync("cli/catalogs", { recursive: true }) } catch {}
const outputPath = "cli/catalogs/power-automate-panel-catalog.json"
writeFileSync(outputPath, JSON.stringify(catalog, null, 2))
console.log(`\nCatalog saved: ${outputPath}`)

const totalItems = Object.values(catalog.connectors).reduce((sum, items) => sum + items.length, 0)
console.log(`Total: ${Object.keys(catalog.connectors).length} connectors, ${totalItems} items cataloged`)

relay.close()

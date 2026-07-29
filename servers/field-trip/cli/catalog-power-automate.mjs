#!/usr/bin/env node
/**
 * Catalog Power Automate's connectors, triggers, and actions.
 * Navigates the UI to discover everything available.
 */
import { connectRelay } from "./relay-client.mjs"
import { writeFileSync } from "fs"

const relay = await connectRelay({ port: 9333, name: "pa-catalog" })

const page = await relay.command("page")
console.log(`Page: ${page.title}`)
console.log(`URL: ${page.url}\n`)

const catalog = {
  platform: "Microsoft Power Automate",
  catalogedAt: new Date().toISOString(),
  url: page.url,
  categories: {},
  connectors: [],
  triggers: [],
}

// Step 1: Read the filter categories
console.log("=== STEP 1: Reading filter categories ===\n")
const categories = await relay.command("eval", {
  expression: `
    (() => {
      // Find the category tabs/buttons
      const tabs = document.querySelectorAll('button[aria-label], [role="tab"]');
      const categories = [];
      for (const tab of tabs) {
        const label = tab.getAttribute('aria-label') || tab.textContent.trim();
        if (['All', 'Built-in', 'Standard', 'Premium', 'Custom', 'Favorites'].includes(label)) {
          categories.push({
            label,
            selected: tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('is-selected'),
          });
        }
      }
      return categories;
    })()
  `
})

console.log("Categories:", JSON.stringify(categories))
catalog.categories = categories

// Step 2: Click "All" to see all connectors and read them
console.log("\n=== STEP 2: Listing all connectors ===\n")

// Click "All" tab
await relay.command("eval", {
  expression: `
    (() => {
      const tabs = document.querySelectorAll('button');
      for (const tab of tabs) {
        if (tab.getAttribute('aria-label') === 'All' || tab.textContent.trim() === 'All') {
          tab.click();
          return { clicked: true };
        }
      }
      return { clicked: false };
    })()
  `
})

await new Promise(r => setTimeout(r, 2000))

// Read connector list
const connectors = await relay.command("eval", {
  expression: `
    (() => {
      // Find all connector/trigger items in the panel
      const items = document.querySelectorAll('[class*="connector"], [class*="Connector"], [data-automation-id], [role="option"], [role="listitem"]');
      const results = [];
      const seen = new Set();

      for (const item of items) {
        const text = (item.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text || seen.has(text) || text.length < 3) continue;
        seen.add(text);

        const ariaLabel = item.getAttribute('aria-label') || '';
        const img = item.querySelector('img');
        const icon = img ? img.src?.slice(0, 100) : undefined;

        results.push({
          name: ariaLabel || text,
          text: text.slice(0, 80),
          icon,
          tag: item.tagName.toLowerCase(),
          role: item.getAttribute('role'),
        });
      }

      // Also try getting items from the visible list area
      const listItems = document.querySelectorAll('button[class*="item"], button[class*="Item"], div[class*="card"], div[class*="Card"]');
      for (const item of listItems) {
        const text = (item.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text || seen.has(text) || text.length < 3 || text.length > 100) continue;
        seen.add(text);
        results.push({
          name: text.slice(0, 80),
          tag: item.tagName.toLowerCase(),
        });
      }

      return results.slice(0, 50);
    })()
  `
})

console.log(`Found ${connectors?.length || 0} items:`)
if (Array.isArray(connectors)) {
  for (const c of connectors) {
    console.log(`  ${c.name}`)
  }
  catalog.connectors = connectors
}

// Step 3: Click "Built-in tools" to see built-in actions
console.log("\n=== STEP 3: Built-in tools ===\n")

await relay.command("eval", {
  expression: `
    (() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim().includes('Built-in tools') || btn.textContent.trim() === 'Built-in') {
          btn.click();
          return { clicked: true };
        }
      }
      return { clicked: false };
    })()
  `
})

await new Promise(r => setTimeout(r, 2000))

const builtIns = await relay.command("eval", {
  expression: `
    (() => {
      const results = [];
      const seen = new Set();
      // Get all visible button/div items in the panel
      const els = document.querySelectorAll('[role="option"], [role="listitem"], button, [class*="item"], [class*="connector"]');
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Only items in the panel area (not toolbar)
        if (rect.y < 200) continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text || seen.has(text) || text.length < 3 || text.length > 100) continue;
        seen.add(text);

        results.push({
          name: text,
          y: Math.round(rect.y),
        });
      }
      results.sort((a, b) => a.y - b.y);
      return results.slice(0, 30);
    })()
  `
})

console.log(`Found ${builtIns?.length || 0} built-in items:`)
if (Array.isArray(builtIns)) {
  for (const b of builtIns) {
    console.log(`  ${b.name}`)
  }
  catalog.builtInTools = builtIns
}

// Step 4: Search for common connectors
console.log("\n=== STEP 4: Searching for common connectors ===\n")

const searchTerms = ["SharePoint", "Outlook", "Teams", "Excel", "OneDrive", "Approval", "HTTP", "Schedule"]
const searchResults = {}

for (const term of searchTerms) {
  // Type in search
  await relay.command("eval", {
    expression: `
      (() => {
        const input = document.querySelector('input[aria-label*="Search"]');
        if (!input) return { error: 'no search input' };

        // Clear and type using native setter
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

  await new Promise(r => setTimeout(r, 1500))

  // Read results
  const results = await relay.command("eval", {
    expression: `
      (() => {
        const items = [];
        const seen = new Set();
        const els = document.querySelectorAll('[role="option"], [role="listitem"], button, [class*="item"]');
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0 || rect.y < 200) continue;
          const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
          if (!text || seen.has(text) || text.length < 3 || text.length > 80) continue;
          seen.add(text);
          items.push(text);
        }
        return items.slice(0, 10);
      })()
    `
  })

  if (Array.isArray(results) && results.length > 0) {
    console.log(`  "${term}" → ${results.length} results: ${results.slice(0, 3).join(', ')}`)
    searchResults[term] = results
  } else {
    console.log(`  "${term}" → no results`)
  }
}

catalog.searchResults = searchResults

// Clear search
await relay.command("eval", {
  expression: `
    (() => {
      const input = document.querySelector('input[aria-label*="Search"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `
})

// Save catalog
const outputPath = "cli/catalogs/power-automate-catalog.json"
try {
  const { mkdirSync } = await import("fs")
  mkdirSync("cli/catalogs", { recursive: true })
} catch {}
writeFileSync(outputPath, JSON.stringify(catalog, null, 2))
console.log(`\nCatalog saved to: ${outputPath}`)

relay.close()
console.log("Done!")

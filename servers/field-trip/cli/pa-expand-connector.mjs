#!/usr/bin/env node
/**
 * Expand each connector's "See more" to get the COMPLETE list of actions.
 * Focuses on non-premium connectors needed for work.
 */
import { connectRelay } from "./relay-client.mjs"
import { writeFileSync, mkdirSync } from "fs"

const relay = await connectRelay({ port: 9333, name: "pa-expand" })
console.log("Connected.\n")

const connectors = [
  "SharePoint",
  "Excel Online (Business)",
  "OneDrive for Business",
  "Office 365 Outlook",
  "Microsoft Teams",
  "Standard approvals",
  "Control",
  "Data Operation",
  "Variable",
  "Schedule",
]

const catalog = {
  platform: "Microsoft Power Automate",
  catalogedAt: new Date().toISOString(),
  fullActions: {},
}

async function expandConnector(connectorName) {
  // Search for the connector
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
        setter.call(input, ${JSON.stringify(connectorName)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'searched';
      })()
    `
  })
  await new Promise(r => setTimeout(r, 2500))

  // Find and click "See more" for this specific connector
  const seeMoreResult = await relay.command("eval", {
    expression: `
      (() => {
        const panel = document.querySelector('.ms-Panel-content');
        if (!panel) return { error: 'no panel' };

        // Find all "See more" buttons
        const seeMoreButtons = panel.querySelectorAll('button');
        for (const btn of seeMoreButtons) {
          const text = btn.textContent.trim();
          if (text === 'See more') {
            // Check if this "See more" is next to our connector name
            const parent = btn.closest('[class*="item"], [class*="group"], div');
            const parentText = parent?.textContent || '';
            if (parentText.includes(${JSON.stringify(connectorName)})) {
              btn.click();
              return { clicked: true, context: parentText.slice(0, 60) };
            }
          }
        }

        // If we can't find context-specific See more, click the first one
        for (const btn of seeMoreButtons) {
          if (btn.textContent.trim() === 'See more' && btn.getBoundingClientRect().y > 200) {
            btn.click();
            return { clicked: true, method: 'first-visible' };
          }
        }

        return { clicked: false };
      })()
    `
  })
  console.log(`  See more: ${JSON.stringify(seeMoreResult)}`)
  await new Promise(r => setTimeout(r, 2500))

  // Now read ALL actions in the expanded view
  const actions = await relay.command("eval", {
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

          // Get own text only
          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .filter(t => t.length > 0)
            .join(' ');

          if (!ownText || seen.has(ownText) || ownText.length < 3 || ownText.length > 120) continue;

          // Skip UI chrome
          if (['All', 'Built-in', 'Standard', 'Premium', 'Custom', 'See more', 'See less',
               'Filter', 'Close panel', 'Close', 'Favorites', 'By connector', 'Add an action',
               'Add a trigger', 'Sort results', 'Ungroup actions', 'Back'].includes(ownText)) continue;
          if (ownText.includes('suggestions available') || ownText.includes('Preview')) continue;

          seen.add(ownText);

          const isHeader = !!el.querySelector('img') || el.closest('[class*="header"]');

          items.push({
            text: ownText,
            isHeader,
            y: Math.round(rect.y),
          });
        }

        items.sort((a, b) => a.y - b.y);
        return items.slice(0, 60);
      })()
    `
  })

  return actions
}

for (const connector of connectors) {
  console.log(`\n========== ${connector} ==========`)

  const actions = await expandConnector(connector)

  if (Array.isArray(actions) && actions.length > 0) {
    // Separate the connector header from its actions
    const connectorActions = actions.filter(a =>
      a.text !== connector && !a.isHeader
    )

    // Also collect connector headers (other related connectors that showed up)
    const headers = actions.filter(a => a.isHeader)

    catalog.fullActions[connector] = {
      actionCount: connectorActions.length,
      actions: connectorActions.map(a => a.text),
      relatedConnectors: headers.map(h => h.text),
    }

    console.log(`  Actions (${connectorActions.length}):`)
    for (const a of connectorActions) {
      console.log(`    → ${a.text}`)
    }
    if (headers.length > 0) {
      console.log(`  Related connectors: ${headers.map(h => h.text).join(', ')}`)
    }
  } else {
    console.log("  (no results)")
    catalog.fullActions[connector] = { actionCount: 0, actions: [] }
  }

  // Go back if needed (click Back button or clear search)
  await relay.command("eval", {
    expression: `
      (() => {
        // Check if there's a Back button (when inside a connector's expanded view)
        const backBtn = document.querySelector('button[aria-label="Back"], button[class*="back"]');
        if (backBtn && backBtn.getBoundingClientRect().y > 100) {
          backBtn.click();
          return 'clicked back';
        }
        // Clear search
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 'cleared search';
        }
        return 'no action';
      })()
    `
  })
  await new Promise(r => setTimeout(r, 1500))
}

// Save
try { mkdirSync("cli/catalogs", { recursive: true }) } catch {}
writeFileSync("cli/catalogs/power-automate-full-actions.json", JSON.stringify(catalog, null, 2))

const totalActions = Object.values(catalog.fullActions).reduce((sum, c) => sum + c.actionCount, 0)
console.log(`\n\nSaved: cli/catalogs/power-automate-full-actions.json`)
console.log(`Total: ${connectors.length} connectors, ${totalActions} actions`)

relay.close()

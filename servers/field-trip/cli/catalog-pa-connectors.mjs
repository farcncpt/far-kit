#!/usr/bin/env node
/**
 * Power Automate Connector Cataloger v4
 *
 * Navigates the Power Automate actions panel to catalog every action
 * for each specified connector. Uses the relay bridge to control the browser.
 */
import { connectRelay } from "./relay-client.mjs";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAB_ID = 704448024;
const TIMEOUT = 20000;

// Connectors to catalog. `search` is what to type in search, `name` is the exact display name.
const connectors = [
  { search: "SharePoint", name: "SharePoint" },
  { search: "Excel Online", name: "Excel Online (Business)" },
  { search: "OneDrive for Business", name: "OneDrive for Business" },
  { search: "Office 365 Outlook", name: "Office 365 Outlook" },
  { search: "Microsoft Teams", name: "Microsoft Teams" },
  { search: "Control", name: "Control" },
  { search: "Data Operation", name: "Data Operation" },
  { search: "Variable", name: "Variable" },
  { search: "Schedule", name: "Schedule" },
  { search: "Approvals", name: "Approvals" },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("Connecting to relay...");
  const relay = await connectRelay({ port: 9333, name: "pa-cataloger", timeout: 10000 });

  async function ev(expression, timeout = TIMEOUT) {
    return relay.command("eval", { expression }, { timeout, tabId: TAB_ID });
  }

  // Helper: close any panel
  async function closePanel() {
    return ev(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b =>
        b.getAttribute('aria-label') === 'Close panel');
      if (btn) { btn.click(); return 'closed'; }
      return 'no panel';
    })()`);
  }

  // Helper: open actions panel by clicking insert button
  async function openActionsPanel() {
    await closePanel();
    await sleep(2000);

    const result = await ev(`(() => {
      const btn = document.getElementById('msla-edge-button-manually_trigger_a_flow-undefined');
      if (btn) { btn.click(); return 'clicked insert'; }
      return 'no insert button';
    })()`);
    await sleep(4000);

    // Wait for search input to appear
    for (let i = 0; i < 5; i++) {
      const hasInput = await ev(`!!document.querySelector('input[aria-label="Search for an action or connector"]')`);
      if (hasInput) return result;
      await sleep(1000);
    }
    return result;
  }

  // Helper: type into search using InputEvent, character by character for React compat
  async function typeSearch(text) {
    // First clear the input completely
    await ev(`(() => {
      const input = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (!input) return false;
      input.focus();
      input.click();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
      return true;
    })()`);
    await sleep(500);

    // Now type the search text
    return ev(`(() => {
      const input = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (!input) return { error: 'no search input' };
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      // Use InputEvent with proper React handling
      const evt = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} });
      input.dispatchEvent(evt);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // Also dispatch keydown/keyup for React 18+
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      return { typed: true, value: input.value };
    })()`);
  }

  // Helper: wait for spinner to disappear (results loaded)
  async function waitForResults(maxWait = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const loading = await ev(`!!document.querySelector('[id*="spinner"]')`);
      if (!loading) return true;
      await sleep(1500);
    }
    return false;
  }

  // Helper: get panel text content
  async function getPanelText() {
    return ev(`(() => {
      // Search mode: has search input
      const searchInput = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (searchInput) {
        let panel = searchInput.parentElement;
        for (let i = 0; i < 10; i++) { if (panel?.parentElement) panel = panel.parentElement; }
        return { text: panel.innerText.slice(0, 10000), mode: 'search' };
      }
      // Detail mode: breadcrumb with connector name
      const navOl = document.querySelector('nav ol');
      if (navOl) {
        let panel = navOl.parentElement;
        for (let i = 0; i < 8; i++) { if (panel?.parentElement) panel = panel.parentElement; }
        return { text: panel.innerText.slice(0, 10000), mode: 'detail' };
      }
      return { error: 'no panel found' };
    })()`);
  }

  // Helper: click "See more" button within a specific connector group
  async function clickSeeMore(connectorName) {
    return ev(`(() => {
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        if (btn.textContent.trim() !== 'See more') continue;
        // Walk up to the connector group container (ms-List-cell)
        let container = btn.closest('.ms-List-cell') || btn.parentElement?.parentElement?.parentElement;
        if (container) {
          const innerText = container.innerText.trim();
          if (innerText.startsWith(${JSON.stringify(connectorName)})) {
            btn.click();
            return { clicked: true, context: innerText.slice(0, 80) };
          }
        }
      }
      // Fallback: try finding the first See more after the connector name text
      let foundConnector = false;
      const listCells = document.querySelectorAll('.ms-List-cell');
      for (const cell of listCells) {
        const text = cell.innerText.trim();
        if (text.startsWith(${JSON.stringify(connectorName)})) {
          const seeMore = cell.querySelector('button');
          if (seeMore && seeMore.textContent.trim().includes('See more')) {
            seeMore.click();
            return { clicked: true, fallback: true, context: text.slice(0, 80) };
          }
        }
      }
      return { clicked: false };
    })()`);
  }

  // Helper: navigate back to search from detail view
  async function backToSearch() {
    // Click the "Add an action" breadcrumb
    const result = await ev(`(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim() === 'Add an action') {
          btn.click();
          return 'clicked breadcrumb';
        }
      }
      return 'no breadcrumb';
    })()`);
    await sleep(1500);
    return result;
  }

  // Helper: parse actions from detail view text
  function parseActions(text, connectorName) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let startIdx = -1;

    // Find the connector name (appears twice in detail view header)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === connectorName) {
        startIdx = i + 1;
        // Skip duplicate header
        if (startIdx < lines.length && lines[startIdx] === connectorName) {
          startIdx++;
        }
        break;
      }
    }
    if (startIdx === -1) return [];

    const skip = new Set(['Add an action', 'All', 'Built-in', 'Standard', 'Premium', 'Custom',
      'See more', 'Back', 'Favorite', 'Close', 'Close panel', 'Loading more results…',
      'Sort results', 'Ungroup actions', 'Scroll to top']);
    const actions = [];
    for (let i = startIdx; i < lines.length; i++) {
      if (skip.has(lines[i])) continue;
      if (lines[i].match(/^\d+ connector results? found$/)) continue;
      actions.push(lines[i]);
    }
    return actions;
  }

  // ====== MAIN FLOW ======
  console.log("=== Power Automate Connector Cataloger ===\n");

  const catalog = {};

  for (const { search, name } of connectors) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  CATALOGING: ${name}`);
    console.log(`${'='.repeat(60)}`);

    // Step 1: Open fresh actions panel (close any existing panel first)
    console.log("  [1] Opening actions panel...");
    const panelResult = await openActionsPanel();
    console.log(`      ${panelResult}`);

    // Verify search input exists
    const hasInput = await ev(`!!document.querySelector('input[aria-label="Search for an action or connector"]')`);
    if (!hasInput) {
      console.log("      ERROR: No search input found after opening panel");
      catalog[name] = { actions: [], actionCount: 0, error: 'panel failed to open' };
      continue;
    }

    // Step 2: Search for the connector (with retry)
    let loaded = false;
    let searchResults;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        console.log(`  [RETRY ${attempt}] Reopening panel...`);
        await openActionsPanel();
      }

      console.log(`  [2] Searching "${search}" (attempt ${attempt + 1})...`);
      await typeSearch(search);

      // Step 3: Wait for results
      console.log("  [3] Waiting for results...");
      loaded = await waitForResults(25000);
      console.log(`      Results loaded: ${loaded}`);

      searchResults = await getPanelText();
      if (searchResults.text?.includes(name)) {
        console.log(`      Found "${name}" in results.`);
        break;
      }

      if (!loaded && attempt < 2) {
        console.log(`      Results not loaded or "${name}" not found. Retrying...`);
        continue;
      }
    }

    // Step 4: Check results
    if (searchResults.error || !searchResults.text?.includes(name)) {
      console.log(`      WARNING: "${name}" not found. Panel text: ${(searchResults.text || searchResults.error || '').slice(0, 200)}`);

      // For built-in connectors (Control, Data Operation, Variable, Schedule),
      // try without "See more" - they might just show all actions directly
      if (searchResults.text?.includes(name)) {
        // Parse from search results
        const lines = searchResults.text.split('\n').map(l => l.trim()).filter(Boolean);
        const idx = lines.indexOf(name);
        if (idx >= 0) {
          const actions = [];
          for (let i = idx + 1; i < lines.length; i++) {
            if (lines[i] === 'See more') continue;
            if (i + 1 < lines.length && lines[i + 1] === 'See more') break;
            actions.push(lines[i]);
          }
          catalog[name] = { actions, actionCount: actions.length, source: 'search-preview' };
          console.log(`      Extracted ${actions.length} preview actions`);
        }
      } else {
        catalog[name] = { actions: [], actionCount: 0, error: 'not found in search' };
      }
      continue;
    }

    console.log(`  [4] Clicking See more for "${name}"...`);
    const seeMoreResult = await clickSeeMore(name);
    console.log(`      ${JSON.stringify(seeMoreResult)}`);

    if (!seeMoreResult.clicked) {
      console.log("      See more not found, extracting from search preview...");
      // Extract whatever actions are visible in the search results
      const lines = searchResults.text.split('\n').map(l => l.trim()).filter(Boolean);
      const idx = lines.indexOf(name);
      if (idx >= 0) {
        const actions = [];
        for (let i = idx + 1; i < lines.length; i++) {
          if (lines[i] === 'See more') continue;
          if (['All', 'Built-in', 'Standard', 'Premium', 'Custom'].includes(lines[i])) continue;
          if (lines[i].match(/^\d+ connector results? found$/)) continue;
          // Stop at next connector (line followed by "See more")
          if (i + 1 < lines.length && lines[i + 1] === 'See more' && lines[i] !== name) break;
          actions.push(lines[i]);
        }
        catalog[name] = { actions, actionCount: actions.length, source: 'search-preview' };
        console.log(`      Extracted ${actions.length} preview actions`);
        actions.forEach((a, i) => console.log(`        ${i + 1}. ${a}`));
      } else {
        catalog[name] = { actions: [], actionCount: 0, error: 'connector not in results' };
      }
      continue;
    }

    // Step 5: Wait for detail view to load
    await sleep(3000);

    // Step 6: Read all actions from detail view
    console.log("  [5] Reading full action list...");
    const detailData = await getPanelText();

    if (detailData.mode === 'detail') {
      const actions = parseActions(detailData.text, name);
      console.log(`      Found ${actions.length} actions:`);
      actions.forEach((a, i) => console.log(`        ${i + 1}. ${a}`));
      catalog[name] = { actions, actionCount: actions.length, source: 'detail-view' };
    } else {
      console.log(`      Still in search mode. Extracting from results...`);
      const lines = detailData.text.split('\n').map(l => l.trim()).filter(Boolean);
      const idx = lines.indexOf(name);
      const actions = [];
      if (idx >= 0) {
        for (let i = idx + 1; i < lines.length; i++) {
          if (lines[i] === 'See more') continue;
          if (i + 1 < lines.length && lines[i + 1] === 'See more' && lines[i] !== name) break;
          actions.push(lines[i]);
        }
      }
      catalog[name] = { actions, actionCount: actions.length, source: 'search-mode' };
      console.log(`      Extracted ${actions.length} actions`);
    }

    // Step 7: Navigate back
    console.log("  [6] Navigating back...");
    await backToSearch();
  }

  // Save catalog
  const outputPath = join(__dirname, "catalogs", "power-automate-complete-catalog.json");
  const output = {
    platform: "Microsoft Power Automate",
    catalogedAt: new Date().toISOString(),
    connectors: catalog,
    totalActions: Object.values(catalog).reduce((sum, c) => sum + c.actionCount, 0),
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`CATALOG SAVED: ${outputPath}`);
  console.log(`Total connectors: ${Object.keys(catalog).length}`);
  console.log(`Total actions: ${output.totalActions}`);
  for (const [name, data] of Object.entries(catalog)) {
    console.log(`  ${name}: ${data.actionCount} actions (${data.source || data.error})`);
  }
  console.log(`${'='.repeat(60)}`);

  relay.close();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

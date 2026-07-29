#!/usr/bin/env node
/**
 * Catalog remaining Power Automate connectors one at a time.
 *
 * For each connector:
 * 1. Close panel + reopen
 * 2. Search
 * 3. Wait with extended timeout
 * 4. Click See more
 * 5. Read actions
 * 6. Close the panel entirely (don't navigate back - avoid the back button bug)
 */
import { connectRelay } from "./relay-client.mjs";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAB_ID = 704448024;
const TIMEOUT = 20000;

// Only the missing connectors
const connectors = [
  { search: "Teams", name: "Microsoft Teams" },
  { search: "Control", name: "Control" },
  { search: "Variable", name: "Variable" },
  { search: "Approvals", name: "Approvals" },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const relay = await connectRelay({ port: 9333, name: "pa-remaining", timeout: 10000 });

  async function ev(expression, timeout = TIMEOUT) {
    return relay.command("eval", { expression }, { timeout, tabId: TAB_ID });
  }

  // Load existing catalog
  const catalogPath = join(__dirname, "catalogs", "power-automate-complete-catalog.json");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    catalog = { platform: "Microsoft Power Automate", connectors: {} };
  }

  async function closePanel() {
    await ev(`(() => {
      const b = [...document.querySelectorAll('button')].find(x =>
        x.getAttribute('aria-label') === 'Close panel');
      if (b) { b.click(); return 'closed'; }
      return 'none';
    })()`);
    await sleep(2000);
  }

  async function openPanel() {
    const r = await ev(`(() => {
      const btn = document.getElementById('msla-edge-button-manually_trigger_a_flow-undefined');
      if (btn) { btn.click(); return 'ok'; }
      return 'no button';
    })()`);
    // Wait for the search input to appear
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      const has = await ev(`!!document.querySelector('input[aria-label="Search for an action or connector"]')`);
      if (has) return 'panel ready';
    }
    return 'panel timeout';
  }

  async function typeAndSearch(text) {
    return ev(`(() => {
      const input = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (!input) return { error: 'no input' };
      input.focus();
      input.click();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      const evt = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} });
      input.dispatchEvent(evt);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: input.value };
    })()`);
  }

  async function waitForResults(maxWait = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const state = await ev(`(() => {
        const spinner = document.querySelector('[id*="spinner"]');
        const list = document.querySelector('.ms-List');
        const cells = document.querySelectorAll('.ms-List-cell');
        return { loading: !!spinner, hasList: !!list, cellCount: cells.length };
      })()`);
      if (!state.loading && state.cellCount > 0) return true;
      if (!state.loading && !state.hasList) {
        // Results area exists but nothing in it
        await sleep(2000);
        continue;
      }
      await sleep(2000);
    }
    return false;
  }

  async function getPanelText() {
    return ev(`(() => {
      const si = document.querySelector('input[aria-label="Search for an action or connector"]');
      if (si) {
        let p = si.parentElement;
        for (let i = 0; i < 10; i++) { if (p?.parentElement) p = p.parentElement; }
        return { text: p.innerText.slice(0, 10000), mode: 'search' };
      }
      const nav = document.querySelector('nav ol');
      if (nav) {
        let p = nav.parentElement;
        for (let i = 0; i < 8; i++) { if (p?.parentElement) p = p.parentElement; }
        return { text: p.innerText.slice(0, 10000), mode: 'detail' };
      }
      return { error: 'no panel' };
    })()`);
  }

  async function clickSeeMore(connectorName) {
    return ev(`(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if (btn.textContent.trim() !== 'See more') continue;
        const cell = btn.closest('.ms-List-cell');
        if (cell && cell.innerText.trim().startsWith(${JSON.stringify(connectorName)})) {
          btn.click();
          return { clicked: true };
        }
        // Also check parent chain
        let c = btn.parentElement;
        for (let i = 0; i < 4; i++) {
          if (c) {
            if (c.innerText.trim().startsWith(${JSON.stringify(connectorName)})) {
              btn.click();
              return { clicked: true, via: 'parent' };
            }
            c = c.parentElement;
          }
        }
      }
      return { clicked: false };
    })()`);
  }

  for (const { search, name } of connectors) {
    console.log(`\n=== ${name} ===`);

    // Close any open panel
    await closePanel();

    // Open fresh panel
    console.log("  Opening panel...");
    const panelStatus = await openPanel();
    console.log(`  Panel: ${panelStatus}`);
    if (panelStatus !== 'panel ready') {
      console.log("  SKIPPED - panel failed to open");
      continue;
    }

    // Search
    console.log(`  Searching "${search}"...`);
    await typeAndSearch(search);

    // Wait for results
    console.log("  Waiting for results...");
    const loaded = await waitForResults(30000);
    console.log(`  Loaded: ${loaded}`);

    if (!loaded) {
      console.log("  Results didn't load. Trying again...");
      await closePanel();
      await sleep(3000);
      const ps = await openPanel();
      if (ps === 'panel ready') {
        await typeAndSearch(search);
        const l2 = await waitForResults(30000);
        console.log(`  Retry loaded: ${l2}`);
        if (!l2) { console.log("  FAILED"); continue; }
      } else {
        console.log("  FAILED to reopen panel");
        continue;
      }
    }

    // Get panel text
    const results = await getPanelText();
    console.log(`  Panel text (first 200): ${results.text?.slice(0, 200)}`);

    if (!results.text?.includes(name)) {
      console.log(`  "${name}" not found in results!`);
      continue;
    }

    // Click See more
    console.log(`  Clicking See more for "${name}"...`);
    const sm = await clickSeeMore(name);
    console.log(`  See more: ${JSON.stringify(sm)}`);

    if (!sm.clicked) {
      // Extract from search preview
      const lines = results.text.split('\n').map(l => l.trim()).filter(Boolean);
      const idx = lines.indexOf(name);
      if (idx >= 0) {
        const actions = [];
        for (let i = idx + 1; i < lines.length; i++) {
          if (['See more', 'All', 'Built-in', 'Standard', 'Premium', 'Custom'].includes(lines[i])) continue;
          if (lines[i].match(/^\d+ connector results? found$/)) continue;
          // Stop at next connector
          if (i + 1 < lines.length && lines[i + 1] === 'See more' && lines[i] !== name) break;
          actions.push(lines[i]);
        }
        catalog.connectors[name] = { actions, actionCount: actions.length, source: 'search-preview' };
        console.log(`  Preview actions (${actions.length}):`);
        actions.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
      }
      continue;
    }

    // Wait for detail
    await sleep(3000);

    // Read detail
    const detail = await getPanelText();
    if (detail.mode === 'detail') {
      const lines = detail.text.split('\n').map(l => l.trim()).filter(Boolean);
      let startIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === name) {
          startIdx = i + 1;
          if (startIdx < lines.length && lines[startIdx] === name) startIdx++;
          break;
        }
      }
      const actions = [];
      if (startIdx >= 0) {
        const skip = new Set(['Add an action', 'All', 'Built-in', 'Standard', 'Premium', 'Custom',
          'See more', 'Loading more results…', 'Sort results', 'Ungroup actions', 'Scroll to top']);
        for (let i = startIdx; i < lines.length; i++) {
          if (skip.has(lines[i])) continue;
          actions.push(lines[i]);
        }
      }
      catalog.connectors[name] = { actions, actionCount: actions.length, source: 'detail-view' };
      console.log(`  Full actions (${actions.length}):`);
      actions.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
    }
  }

  // Add OneDrive for Business from our earlier manual capture
  if (!catalog.connectors["OneDrive for Business"]?.actions?.length) {
    catalog.connectors["OneDrive for Business"] = {
      actions: [
        "Create file", "List files in folder", "Convert file", "Convert file using path",
        "Copy file", "Copy file using path", "Create share link", "Create share link by path",
        "Delete file", "Extract archive to folder", "Find files in folder",
        "Find files in folder by path", "Get file content", "Get file content using path",
        "Get file metadata", "Get file metadata using path", "Get file thumbnail",
        "List files in root folder", "Move or rename a file", "Move or rename a file using path",
        "Update file", "Upload file from URL"
      ],
      actionCount: 22,
      source: "detail-view"
    };
    console.log("\n=== OneDrive for Business: Added 22 actions from earlier capture ===");
  }

  // Save
  catalog.catalogedAt = new Date().toISOString();
  catalog.totalActions = Object.values(catalog.connectors).reduce((s, c) => s + (c.actionCount || 0), 0);
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

  console.log(`\n=== SAVED ===`);
  for (const [name, data] of Object.entries(catalog.connectors)) {
    console.log(`  ${name}: ${data.actionCount} actions (${data.source || data.error})`);
  }
  console.log(`Total: ${catalog.totalActions} actions`);

  relay.close();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

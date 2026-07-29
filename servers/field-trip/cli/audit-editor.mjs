#!/usr/bin/env node
/**
 * Audit the page editor block palette and properties panel.
 */
import { connectRelay } from "./relay-client.mjs";

const tabId = parseInt(process.argv[2] || "704448023");
const relay = await connectRelay({ name: "audit-editor" });

async function evalJS(expr) {
  return await relay.command("eval", { expression: expr }, { tabId, timeout: 15000 });
}

// Count blocks in palette
const blockCategories = await evalJS(`JSON.stringify((() => {
  const categories = [];
  const palette = document.querySelector('[class*=block-palette], [data-testid*=palette]');
  // Find category headers and their block counts
  const allText = document.body.innerText;
  const catMatches = allText.match(/(LAYOUT|TYPOGRAPHY|MEDIA|INTERACTIVE|FORMS|DATA|COMMERCE|SOCIAL|NAVIGATION|ADVANCED|SECTIONS)\\s+(\\d+)/g);
  if (catMatches) {
    catMatches.forEach(m => {
      const parts = m.match(/(\\w+)\\s+(\\d+)/);
      if (parts) categories.push({ name: parts[1], count: parseInt(parts[2]) });
    });
  }
  // Count total draggable items
  const draggables = document.querySelectorAll('[draggable=true]');
  return { categories, totalDraggable: draggables.length };
})())`);
console.log("BLOCK CATEGORIES:", blockCategories);

// Get the block list items
const blockList = await evalJS(`JSON.stringify((() => {
  const items = [];
  // Look for block items in the palette sidebar
  const sidebarEl = document.querySelector('aside') || document.querySelector('[class*=sidebar]');
  if (!sidebarEl) return { error: 'no sidebar found' };
  const blockItems = sidebarEl.querySelectorAll('[draggable=true]');
  blockItems.forEach(item => {
    items.push({
      text: (item.textContent || '').trim().substring(0, 60),
      tag: item.tagName
    });
  });
  return { count: items.length, blocks: items };
})())`);
console.log("BLOCK LIST:", blockList);

// Check tree structure (canvas blocks)
const treeItems = await evalJS(`JSON.stringify((() => {
  // Look for tree/layer panel items
  const treeButtons = Array.from(document.querySelectorAll('button')).filter(b => {
    const text = b.textContent.trim();
    return text.match(/^(Section|Flex|Grid|Container|Card|Heading|Paragraph|Button|Image|Form|Nav|Header|Footer|Hero|Newsletter)/);
  });
  return treeButtons.map(b => b.textContent.trim().substring(0, 50)).slice(0, 30);
})())`);
console.log("TREE ITEMS:", treeItems);

// Check properties panel
const propsPanel = await evalJS(`JSON.stringify((() => {
  const panels = document.querySelectorAll('[class*=properties], [class*=Properties]');
  const headings = Array.from(document.querySelectorAll('h2,h3')).filter(h => h.textContent.includes('Properties') || h.textContent.includes('Style'));
  return {
    panelCount: panels.length,
    headings: headings.map(h => h.textContent.trim()),
    visible: headings.some(h => h.getBoundingClientRect().width > 0)
  };
})())`);
console.log("PROPERTIES PANEL:", propsPanel);

// Admin sidebar link issues
const sidebarIssues = await evalJS(`JSON.stringify((() => {
  const issues = [];
  // Check "MMy Site" text bug
  const siteLink = document.querySelector('a[href="/admin"]');
  if (siteLink && siteLink.textContent.includes('MMy Site')) {
    issues.push({ type: 'typo', detail: 'Site name shows "MMy Site" - double M', selector: 'a[href="/admin"]' });
  }
  // Check sidebar collapse buttons
  const collapseButtons = document.querySelectorAll('button').length;
  const iconOnlyBtns = Array.from(document.querySelectorAll('button')).filter(b => {
    const rect = b.getBoundingClientRect();
    return rect.width > 0 && !b.textContent.trim() && !b.getAttribute('aria-label') && b.querySelector('svg');
  }).length;
  issues.push({ type: 'info', detail: 'Total buttons: ' + collapseButtons + ', icon-only without aria-label: ' + iconOnlyBtns });
  return issues;
})())`);
console.log("SIDEBAR ISSUES:", sidebarIssues);

relay.close();

#!/usr/bin/env node
/**
 * Single-step helper for Power Automate panel interactions.
 * Usage: node cli/pa-step.mjs <action> [args...]
 * Actions: close-copilot, open-panel, search <term>, see-more, read-actions, back, clear, scan-panel
 */
import { connectRelay } from "./relay-client.mjs";

const TAB_ID = 704448024;
const TIMEOUT = 20000;
const action = process.argv[2];
const args = process.argv.slice(3).join(" ");

const relay = await connectRelay({ port: 9333, name: "pa-step", timeout: 10000 });

async function ev(expression) {
  return relay.command("eval", { expression }, { timeout: TIMEOUT, tabId: TAB_ID });
}

try {
  let result;
  switch (action) {
    case "close-copilot":
      result = await ev(`(() => {
        // Close the copilot/right panel
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          const label = b.getAttribute('aria-label') || '';
          if (label === 'Close panel' || label === 'Close') {
            b.click();
            return 'closed: ' + label;
          }
        }
        return 'no close button found';
      })()`);
      break;

    case "open-panel":
      result = await ev(`(() => {
        const btn = document.getElementById('msla-edge-button-manually_trigger_a_flow-undefined');
        if (btn) { btn.click(); return 'clicked insert button'; }
        return 'insert button not found';
      })()`);
      break;

    case "search":
      result = await ev(`(() => {
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (!input) {
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          return { error: 'no search input', inputs: inputs.map(i => ({
            tag: i.tagName, id: i.id, aria: i.getAttribute('aria-label') || '',
            placeholder: i.placeholder || '', type: i.type, visible: i.offsetParent !== null
          }))};
        }
        input.focus();
        input.click();
        // Use native setter for React compatibility
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(args)});
        // React 16+ uses a synthetic event system. We need to trigger the right events.
        // The key is using InputEvent instead of Event for 'input'
        const inputEvent = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(args)} });
        input.dispatchEvent(inputEvent);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { typed: true, value: input.value, aria: input.getAttribute('aria-label') };
      })()`);
      break;

    case "see-more":
      result = await ev(`(() => {
        const allEls = document.querySelectorAll('button, a, span, div');
        const candidates = [];
        for (const el of allEls) {
          const text = el.textContent.trim();
          if (text.toLowerCase().includes('see more') && text.length < 30) {
            candidates.push({ text, tag: el.tagName, classes: el.className?.slice?.(0, 60) || '' });
          }
        }
        // Click the first one
        for (const el of allEls) {
          const text = el.textContent.trim();
          if (text.toLowerCase().includes('see more') && text.length < 30) {
            el.click();
            return { clicked: true, text, total: candidates.length };
          }
        }
        return { clicked: false, candidates };
      })()`);
      break;

    case "read-actions":
      result = await ev(`(() => {
        const results = [];
        // Look for operation/action items in the panel
        // Power Automate new designer uses specific patterns
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          const label = btn.getAttribute('aria-label') || '';
          const text = btn.textContent.trim();
          // Skip chrome
          if (['Back', 'Close', 'Close panel', 'See more', 'Next', 'Previous',
               'Save', 'Test', 'Copilot', 'Undo', 'Redo', 'Like', 'Dislike',
               'Submit', 'Actions', ''].includes(text)) continue;
          if (text.length > 1 && text.length < 200) {
            results.push({ text: text.split('\\n').map(s=>s.trim()).filter(Boolean).join(' | '),
                           aria: label.slice(0, 120), id: btn.id || '' });
          }
        }
        return results;
      })()`);
      break;

    case "back":
      result = await ev(`(() => {
        const btns = document.querySelectorAll('button, a');
        for (const btn of btns) {
          const text = btn.textContent.trim();
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (text === 'Back' || label === 'back' || label.includes('go back')) {
            btn.click();
            return 'clicked back';
          }
        }
        return 'no back button';
      })()`);
      break;

    case "clear":
      result = await ev(`(() => {
        const input = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (!input) return 'no search input';
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'cleared';
      })()`);
      break;

    case "scan-panel":
      result = await ev(`(() => {
        // Get full DOM snapshot of the right pane
        const pane = document.querySelector('[data-testid="right-pane-container"]');
        if (!pane) return { error: 'no right pane' };

        // Get a simplified DOM tree
        function simplify(el, depth) {
          if (depth > 5) return null;
          const tag = el.tagName?.toLowerCase() || '?';
          const id = el.id || '';
          const aria = el.getAttribute?.('aria-label') || '';
          const role = el.getAttribute?.('role') || '';
          const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ?
                       el.textContent.trim().slice(0, 80) : '';
          const children = Array.from(el.children || []).map(c => simplify(c, depth + 1)).filter(Boolean);

          // Skip empty containers
          if (!id && !aria && !role && !text && children.length === 0) return null;

          const node = { tag };
          if (id) node.id = id;
          if (aria) node.aria = aria;
          if (role) node.role = role;
          if (text) node.text = text;
          if (children.length > 0) node.children = children;
          return node;
        }

        return simplify(pane, 0);
      })()`);
      break;

    case "full-scan":
      // Get all interactive elements including hidden
      result = await ev(`(() => {
        const items = [];
        document.querySelectorAll('button, input, a, textarea, select, [role="button"], [role="option"], [role="tab"]').forEach(el => {
          const text = el.textContent?.trim().slice(0, 100) || '';
          const aria = el.getAttribute('aria-label') || '';
          const id = el.id || '';
          const tag = el.tagName;
          const visible = el.offsetParent !== null;
          if (text || aria || id) {
            items.push({ tag, id, aria, text, visible });
          }
        });
        return items;
      })()`);
      break;

    case "get-connectors":
      // Get the connector group names and action previews from search results
      result = await ev(`(() => {
        // The search results panel has connector groups
        // Each group has a connector name heading and action buttons underneath
        // Let's get all text content organized by the connector group divs

        // First, let's find all "See more" buttons and walk up to find connector names
        const seeMoreButtons = document.querySelectorAll('button');
        const groups = [];
        for (const btn of seeMoreButtons) {
          if (btn.textContent.trim() !== 'See more') continue;
          // Walk up to the connector group container
          let container = btn.parentElement;
          for (let i = 0; i < 5; i++) {
            if (container?.parentElement) container = container.parentElement;
          }
          if (container) {
            const texts = [];
            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
            while (walker.nextNode()) {
              const t = walker.currentNode.textContent.trim();
              if (t && t.length > 1 && t !== 'See more' && t !== 'Favorite') {
                texts.push(t);
              }
            }
            groups.push(texts);
          }
        }
        return groups;
      })()`);
      break;

    case "get-search-html":
      // Get text from the panel area - works for both search results and connector detail views
      result = await ev(`(() => {
        // Try to find the actions panel area
        const searchInput = document.querySelector('input[aria-label="Search for an action or connector"]');
        if (searchInput) {
          let panel = searchInput.parentElement;
          for (let i = 0; i < 10; i++) {
            if (panel?.parentElement) panel = panel.parentElement;
          }
          const allText = panel.innerText;
          return { text: allText.slice(0, 8000), mode: 'search' };
        }

        // If no search input, we might be in connector detail view
        // Look for the panel with breadcrumb navigation
        const navOl = document.querySelector('nav ol');
        if (navOl) {
          let panel = navOl.parentElement;
          for (let i = 0; i < 8; i++) {
            if (panel?.parentElement) panel = panel.parentElement;
          }
          const allText = panel.innerText;
          return { text: allText.slice(0, 8000), mode: 'detail' };
        }

        return { error: 'no panel found' };
      })()`);
      break;

    case "inspect-see-more":
      // Inspect the DOM structure around See more buttons
      result = await ev(`(() => {
        const btns = document.querySelectorAll('button');
        const seeMoreBtns = [];
        for (const btn of btns) {
          if (btn.textContent.trim() === 'See more') {
            // Get parent chain info
            let parent = btn.parentElement;
            const parentChain = [];
            for (let i = 0; i < 8; i++) {
              if (!parent) break;
              parentChain.push({
                tag: parent.tagName,
                id: parent.id || '',
                classes: (parent.className || '').toString().slice(0, 80),
                role: parent.getAttribute('role') || '',
                text: parent.children.length <= 3 ? parent.textContent.trim().slice(0, 100) : ''
              });
              parent = parent.parentElement;
            }
            // Also get siblings
            const container = btn.closest('div');
            const siblingText = container ? container.innerText.slice(0, 200) : '';
            seeMoreBtns.push({
              outerHTML: btn.outerHTML.slice(0, 200),
              parentChain,
              siblingText
            });
            if (seeMoreBtns.length >= 3) break;
          }
        }
        return seeMoreBtns;
      })()`);
      break;

    case "click-connector":
      // Click on a specific connector name to expand its actions
      result = await ev(`(() => {
        const target = ${JSON.stringify(args)};
        // The connector groups have connector name text and a "See more" button
        // We need to find the See more button that's in the same group as the target connector
        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
          if (btn.textContent.trim() !== 'See more') continue;
          // Find the connector group container
          let container = btn.parentElement;
          for (let i = 0; i < 5; i++) {
            if (container?.parentElement) container = container.parentElement;
          }
          if (container && container.textContent.includes(target)) {
            // Check if this container starts with the target connector name
            const innerText = container.innerText.trim();
            if (innerText.startsWith(target)) {
              btn.click();
              return { clicked: true, connectorText: innerText.slice(0, 200) };
            }
          }
        }
        // Fallback: try clicking any element that matches the connector name
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          if (el.textContent.trim() === target && el.children.length === 0) {
            el.click();
            return { clicked: true, fallback: true, tag: el.tagName };
          }
        }
        return { clicked: false };
      })()`);
      break;

    case "status":
      result = await ev(`(() => {
        const testIds = [];
        document.querySelectorAll('[data-testid]').forEach(el => {
          testIds.push(el.getAttribute('data-testid'));
        });
        const edgeBtns = document.querySelectorAll('button[id*="msla-edge"]');
        return {
          title: document.title,
          url: document.location.href,
          buttons: document.querySelectorAll('button').length,
          inputs: document.querySelectorAll('input').length,
          hasCanvas: !!document.querySelector('[data-testid="rf__wrapper"]'),
          hasTrigger: !!document.querySelector('[data-testid*="Manually_trigger"]'),
          hasInsertBtn: edgeBtns.length > 0,
          insertBtnIds: Array.from(edgeBtns).map(b => b.id),
          hasSearchInput: !!document.querySelector('input[aria-label="Search for an action or connector"]'),
          testIds: testIds.filter(t => !t.startsWith('rf__')).slice(0, 20),
          triggerText: !!document.querySelector('[aria-label*="Manually trigger"]'),
        };
      })()`);
      break;

    case "add-trigger":
      {
        // Step 1: Click the Add a trigger canvas node
        await ev(`(() => {
          const triggerNode = document.querySelector('div[aria-label="Add a trigger"]');
          if (triggerNode) {
            triggerNode.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'clicked canvas trigger node';
          }
          return 'no trigger node';
        })()`);

        // Wait for panel to open
        await new Promise(r => setTimeout(r, 3000));

        // Step 2: Search for the trigger
        const triggerName = args || 'Manually trigger a flow';
        const searchInput = await ev(`(() => {
          const input = document.querySelector('input[aria-label="Search for an action or connector"]');
          if (!input) return false;
          input.focus();
          input.click();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(triggerName)});
          const inputEvent = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(triggerName)} });
          input.dispatchEvent(inputEvent);
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);

        // Wait for results
        await new Promise(r => setTimeout(r, 4000));

        // Step 3: Click the first matching fui-Card
        result = await ev(`(() => {
          const target = ${JSON.stringify(triggerName)};
          // Look for fui-Card items
          const cards = document.querySelectorAll('.fui-Card, [role="group"]');
          for (const card of cards) {
            const label = card.getAttribute('aria-label') || '';
            const text = card.textContent.trim();
            if (label === target || text === target) {
              card.click();
              return 'clicked card: ' + label;
            }
          }
          return 'no matching card found';
        })()`);
      }
      break;

    case "goto-editor":
      result = await ev(`(() => {
        window.location.href = 'https://make.powerautomate.com/environments/Default-683096d8-50fb-4b8f-b8eb-6e1ab12e3b93/flows/new?v3=true';
        return 'navigating';
      })()`);
      break;

    case "clear-header":
      result = await ev(`(() => {
        const i = document.getElementById('ms-searchux-input-0');
        if (i) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(i, '');
          i.dispatchEvent(new Event('input', { bubbles: true }));
          i.blur();
          return 'cleared header search';
        }
        return 'no header input';
      })()`);
      break;

    case "click-clear":
      // Click the clear button in the actions panel search
      result = await ev(`(() => {
        const clearBtn = document.querySelector('span[aria-label="clear"]');
        if (clearBtn) { clearBtn.click(); return 'clicked clear'; }
        return 'no clear button';
      })()`);
      break;

    case "find-and-click":
      // Find element by exact text and click it
      result = await ev(`(() => {
        const target = ${JSON.stringify(args)};
        // Search ALL elements
        const all = document.querySelectorAll('*');
        const matches = [];
        for (const el of all) {
          // Check if this element directly contains the target text
          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join('');
          if (directText === target || el.textContent.trim() === target) {
            matches.push({
              tag: el.tagName,
              classes: (el.className || '').toString().slice(0, 80),
              id: el.id || '',
              role: el.getAttribute('role') || '',
              aria: el.getAttribute('aria-label') || '',
              childCount: el.children.length,
              directText: directText.slice(0, 60),
              fullText: el.textContent.trim().slice(0, 60)
            });
          }
        }
        return matches.slice(0, 20);
      })()`);
      break;

    default:
      console.log("Actions: close-copilot, open-panel, search <term>, see-more, read-actions, back, clear, clear-header, click-clear, scan-panel, full-scan");
      break;
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  relay.close();
}

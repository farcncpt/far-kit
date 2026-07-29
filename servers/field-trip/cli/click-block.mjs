#!/usr/bin/env node
/**
 * Find and click a block on the Dzidzor page builder canvas.
 * Usage: node cli/click-block.mjs [text-to-find]
 * Default: clicks the first block on the canvas
 */
import { connectRelay } from "./relay-client.mjs"
const searchText = process.argv[2] || ""
const relay = await connectRelay({ port: 9333, name: "click-block" })

// Step 1: Find all blocks/elements on the canvas
console.log("Finding blocks on canvas...\n")
const blocks = await relay.command("eval", {
  expression: `
    (() => {
      // Look for block containers in the editor canvas area
      // The canvas content starts after "Drop blocks here"
      const all = document.querySelectorAll('section, [data-block-id], [data-block], [class*="block-"], [class*="canvas-block"], [class*="editor-block"], div[draggable], [contenteditable]');
      const results = [];
      const seen = new Set();

      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 20) continue;
        // Only elements in the canvas area (typically center of page)
        if (rect.x < 200) continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        if (seen.has(text)) continue;
        seen.add(text);

        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          blockId: el.getAttribute('data-block-id') || el.getAttribute('data-block') || '',
          className: (el.className || '').toString().slice(0, 60),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          draggable: el.draggable || false,
          editable: el.contentEditable === 'true',
        });
      }

      // If no blocks found with data attributes, try finding by content area
      if (results.length === 0) {
        // Find the main content area (where "Drop blocks here" is)
        const contentArea = document.querySelector('[class*="canvas"], [class*="drop"], [class*="editor-content"], main');
        if (contentArea) {
          const children = contentArea.querySelectorAll(':scope > *');
          for (const child of children) {
            const rect = child.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 20) continue;
            const text = (child.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
            results.push({
              tag: child.tagName.toLowerCase(),
              text,
              className: (child.className || '').toString().slice(0, 60),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            });
          }
        }
      }

      results.sort((a, b) => a.y - b.y);
      return results.slice(0, 20);
    })()
  `
})

if (!blocks || blocks.length === 0) {
  console.log("No blocks found on canvas. Let me check the page structure...")

  // Broader search
  const structure = await relay.command("eval", {
    expression: `
      (() => {
        // Find the "Drop blocks here" text to locate the canvas
        const all = document.querySelectorAll('*');
        let canvasEl = null;
        for (const el of all) {
          if (el.textContent?.includes('Drop blocks here') && el.children.length < 5) {
            canvasEl = el;
            break;
          }
        }

        if (!canvasEl) return { canvas: 'not found by text' };

        // Walk up to find the canvas container
        let container = canvasEl.parentElement;
        for (let i = 0; i < 5; i++) {
          if (container && container.children.length > 3) break;
          container = container?.parentElement;
        }

        if (!container) return { canvas: 'container not found' };

        // List all children of the canvas container
        const children = [];
        const walk = (el, depth) => {
          if (depth > 3) return;
          for (const child of el.children) {
            const rect = child.getBoundingClientRect();
            if (rect.height < 10) continue;
            children.push({
              tag: child.tagName.toLowerCase(),
              text: (child.textContent || '').trim().slice(0, 50),
              className: (child.className || '').toString().slice(0, 40),
              depth,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
              childCount: child.children.length,
              clickHandlers: child.onclick ? true : false,
            });
            walk(child, depth + 1);
          }
        };
        walk(container, 0);

        return {
          canvas: container.tagName + '.' + (container.className || '').toString().slice(0, 40),
          rect: container.getBoundingClientRect(),
          children: children.slice(0, 30),
        };
      })()
    `
  })
  console.log(JSON.stringify(structure, null, 2))
} else {
  console.log(`Found ${blocks.length} blocks:\n`)
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const drag = b.draggable ? ' [draggable]' : ''
    const edit = b.editable ? ' [editable]' : ''
    console.log(`  ${i + 1}. <${b.tag}> "${b.text}" (${b.w}x${b.h}) @ (${b.x},${b.y})${drag}${edit}`)
  }

  // Click the first block or the one matching search text
  let target = blocks[0]
  if (searchText) {
    const match = blocks.find(b => b.text.toLowerCase().includes(searchText.toLowerCase()))
    if (match) target = match
  }

  console.log(`\nClicking: "${target.text}" at (${target.x + target.w/2}, ${target.y + target.h/2})`)

  const clickResult = await relay.command("eval", {
    expression: `
      (() => {
        const x = ${target.x + target.w / 2};
        const y = ${target.y + target.h / 2};
        const el = document.elementFromPoint(x, y);
        if (!el) return { clicked: false, error: 'no element at point' };
        el.click();
        // Also try dispatching pointer events
        el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, bubbles: true }));
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40) };
      })()
    `
  })
  console.log("Click result:", JSON.stringify(clickResult))

  await new Promise(r => setTimeout(r, 2000))

  // Check what appeared after clicking (properties panel)
  console.log("\n=== AFTER CLICK — CHECKING FOR PROPERTIES PANEL ===\n")
  const afterClick = await relay.command("eval", {
    expression: `
      (() => {
        const body = document.body.innerText;
        // Look for property-related text that wasn't there before
        const propertyTerms = ['Properties', 'Style', 'Settings', 'Content', 'Background',
          'Padding', 'Margin', 'Border', 'Font', 'Color', 'Width', 'Height',
          'Alignment', 'Display', 'Position', 'Text', 'Source', 'URL', 'Alt',
          'Class', 'ID', 'Custom CSS', 'Advanced'];

        const found = propertyTerms.filter(t => body.includes(t));

        // Find the rightmost panel (properties usually on right)
        const panels = document.querySelectorAll('[class*="panel"], [class*="Panel"], [class*="properties"], [class*="Properties"], [class*="sidebar"], [class*="inspector"]');
        const panelInfo = [];
        for (const p of panels) {
          const rect = p.getBoundingClientRect();
          if (rect.width > 50 && rect.x > 500) {
            panelInfo.push({
              className: (p.className || '').toString().slice(0, 50),
              x: Math.round(rect.x),
              w: Math.round(rect.width),
              text: p.textContent?.trim()?.replace(/\\s+/g, ' ')?.slice(0, 200),
            });
          }
        }

        return {
          propertyTermsFound: found,
          rightPanels: panelInfo,
          bodySnippet: body.slice(body.indexOf('Drop blocks here') > -1 ? body.indexOf('Drop blocks here') : 0).slice(0, 500),
        };
      })()
    `
  })

  console.log("Property terms found:", afterClick.propertyTermsFound?.join(', '))
  if (afterClick.rightPanels?.length) {
    console.log("\nRight panels:")
    for (const p of afterClick.rightPanels) {
      console.log(`  ${p.className} (${p.w}px wide) @ x=${p.x}`)
      console.log(`  Content: ${p.text?.slice(0, 150)}`)
    }
  }
  console.log("\nBody after canvas:", afterClick.bodySnippet?.slice(0, 300))
}

relay.close()
console.log("\nDone!")

#!/usr/bin/env node
/** Open the Dzidzor visual page editor and explore its structure */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "dzidzor-editor" })

// Navigate to the Home page editor
console.log("Opening Home page visual editor...")
await relay.command("navigate", { url: "http://localhost:3000/admin/pages/cmk7g31fe0000voiztd22zvfm/editor" })
await new Promise(r => setTimeout(r, 5000))

let page = await relay.command("page")
console.log(`Page: ${page.title} — ${page.url}\n`)

// Full scan of the editor UI
console.log("=== VISUAL EDITOR UI ===\n")
const editorUI = await relay.command("eval", {
  expression: `
    (() => {
      const items = [];
      const seen = new Set();
      const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="tab"], [role="toolbar"], [role="tabpanel"], [data-testid], h1, h2, h3, h4, [draggable], [contenteditable]');
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const key = text + ariaLabel;
        if (seen.has(key) || (!text && !ariaLabel)) continue;
        if (text.length > 80) continue;
        seen.add(key);

        items.push({
          tag: el.tagName.toLowerCase(),
          text,
          ariaLabel,
          role: el.getAttribute('role') || '',
          draggable: el.draggable || el.getAttribute('draggable') === 'true',
          contentEditable: el.contentEditable === 'true',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          className: (el.className || '').toString().slice(0, 50),
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items.slice(0, 60);
    })()
  `
})

for (const el of editorUI) {
  const marker = el.draggable ? '📦' : (el.contentEditable ? '✏️' : (el.role ? `[${el.role}]` : '   '))
  const aria = el.ariaLabel ? ` aria="${el.ariaLabel}"` : ''
  const loc = `(${el.x},${el.y}) ${el.w}x${el.h}`
  console.log(`${marker} <${el.tag}>${aria} "${el.text}" @ ${loc}`)
}

// Check for block palette / component panel
console.log("\n=== BLOCK PALETTE / COMPONENT PANEL ===\n")
const blocks = await relay.command("eval", {
  expression: `
    (() => {
      // Look for draggable items, block types, component palette
      const draggables = document.querySelectorAll('[draggable="true"], [class*="block"], [class*="Block"], [class*="component"], [class*="Component"], [class*="palette"], [class*="Palette"], [data-block-type], [data-component]');
      const results = [];
      const seen = new Set();
      for (const el of draggables) {
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        if (!text || seen.has(text) || text.length > 60) continue;
        seen.add(text);
        const rect = el.getBoundingClientRect();
        results.push({
          text,
          draggable: el.draggable,
          blockType: el.getAttribute('data-block-type') || el.getAttribute('data-component') || '',
          className: (el.className || '').toString().slice(0, 60),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }
      return results.slice(0, 30);
    })()
  `
})

for (const block of blocks) {
  const drag = block.draggable ? '📦' : '  '
  console.log(`${drag} "${block.text}" ${block.blockType ? `[${block.blockType}]` : ''} @ (${block.x},${block.y})`)
}

// Check for canvas/preview area
console.log("\n=== CANVAS / PREVIEW AREA ===\n")
const canvas = await relay.command("eval", {
  expression: `
    (() => {
      // Look for iframe (preview), canvas, or main content area
      const iframes = document.querySelectorAll('iframe');
      const canvases = document.querySelectorAll('canvas');
      const contentAreas = document.querySelectorAll('[class*="canvas"], [class*="Canvas"], [class*="preview"], [class*="Preview"], [class*="editor-content"], [class*="workspace"], [class*="Workspace"]');

      return {
        iframeCount: iframes.length,
        iframeSrcs: Array.from(iframes).map(f => ({ src: f.src?.slice(0, 80), width: f.width, height: f.height })),
        canvasCount: canvases.length,
        contentAreas: Array.from(contentAreas).map(c => ({
          tag: c.tagName.toLowerCase(),
          className: (c.className || '').toString().slice(0, 60),
          width: Math.round(c.getBoundingClientRect().width),
          height: Math.round(c.getBoundingClientRect().height),
        })),
      };
    })()
  `
})
console.log(JSON.stringify(canvas, null, 2))

// Check for properties panel
console.log("\n=== PROPERTIES / SETTINGS PANEL ===\n")
const properties = await relay.command("eval", {
  expression: `
    (() => {
      const panels = document.querySelectorAll('[class*="properties"], [class*="Properties"], [class*="settings"], [class*="Settings"], [class*="inspector"], [class*="Inspector"], [class*="sidebar"], [class*="right-panel"], [class*="RightPanel"]');
      return Array.from(panels).map(p => ({
        className: (p.className || '').toString().slice(0, 60),
        width: Math.round(p.getBoundingClientRect().width),
        height: Math.round(p.getBoundingClientRect().height),
        childCount: p.children.length,
        text: p.textContent?.trim()?.replace(/\\s+/g, ' ')?.slice(0, 200),
      })).filter(p => p.width > 50);
    })()
  `
})

for (const p of properties) {
  console.log(`  Panel: ${p.className} (${p.width}x${p.height}) ${p.childCount} children`)
  console.log(`  Content: ${p.text?.slice(0, 150)}`)
}

relay.close()
console.log("\nDone!")

#!/usr/bin/env node
/** Full Power Automate scan + canvas detection */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-scan" })

const page = await relay.command("page")
console.log(`Page: ${page.title}`)
console.log(`URL: ${page.url}\n`)

// Deep scan all elements
console.log("=== POWER AUTOMATE UI SCAN ===\n")
const elements = await relay.command("eval", {
  expression: `
    (() => {
      const sels = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="treeitem"], [role="option"], h1, h2, h3, h4, nav, [data-testid], [aria-label]';
      const els = document.querySelectorAll(sels);
      const items = [];
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text && !['INPUT','SELECT','TEXTAREA'].includes(el.tagName) && !el.getAttribute('aria-label')) continue;
        items.push({
          tag: el.tagName.toLowerCase(),
          text,
          id: el.id || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          role: el.getAttribute('role') || undefined,
          type: el.type || undefined,
          y: Math.round(rect.y),
          clickable: ['A','BUTTON'].includes(el.tagName) || el.getAttribute('role') === 'button' || style.cursor === 'pointer',
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items.slice(0, 60);
    })()
  `
})

if (Array.isArray(elements)) {
  console.log(`Found ${elements.length} elements:\n`)
  for (const el of elements) {
    const marker = el.clickable ? '>>>' : '   '
    const parts = [`<${el.tag}>`]
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
    if (el.role) parts.push(`role="${el.role}"`)
    if (el.id) parts.push(`id="${el.id}"`)
    if (el.text) parts.push(`"${el.text.slice(0, 70)}"`)
    console.log(`${marker} ${parts.join(' ')}`)
  }
}

// Canvas detection
console.log("\n=== CANVAS DETECTION ===\n")
const canvasInfo = await relay.command("eval", {
  expression: `
    (() => {
      const canvases = document.querySelectorAll('canvas');
      const iframes = document.querySelectorAll('iframe');

      // Check for GoJS
      const hasGoJS = typeof window.go !== 'undefined';

      // Check for flow designer APIs
      const apis = [];
      for (const key of Object.keys(window)) {
        const lower = key.toLowerCase();
        if (lower.includes('flow') || lower.includes('designer') || lower.includes('editor') ||
            lower.includes('automate') || lower.includes('diagram') || lower.includes('canvas')) {
          apis.push({ key, type: typeof window[key] });
        }
      }

      // Check for React
      const body = document.body;
      const hasReact = Object.keys(body || {}).some(k => k.startsWith('__reactFiber'));

      return {
        canvasCount: canvases.length,
        iframeCount: iframes.length,
        hasGoJS,
        hasReact,
        windowAPIs: apis.slice(0, 15),
        iframeSrcs: Array.from(iframes).map(f => f.src?.slice(0, 100) || 'no src').slice(0, 5),
      };
    })()
  `
})

console.log(JSON.stringify(canvasInfo, null, 2))

// Navigation structure
console.log("\n=== NAVIGATION STRUCTURE ===\n")
const nav = await relay.command("eval", {
  expression: `
    (() => {
      const navItems = document.querySelectorAll('nav a, nav button, [role="navigation"] a, [role="menuitem"], [role="tab"]');
      return Array.from(navItems).map(el => ({
        text: (el.textContent || '').trim().slice(0, 50),
        href: el.href?.slice(0, 80) || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        selected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('active'),
      })).filter(n => n.text).slice(0, 20);
    })()
  `
})

if (Array.isArray(nav)) {
  for (const item of nav) {
    const active = item.selected ? ' [ACTIVE]' : ''
    console.log(`  ${item.text}${active}`)
  }
}

relay.close()
console.log("\nDone!")

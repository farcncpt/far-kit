#!/usr/bin/env node
/** Explore Dzidzor CMS admin — navigate to Pages and open visual editor */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "dzidzor-admin" })

let page = await relay.command("page")
console.log(`Current: ${page.title} — ${page.url}\n`)

// Scan the admin sidebar/nav
console.log("=== ADMIN UI SCAN ===\n")
const elements = await relay.command("eval", {
  expression: `
    (() => {
      const els = document.querySelectorAll('a, button, input, [role="button"], [role="tab"], [role="menuitem"], h1, h2, h3, nav, [data-testid]');
      const items = [];
      const seen = new Set();
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        if (!text || seen.has(text)) continue;
        if (text.length > 80) continue;
        seen.add(text);
        items.push({
          tag: el.tagName.toLowerCase(),
          text,
          href: el.href?.replace(location.origin, '') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          clickable: ['A','BUTTON'].includes(el.tagName) || style.cursor === 'pointer',
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items.slice(0, 50);
    })()
  `
})

for (const el of elements) {
  const marker = el.clickable ? '>>>' : '   '
  const href = el.href ? ` → ${el.href}` : ''
  console.log(`${marker} <${el.tag}> "${el.text}"${href}`)
}

// Click on "Pages" nav link
console.log("\n=== CLICKING PAGES ===\n")
const clickResult = await relay.command("eval", {
  expression: `
    (() => {
      const links = document.querySelectorAll('a');
      for (const a of links) {
        if (a.textContent.trim() === 'Pages' && a.href?.includes('/pages')) {
          a.click();
          return { clicked: true, href: a.href };
        }
      }
      // Try nav items
      const spans = document.querySelectorAll('span, div');
      for (const s of spans) {
        if (s.textContent.trim() === 'Pages' && getComputedStyle(s).cursor === 'pointer') {
          s.click();
          return { clicked: true, method: 'span' };
        }
      }
      return { clicked: false };
    })()
  `
})
console.log("Click:", JSON.stringify(clickResult))

await new Promise(r => setTimeout(r, 3000))

page = await relay.command("page")
console.log(`Now on: ${page.title} — ${page.url}\n`)

// Scan the pages list
console.log("=== PAGES LIST ===\n")
const pagesList = await relay.command("eval", {
  expression: `
    (() => {
      const items = [];
      const seen = new Set();
      const els = document.querySelectorAll('a, button, [role="row"], [role="link"], tr, [data-testid], h1, h2, h3');
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 10) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text || seen.has(text) || text.length > 100) continue;
        seen.add(text);
        items.push({
          tag: el.tagName.toLowerCase(),
          text,
          href: el.href?.replace(location.origin, '') || undefined,
          y: Math.round(rect.y),
          clickable: ['A','BUTTON','TR'].includes(el.tagName) || getComputedStyle(el).cursor === 'pointer',
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items.slice(0, 40);
    })()
  `
})

for (const el of pagesList) {
  const marker = el.clickable ? '>>>' : '   '
  const href = el.href ? ` → ${el.href}` : ''
  console.log(`${marker} <${el.tag}> "${el.text}"${href}`)
}

// Look for visual editor / page builder links
console.log("\n=== LOOKING FOR VISUAL EDITOR ===\n")
const editorLinks = await relay.command("eval", {
  expression: `
    (() => {
      const links = document.querySelectorAll('a, button');
      const results = [];
      for (const el of links) {
        const text = (el.textContent || '').trim().toLowerCase();
        const href = el.href || '';
        if (text.includes('edit') || text.includes('editor') || text.includes('builder') ||
            text.includes('visual') || text.includes('design') ||
            href.includes('editor') || href.includes('builder')) {
          results.push({
            text: el.textContent.trim().slice(0, 60),
            href: href.replace(location.origin, ''),
            tag: el.tagName.toLowerCase(),
          });
        }
      }
      return results;
    })()
  `
})

for (const link of editorLinks) {
  console.log(`  >>> "${link.text}" → ${link.href}`)
}

relay.close()
console.log("\nDone!")

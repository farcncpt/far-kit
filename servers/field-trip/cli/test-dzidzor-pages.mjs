#!/usr/bin/env node
/** Navigate directly to Dzidzor pages and find the visual editor */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "dzidzor-pages" })

// Navigate directly to /admin/pages
console.log("Navigating to /admin/pages...")
await relay.command("navigate", { url: "http://localhost:3000/admin/pages" })
await new Promise(r => setTimeout(r, 4000))

let page = await relay.command("page")
console.log(`Page: ${page.title} — ${page.url}\n`)

// Full scan of the pages section
console.log("=== PAGES SECTION ===\n")
const scan = await relay.command("eval", {
  expression: `
    (() => {
      const items = [];
      const seen = new Set();
      // Get everything visible
      const els = document.querySelectorAll('a, button, h1, h2, h3, h4, td, th, [role="row"], [role="gridcell"], [role="link"], [data-testid], tr');
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 10) continue;
        // Only content area (right of sidebar, x > 200)
        if (rect.x < 200 && el.tagName !== 'H1' && el.tagName !== 'H2') continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        if (!text || seen.has(text) || text.length > 100) continue;
        seen.add(text);

        items.push({
          tag: el.tagName.toLowerCase(),
          text,
          href: el.href?.replace(location.origin, '') || undefined,
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          clickable: ['A','BUTTON','TR'].includes(el.tagName) || style.cursor === 'pointer',
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items.slice(0, 50);
    })()
  `
})

for (const el of scan) {
  const marker = el.clickable ? '>>>' : '   '
  const href = el.href ? ` → ${el.href}` : ''
  console.log(`${marker} <${el.tag}> "${el.text}"${href}`)
}

// Look for any page entries and their editor links
console.log("\n=== PAGE ENTRIES WITH EDITOR LINKS ===\n")
const pages = await relay.command("eval", {
  expression: `
    (() => {
      // Find all links that go to page editor
      const links = document.querySelectorAll('a[href*="editor"], a[href*="pages/"], button');
      const results = [];
      for (const el of links) {
        const text = (el.textContent || '').trim().slice(0, 60);
        const href = el.href?.replace(location.origin, '') || '';
        if (text && (href.includes('pages') || href.includes('editor') || text.toLowerCase().includes('edit'))) {
          results.push({ text, href, tag: el.tagName.toLowerCase() });
        }
      }

      // Also check table rows for page entries
      const rows = document.querySelectorAll('tr, [role="row"]');
      for (const row of rows) {
        const cells = row.querySelectorAll('td, [role="gridcell"]');
        if (cells.length > 0) {
          const rowText = Array.from(cells).map(c => c.textContent.trim()).join(' | ');
          const link = row.querySelector('a');
          results.push({
            text: rowText.slice(0, 80),
            href: link?.href?.replace(location.origin, '') || '',
            tag: 'row',
          });
        }
      }

      return results.slice(0, 20);
    })()
  `
})

for (const p of pages) {
  console.log(`  "${p.text}" → ${p.href}`)
}

// Also try to find "New Page" or "Create Page" button
console.log("\n=== CREATE/NEW PAGE BUTTONS ===\n")
const createButtons = await relay.command("eval", {
  expression: `
    (() => {
      const btns = document.querySelectorAll('a, button');
      const results = [];
      for (const btn of btns) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text.includes('new page') || text.includes('create page') || text.includes('add page') ||
            text.includes('new') || text.includes('create')) {
          results.push({
            text: btn.textContent.trim().slice(0, 40),
            href: btn.href?.replace(location.origin, '') || '',
            tag: btn.tagName.toLowerCase(),
          });
        }
      }
      return results;
    })()
  `
})

for (const btn of createButtons) {
  console.log(`  >>> "${btn.text}" → ${btn.href}`)
}

relay.close()
console.log("\nDone!")

#!/usr/bin/env node
/** Test Dzidzor CMS on localhost via relay */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "dzidzor-cms" })
console.log("Connected to relay.\n")

// Navigate to localhost
console.log("Navigating to Dzidzor CMS on localhost:3000...")
await relay.command("navigate", { url: "http://localhost:3000" })
await new Promise(r => setTimeout(r, 5000))

let page = await relay.command("page")
console.log(`Page: ${page.title}`)
console.log(`URL: ${page.url}\n`)

// Scan the homepage
console.log("=== HOMEPAGE SCAN ===")
try {
  const elements = await relay.command("scan", { maxItems: 40 })
  if (Array.isArray(elements)) {
    console.log(`Found ${elements.length} interactive elements:\n`)
    for (const el of elements) {
      const parts = [`<${el.tag}>`]
      if (el.id) parts.push(`id="${el.id}"`)
      if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
      if (el.role) parts.push(`role="${el.role}"`)
      if (el.clickable) parts.push('[clickable]')
      if (el.text) parts.push(`"${el.text.slice(0, 60)}"`)
      console.log('  ' + parts.join(' '))
    }
  }
} catch (e) {
  console.log("Scan error:", e.message)
  console.log("Trying find instead...")

  for (const term of ["Home", "Shop", "Admin", "Sign", "Product", "Blog", "Contact"]) {
    try {
      const found = await relay.command("find", { text: term })
      if (Array.isArray(found) && found.length > 0) {
        console.log(`  "${term}" — ${found.length} matches`)
      }
    } catch {}
  }
}

// Try navigating to admin
console.log("\n=== NAVIGATING TO ADMIN ===")
await relay.command("navigate", { url: "http://localhost:3000/admin" })
await new Promise(r => setTimeout(r, 5000))

page = await relay.command("page")
console.log(`Page: ${page.title}`)
console.log(`URL: ${page.url}\n`)

// Scan admin page
console.log("=== ADMIN PAGE SCAN ===")
try {
  const elements = await relay.command("scan", { maxItems: 40 })
  if (Array.isArray(elements)) {
    console.log(`Found ${elements.length} elements:\n`)
    for (const el of elements) {
      const parts = [`<${el.tag}>`]
      if (el.id) parts.push(`id="${el.id}"`)
      if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
      if (el.role) parts.push(`role="${el.role}"`)
      if (el.clickable) parts.push('[clickable]')
      if (el.type) parts.push(`type="${el.type}"`)
      if (el.text) parts.push(`"${el.text.slice(0, 60)}"`)
      console.log('  ' + parts.join(' '))
    }
  }
} catch (e) {
  console.log("Scan error:", e.message)

  // Try reading CSS variables (design system)
  console.log("\n=== DESIGN SYSTEM (CSS Variables) ===")
  try {
    const vars = await relay.command("eval", {
      expression: `
        (() => {
          const root = getComputedStyle(document.documentElement);
          const vars = {};
          // Read common CSS custom properties
          const names = ['--background', '--foreground', '--primary', '--secondary', '--accent', '--muted',
                         '--border', '--radius', '--card', '--popover', '--destructive',
                         '--font-sans', '--font-mono'];
          for (const name of names) {
            const val = root.getPropertyValue(name).trim();
            if (val) vars[name] = val;
          }
          // Also read any custom properties from the stylesheet
          try {
            for (const sheet of document.styleSheets) {
              for (const rule of sheet.cssRules || []) {
                if (rule.selectorText === ':root' || rule.selectorText === 'html') {
                  for (let i = 0; i < rule.style.length; i++) {
                    const prop = rule.style[i];
                    if (prop.startsWith('--')) {
                      vars[prop] = rule.style.getPropertyValue(prop).trim();
                    }
                  }
                }
              }
            }
          } catch(e) { /* cross-origin stylesheet */ }
          return vars;
        })()
      `
    })
    console.log(JSON.stringify(vars, null, 2))
  } catch (e2) {
    console.log("CSS vars error:", e2.message)
  }
}

// Check for page builder elements
console.log("\n=== PAGE BUILDER DETECTION ===")
try {
  for (const term of ["Page", "Builder", "Block", "Editor", "Canvas", "Drag", "Drop", "Template"]) {
    const found = await relay.command("find", { text: term })
    if (Array.isArray(found) && found.length > 0) {
      for (const el of found.slice(0, 3)) {
        console.log(`  "${term}" → <${el.tagName || el.tag}> "${(el.text || '').slice(0, 60)}"`)
      }
    }
  }
} catch (e) {
  console.log("Find error:", e.message)
}

// Framework detection
console.log("\n=== FRAMEWORK DETECTION ===")
try {
  const framework = await relay.command("eval", {
    expression: `
      (() => {
        const result = {};
        // Next.js
        if (window.__NEXT_DATA__) {
          result.nextjs = { version: window.__NEXT_DATA__?.nextExport ? 'static' : 'ssr', page: window.__NEXT_DATA__?.page };
        }
        // React
        const body = document.body || document.documentElement;
        const reactKey = Object.keys(body).find(k => k.startsWith('__reactFiber'));
        if (reactKey) result.react = true;
        // Check for CMS indicators
        const metaTags = document.querySelectorAll('meta[name]');
        for (const m of metaTags) {
          const name = m.getAttribute('name');
          if (name?.includes('cms') || name?.includes('generator')) {
            result.meta = result.meta || {};
            result.meta[name] = m.getAttribute('content');
          }
        }
        return result;
      })()
    `
  })
  console.log(JSON.stringify(framework, null, 2))
} catch (e) {
  console.log("Framework detection error:", e.message)
}

relay.close()
console.log("\nDone!")

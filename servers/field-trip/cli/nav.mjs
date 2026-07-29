#!/usr/bin/env node
/**
 * Navigate or click via relay.
 * Usage:
 *   node cli/nav.mjs <url>              — navigate to URL
 *   node cli/nav.mjs click <text>       — click element by text content
 *   node cli/nav.mjs js <expression>    — evaluate JS in page
 */
import { connectRelay } from "./relay-client.mjs"
const cmd = process.argv[2]
if (!cmd) { console.log("Usage: node cli/nav.mjs <url|click|js> [args]"); process.exit(1) }
const relay = await connectRelay({ port: 9333, name: "nav" })

if (cmd === "click") {
  const text = process.argv.slice(3).join(" ")
  const result = await relay.command("eval", {
    expression: `(() => {
      const els = document.querySelectorAll('a, button, [role="button"]');
      for (const el of els) {
        if (el.textContent.trim() === ${JSON.stringify(text)}) {
          el.click();
          return { clicked: true, href: el.href || '', text: el.textContent.trim().slice(0, 40) };
        }
      }
      // Partial match
      for (const el of els) {
        if (el.textContent.trim().includes(${JSON.stringify(text)})) {
          el.click();
          return { clicked: true, partial: true, text: el.textContent.trim().slice(0, 40) };
        }
      }
      return { clicked: false };
    })()`
  })
  console.log(JSON.stringify(result))
} else if (cmd === "js") {
  const expr = process.argv.slice(3).join(" ")
  const result = await relay.command("eval", { expression: expr })
  console.log(JSON.stringify(result, null, 2))
} else {
  // Treat as URL
  await relay.command("navigate", { url: cmd })
  await new Promise(r => setTimeout(r, 3000))
}

const page = await relay.command("page")
console.log(`${page.title} — ${page.url}`)
relay.close()

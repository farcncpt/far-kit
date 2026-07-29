#!/usr/bin/env node
/** Navigate to Power Automate and run canvas detection */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "power-automate" })
console.log("Connected to relay.\n")

// Navigate to Power Automate
console.log("Navigating to Power Automate...")
await relay.command("navigate", { url: "https://make.powerautomate.com" })
console.log("Waiting for page to load...")
await new Promise(r => setTimeout(r, 8000))

const page = await relay.command("page")
console.log(`Page: ${page.title}`)
console.log(`URL: ${page.url}\n`)

// Scan the DOM elements
console.log("=== DOM SCAN ===")
try {
  const found = await relay.command("find", { text: "flow" })
  if (Array.isArray(found) && found.length > 0) {
    for (const el of found.slice(0, 15)) {
      console.log(`  <${el.tagName || el.tag}> "${(el.text || '').slice(0, 80)}"`)
    }
  } else {
    console.log("  No 'flow' elements found")
  }
} catch (e) {
  console.log("  Scan error:", e.message)
}

// Try finding common Power Automate elements
console.log("\n=== Looking for Power Automate UI elements ===")
for (const term of ["Create", "My flows", "Templates", "Sign in", "Get started"]) {
  try {
    const found = await relay.command("find", { text: term })
    if (Array.isArray(found) && found.length > 0) {
      console.log(`  "${term}" — found ${found.length} matches`)
    }
  } catch {
    // skip
  }
}

// Canvas detection
console.log("\n=== CANVAS DETECTION ===")
try {
  const canvasInfo = await relay.command("eval", {
    expression: `
      (() => {
        const canvases = document.querySelectorAll('canvas');
        const iframes = document.querySelectorAll('iframe');
        return {
          url: location.href,
          title: document.title,
          canvasCount: canvases.length,
          iframeCount: iframes.length,
          hasGoJS: !!window.go,
          bodyText: document.body?.innerText?.slice(0, 500),
        };
      })()
    `
  })
  console.log(JSON.stringify(canvasInfo, null, 2))
} catch (e) {
  console.log("  Eval error:", e.message)
  console.log("  (This may be a login page — Power Automate requires Microsoft authentication)")
}

relay.close()
console.log("\nDone!")

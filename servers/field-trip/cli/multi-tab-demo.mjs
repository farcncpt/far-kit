#!/usr/bin/env node
/**
 * multi-tab-demo.mjs — Demonstrates multi-tab targeting with the Field Trip relay.
 *
 * This script:
 *   1. Lists all open browser tabs
 *   2. Picks two tabs and scans them simultaneously using Promise.all
 *   3. Shows that both tabs can be read independently without interference
 *
 * Usage:
 *   node cli/multi-tab-demo.mjs                   # auto-pick first two tabs
 *   node cli/multi-tab-demo.mjs 123 456           # scan specific tab IDs
 *
 * Prerequisites:
 *   - ws-relay.mjs running:  node cli/ws-relay.mjs
 *   - Extension relay page connected in Chrome
 */

import { connectRelay } from "./relay-client.mjs"

const args = process.argv.slice(2)
const port = parseInt(process.env.RELAY_PORT || "9333")

console.log("=== Multi-Tab Demo ===\n")

const relay = await connectRelay({ port, name: "multi-tab-demo" })

if (!relay.isExtensionConnected()) {
  console.error("Warning: Extension relay page not connected. Results may fail.\n")
}

// Step 1: List all open tabs
console.log("Step 1: Listing all open tabs...\n")
const tabs = await relay.listTabs()

if (!tabs || tabs.length === 0) {
  console.log("No tabs found. Open some browser tabs and try again.")
  relay.close()
  process.exit(1)
}

for (const t of tabs) {
  const marker = t.active ? " *" : "  "
  console.log(`${marker} [${t.id}] ${t.title}`)
  console.log(`         ${t.url}`)
}
console.log()

// Step 2: Pick two tabs to scan
let tabA, tabB

if (args.length >= 2) {
  // Use user-specified tab IDs
  tabA = parseInt(args[0])
  tabB = parseInt(args[1])
  console.log(`Step 2: Using specified tabs: ${tabA} and ${tabB}\n`)
} else if (tabs.length >= 2) {
  // Auto-pick first two tabs
  tabA = tabs[0].id
  tabB = tabs[1].id
  console.log(`Step 2: Auto-selected tabs: [${tabA}] "${tabs[0].title}" and [${tabB}] "${tabs[1].title}"\n`)
} else {
  console.log("Only one tab available. Need at least 2 for the multi-tab demo.")
  console.log("Scanning the single tab instead...\n")
  tabA = tabs[0].id
  tabB = null
}

// Step 3: Scan tabs simultaneously
console.log("Step 3: Scanning tabs simultaneously with Promise.all...\n")

const startTime = Date.now()

if (tabB) {
  // Scan both tabs at the same time
  const [resultA, resultB] = await Promise.all([
    relay.command("scan", { maxItems: 20 }, { tabId: tabA }),
    relay.command("scan", { maxItems: 20 }, { tabId: tabB }),
  ])

  const elapsed = Date.now() - startTime
  console.log(`Both scans completed in ${elapsed}ms (parallel)\n`)

  // Show results from tab A
  const tabAInfo = tabs.find((t) => t.id === tabA)
  console.log(`--- Tab [${tabA}]: ${tabAInfo?.title || "Unknown"} ---`)
  if (Array.isArray(resultA)) {
    console.log(`  Found ${resultA.length} elements`)
    for (const el of resultA.slice(0, 5)) {
      const text = el.text ? `"${el.text.slice(0, 60)}"` : ""
      console.log(`    <${el.tag || el.tagName}> ${text}`)
    }
    if (resultA.length > 5) console.log(`    ... and ${resultA.length - 5} more`)
  } else {
    console.log(`  Result:`, JSON.stringify(resultA).slice(0, 200))
  }
  console.log()

  // Show results from tab B
  const tabBInfo = tabs.find((t) => t.id === tabB)
  console.log(`--- Tab [${tabB}]: ${tabBInfo?.title || "Unknown"} ---`)
  if (Array.isArray(resultB)) {
    console.log(`  Found ${resultB.length} elements`)
    for (const el of resultB.slice(0, 5)) {
      const text = el.text ? `"${el.text.slice(0, 60)}"` : ""
      console.log(`    <${el.tag || el.tagName}> ${text}`)
    }
    if (resultB.length > 5) console.log(`    ... and ${resultB.length - 5} more`)
  } else {
    console.log(`  Result:`, JSON.stringify(resultB).slice(0, 200))
  }
} else {
  // Single tab scan
  const result = await relay.command("scan", { maxItems: 20 }, { tabId: tabA })
  const elapsed = Date.now() - startTime
  console.log(`Scan completed in ${elapsed}ms\n`)

  if (Array.isArray(result)) {
    console.log(`Found ${result.length} elements in tab [${tabA}]`)
    for (const el of result.slice(0, 10)) {
      const text = el.text ? `"${el.text.slice(0, 80)}"` : ""
      console.log(`  <${el.tag || el.tagName}> ${text}`)
    }
  }
}

console.log("\n=== Demo complete ===")
relay.close()

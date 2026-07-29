// StackDive LMS Audit - Navigate to key pages and scan
import { connectRelay } from "./relay-client.mjs"

const TAB = 704448034
const BASE = "https://v0-lms-course-ui.vercel.app"

const relay = await connectRelay({ port: 9333, name: "sd-audit" })

async function navAndScan(path, label) {
  console.log(`\n=== ${label} (${path}) ===`)
  const navResult = await relay.command("navigate", { url: `${BASE}${path}` }, { tabId: TAB })
  console.log("Nav result:", JSON.stringify(navResult).slice(0, 200))

  // Wait for page load
  await new Promise(r => setTimeout(r, 3000))

  const pageResult = await relay.command("page", {}, { tabId: TAB })
  console.log("Page:", JSON.stringify(pageResult).slice(0, 500))

  const scanResult = await relay.command("scan", {}, { tabId: TAB })
  console.log("Scan:", JSON.stringify(scanResult).slice(0, 2000))

  return { page: pageResult, scan: scanResult }
}

// Start with dashboard to check auth
const results = {}
results.dashboard = await navAndScan("/dashboard", "Dashboard")
results.explore = await navAndScan("/explore", "Explore/Catalog")
results.courses = await navAndScan("/courses", "Courses")
results.workspace = await navAndScan("/workspace", "Workspace")
results.workspaceImport = await navAndScan("/workspace/import", "Workspace Import")

relay.close()
console.log("\n=== AUDIT BATCH 1 COMPLETE ===")

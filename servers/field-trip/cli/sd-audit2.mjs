// StackDive LMS Audit - Batch 2: More routes
import { connectRelay } from "./relay-client.mjs"

const TAB = 704448034
const BASE = "https://v0-lms-course-ui.vercel.app"

const relay = await connectRelay({ port: 9333, name: "sd-audit2" })

async function navAndScan(path, label) {
  console.log(`\n=== ${label} (${path}) ===`)
  await relay.command("navigate", { url: `${BASE}${path}` }, { tabId: TAB })
  await new Promise(r => setTimeout(r, 3000))

  const pageResult = await relay.command("page", {}, { tabId: TAB })
  console.log("URL:", pageResult.url)
  console.log("Title:", pageResult.title)

  const scanResult = await relay.command("scan", {}, { tabId: TAB })
  const scanStr = JSON.stringify(scanResult)
  console.log("Elements:", scanResult.length)
  // Print first 3000 chars of scan
  console.log("Scan:", scanStr.slice(0, 3000))
  return { page: pageResult, scan: scanResult }
}

// Check courses page in detail
const r1 = await navAndScan("/courses", "Courses Catalog")

// Check a specific course
const r2 = await navAndScan("/courses/chatsdk", "Course Detail - ChatSDK")

// Check explore page
const r3 = await navAndScan("/explore", "Explore Page")

// Check the landing page
const r4 = await navAndScan("/", "Landing Page")

// Check pricing
const r5 = await navAndScan("/pricing", "Pricing Page")

// Check demo
const r6 = await navAndScan("/demo", "Demo Page")

// Check admin
const r7 = await navAndScan("/admin", "Admin Page")

// Check org page
const r8 = await navAndScan("/org", "Org List Page")

relay.close()
console.log("\n=== AUDIT BATCH 2 COMPLETE ===")

// StackDive LMS Audit - Batch 4: Use exec to check DOM + deeper analysis
import { connectRelay } from "./relay-client.mjs"

const TAB = 704448034
const BASE = "https://v0-lms-course-ui.vercel.app"

const relay = await connectRelay({ port: 9333, name: "sd-audit4" })

// Navigate to courses page
console.log("\n=== Courses Page - Deep Check ===")
await relay.command("navigate", { url: `${BASE}/courses` }, { tabId: TAB })
await new Promise(r => setTimeout(r, 5000))

const page = await relay.command("page", {}, { tabId: TAB })
console.log("URL:", page.url)

// Use exec to check the DOM
try {
  const exec = await relay.command("exec", {
    code: `
      const body = document.body;
      return {
        childCount: body.children.length,
        innerHTML: body.innerHTML.slice(0, 2000),
        url: window.location.href,
        readyState: document.readyState,
      };
    `
  }, { tabId: TAB })
  console.log("Exec result:", JSON.stringify(exec).slice(0, 3000))
} catch (err) {
  console.log("Exec error:", err.message)
}

// Try find
console.log("\n=== Find 'Browse Courses' ===")
try {
  const find = await relay.command("find", { text: "Browse" }, { tabId: TAB })
  console.log("Find result:", JSON.stringify(find).slice(0, 1000))
} catch (err) {
  console.log("Find error:", err.message)
}

// Try the dashboard
console.log("\n=== Dashboard - Deep Check ===")
await relay.command("navigate", { url: `${BASE}/dashboard` }, { tabId: TAB })
await new Promise(r => setTimeout(r, 5000))
const dashPage = await relay.command("page", {}, { tabId: TAB })
console.log("Dashboard URL:", dashPage.url)

const dashScan = await relay.command("scan", {}, { tabId: TAB })
console.log("Dashboard Elements:", dashScan.length)
if (dashScan.length > 0) {
  console.log("Dashboard Scan:", JSON.stringify(dashScan).slice(0, 3000))
}

// Check onboarding
console.log("\n=== Onboarding Check ===")
await relay.command("navigate", { url: `${BASE}/onboarding` }, { tabId: TAB })
await new Promise(r => setTimeout(r, 4000))
const onbPage = await relay.command("page", {}, { tabId: TAB })
console.log("Onboarding URL:", onbPage.url)
const onbScan = await relay.command("scan", {}, { tabId: TAB })
console.log("Onboarding Elements:", onbScan.length)
if (onbScan.length > 0) {
  console.log("Onboarding Scan:", JSON.stringify(onbScan).slice(0, 2000))
}

// Check billing
console.log("\n=== Billing Check ===")
await relay.command("navigate", { url: `${BASE}/billing` }, { tabId: TAB })
await new Promise(r => setTimeout(r, 4000))
const billPage = await relay.command("page", {}, { tabId: TAB })
console.log("Billing URL:", billPage.url)
const billScan = await relay.command("scan", {}, { tabId: TAB })
console.log("Billing Elements:", billScan.length)

relay.close()
console.log("\n=== AUDIT BATCH 4 COMPLETE ===")

// StackDive LMS Audit - Batch 3: Vercel dashboard + console errors + deeper page scans
import { connectRelay } from "./relay-client.mjs"

const TAB_APP = 704448034
const TAB_VERCEL = 704448032

const relay = await connectRelay({ port: 9333, name: "sd-audit3" })

// Check Vercel dashboard
console.log("\n=== Vercel Dashboard Tab ===")
try {
  const vercelPage = await relay.command("page", {}, { tabId: TAB_VERCEL })
  console.log("Vercel URL:", vercelPage.url)
  console.log("Vercel Title:", vercelPage.title)

  const vercelScan = await relay.command("scan", {}, { tabId: TAB_VERCEL })
  console.log("Vercel Elements:", vercelScan.length)
  console.log("Vercel Scan:", JSON.stringify(vercelScan).slice(0, 4000))
} catch (err) {
  console.log("Vercel tab error:", err.message)
}

// Navigate to courses page with longer wait
console.log("\n=== Courses Page (longer wait) ===")
await relay.command("navigate", { url: "https://v0-lms-course-ui.vercel.app/courses" }, { tabId: TAB_APP })
await new Promise(r => setTimeout(r, 5000))
const coursesPage = await relay.command("page", {}, { tabId: TAB_APP })
console.log("Courses URL:", coursesPage.url)
const coursesScan = await relay.command("scan", {}, { tabId: TAB_APP })
console.log("Courses Elements:", coursesScan.length)
console.log("Courses Scan:", JSON.stringify(coursesScan).slice(0, 3000))

// Navigate to landing page with longer wait
console.log("\n=== Landing Page (longer wait) ===")
await relay.command("navigate", { url: "https://v0-lms-course-ui.vercel.app/" }, { tabId: TAB_APP })
await new Promise(r => setTimeout(r, 5000))
const landingPage = await relay.command("page", {}, { tabId: TAB_APP })
console.log("Landing URL:", landingPage.url)
const landingScan = await relay.command("scan", {}, { tabId: TAB_APP })
console.log("Landing Elements:", landingScan.length)
console.log("Landing Scan:", JSON.stringify(landingScan).slice(0, 3000))

// Check console errors via JS eval
console.log("\n=== Console Errors Check ===")
try {
  const consoleResult = await relay.command("evaluate", {
    expression: `
      (() => {
        // Check for common error indicators in the DOM
        const errorElements = document.querySelectorAll('[class*="error"], [class*="Error"]');
        const nextDataEl = document.getElementById('__NEXT_DATA__');
        const nextData = nextDataEl ? JSON.parse(nextDataEl.textContent).props?.pageProps : null;
        return JSON.stringify({
          errorElements: errorElements.length,
          hasNextData: !!nextDataEl,
          url: window.location.href,
          readyState: document.readyState,
          bodyChildren: document.body.children.length,
          bodyFirstChild: document.body.firstElementChild?.tagName,
          title: document.title,
        });
      })()
    `
  }, { tabId: TAB_APP })
  console.log("Page state:", consoleResult)
} catch (err) {
  console.log("Eval error:", err.message)
}

relay.close()
console.log("\n=== AUDIT BATCH 3 COMPLETE ===")

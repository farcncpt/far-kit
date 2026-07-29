#!/usr/bin/env node
/** Check Dzidzor auth state and try to navigate to admin */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "dzidzor-auth" })

// Check current page
let page = await relay.command("page")
console.log(`Current: ${page.title} — ${page.url}\n`)

// Navigate to sign-in
console.log("Navigating to sign-in...")
await relay.command("navigate", { url: "http://localhost:3000/handler/sign-in" })
await new Promise(r => setTimeout(r, 4000))

page = await relay.command("page")
console.log(`Page: ${page.title} — ${page.url}\n`)

// Scan sign-in page
console.log("=== SIGN-IN PAGE ===")
try {
  const elements = await relay.command("scan", { maxItems: 30 })
  if (Array.isArray(elements)) {
    for (const el of elements) {
      const parts = [`<${el.tag}>`]
      if (el.id) parts.push(`id="${el.id}"`)
      if (el.type) parts.push(`type="${el.type}"`)
      if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`)
      if (el.clickable) parts.push('[clickable]')
      if (el.text) parts.push(`"${el.text.slice(0, 60)}"`)
      console.log('  ' + parts.join(' '))
    }
  }
} catch (e) {
  console.log("Scan error:", e.message)

  // Try find
  for (const term of ["Sign in", "Email", "Password", "Google", "GitHub", "Sign up"]) {
    try {
      const found = await relay.command("find", { text: term })
      if (Array.isArray(found) && found.length > 0) {
        console.log(`  Found: "${term}" — <${found[0].tagName || found[0].tag}>`)
      }
    } catch {}
  }
}

// Check if already logged in by looking for user menu
console.log("\n=== AUTH STATE CHECK ===")
try {
  const authState = await relay.command("eval", {
    expression: `
      (() => {
        // Check cookies for auth tokens
        const cookies = document.cookie.split(';').map(c => c.trim().split('=')[0]);
        const authCookies = cookies.filter(c =>
          c.includes('token') || c.includes('session') || c.includes('auth') || c.includes('stack')
        );

        // Check localStorage
        const authKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key.includes('token') || key.includes('auth') || key.includes('user') || key.includes('stack')) {
            authKeys.push(key);
          }
        }

        return {
          url: location.href,
          authCookies,
          authLocalStorage: authKeys,
          totalCookies: cookies.length,
        };
      })()
    `
  })
  console.log(JSON.stringify(authState, null, 2))
} catch (e) {
  console.log("Auth check error:", e.message)
}

relay.close()
console.log("\nDone!")

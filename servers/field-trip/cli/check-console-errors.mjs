#!/usr/bin/env node
/** Check browser console for errors via relay eval */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "console-check" })

const page = await relay.command("page")
console.log(`Page: ${page.title} — ${page.url}\n`)

// Read the error overlay text
const errorInfo = await relay.command("eval", {
  expression: `
    (() => {
      // Next.js error overlay
      const errorOverlay = document.querySelector('nextjs-portal');
      let overlayText = null;
      if (errorOverlay?.shadowRoot) {
        overlayText = errorOverlay.shadowRoot.textContent?.trim()?.slice(0, 500);
      }

      // Check for error boundary message
      const errorBoundary = document.querySelector('[data-nextjs-error]') ||
                           document.querySelector('.error-overlay') ||
                           document.querySelector('#__next-build-error');
      let boundaryText = errorBoundary?.textContent?.trim()?.slice(0, 500);

      // Read body text for error message
      const bodyText = document.body?.innerText?.trim()?.slice(0, 500);

      // Check Next.js data for error info
      const nextData = window.__NEXT_DATA__;
      let nextError = null;
      if (nextData?.err) {
        nextError = { message: nextData.err.message, statusCode: nextData.err.statusCode };
      }

      // Check for any script errors captured
      const scripts = document.querySelectorAll('script');
      let inlineErrors = [];
      for (const s of scripts) {
        if (s.textContent?.includes('Error') || s.textContent?.includes('error')) {
          const match = s.textContent.match(/Error[: ]+([^\n"]+)/);
          if (match) inlineErrors.push(match[0].slice(0, 100));
        }
      }

      return {
        bodyText,
        overlayText,
        boundaryText,
        nextError,
        inlineErrors: inlineErrors.slice(0, 5),
        url: location.href,
      };
    })()
  `
})

console.log("=== ERROR ANALYSIS ===\n")
console.log("Body text:", errorInfo.bodyText?.slice(0, 200))
if (errorInfo.overlayText) console.log("\nError overlay:", errorInfo.overlayText.slice(0, 300))
if (errorInfo.boundaryText) console.log("\nError boundary:", errorInfo.boundaryText.slice(0, 300))
if (errorInfo.nextError) console.log("\nNext.js error:", JSON.stringify(errorInfo.nextError))
if (errorInfo.inlineErrors?.length) {
  console.log("\nInline errors:")
  for (const e of errorInfo.inlineErrors) console.log(`  ${e}`)
}

// Also check the dev server terminal output for the real error
console.log("\n=== SUGGESTION ===")
console.log("The sign-in page is crashing with a client-side error.")
console.log("This is likely a Stack Auth configuration issue.")
console.log("Check:")
console.log("  1. .env.local has NEXT_PUBLIC_STACK_PROJECT_ID and STACK_SECRET_SERVER_KEY")
console.log("  2. Stack Auth project is configured for localhost:3000")
console.log("  3. The dev server terminal for the actual error stack trace")

relay.close()

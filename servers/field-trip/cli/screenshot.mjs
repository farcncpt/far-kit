#!/usr/bin/env node
/**
 * Screenshot tool — captures the browser viewport via CDP or relay.
 * When combined with Field Trip's spotlight overlay, produces annotated screenshots.
 *
 * Usage:
 *   node cli/screenshot.mjs [--output path.png] [--selector "#element"] [--highlight] [--full-page]
 *   node cli/screenshot.mjs --relay [--output path.png] [--highlight]
 *
 * Options:
 *   --output, -o     Output file path (default: screenshot-<timestamp>.png)
 *   --selector, -s   Highlight this element before capturing (uses spotlight)
 *   --highlight      Keep existing spotlights visible in screenshot
 *   --full-page      Capture entire scrollable page, not just viewport
 *   --caption, -c    Caption text for the spotlight tooltip
 *   --delay          Wait N ms before capturing (default: 500)
 *   --relay          Use WebSocket relay instead of CDP
 *   --quality        JPEG quality 0-100 (default: PNG format)
 *   --width          Viewport width override
 *   --height         Viewport height override
 */

import { writeFileSync, mkdirSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import http from "http"

const PORT = parseInt(process.env.CDP_PORT || "9222")

// ─── Arg parsing ───

const args = process.argv.slice(2)
const flags = {}
const positional = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === "--output" || arg === "-o") flags.output = args[++i]
  else if (arg === "--selector" || arg === "-s") flags.selector = args[++i]
  else if (arg === "--caption" || arg === "-c") flags.caption = args[++i]
  else if (arg === "--delay") flags.delay = parseInt(args[++i])
  else if (arg === "--quality") flags.quality = parseInt(args[++i])
  else if (arg === "--width") flags.width = parseInt(args[++i])
  else if (arg === "--height") flags.height = parseInt(args[++i])
  else if (arg === "--highlight") flags.highlight = true
  else if (arg === "--full-page") flags.fullPage = true
  else if (arg === "--relay") flags.relay = true
  else if (arg === "--help" || arg === "-h") {
    console.log(`
Screenshot — capture browser viewport with optional spotlight annotations

  node cli/screenshot.mjs                           # basic viewport capture
  node cli/screenshot.mjs -s "#login-btn"           # highlight element + capture
  node cli/screenshot.mjs -s "#login-btn" -c "Click here to sign in"
  node cli/screenshot.mjs --full-page -o guide.png  # full page capture
  node cli/screenshot.mjs --relay -s "nav"          # via relay (no CDP needed)

Options:
  -o, --output <path>     Output file (default: screenshots/screenshot-<time>.png)
  -s, --selector <sel>    Spotlight this element before capture
  -c, --caption <text>    Caption for the spotlight
  --highlight             Keep existing spotlights in the screenshot
  --full-page             Capture entire scrollable page
  --delay <ms>            Wait before capturing (default: 500, 1500 with spotlight)
  --relay                 Use WebSocket relay instead of CDP
  --quality <0-100>       JPEG quality (omit for PNG)
  --width <px>            Override viewport width
  --height <px>           Override viewport height
    `)
    process.exit(0)
  }
  else positional.push(arg)
}

// Default output path
if (!flags.output) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const dir = resolve("screenshots")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  flags.output = resolve(dir, `screenshot-${ts}.png`)
}

// ─── CDP connection ───

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"))
  if (!page) { console.error("No page tab found"); process.exit(1) }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j) })

  let msgId = 0
  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP timeout")), 30000)
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id === id) {
          ws.off("message", handler)
          clearTimeout(timeout)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expr) {
    const result = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "eval failed")
    }
    return result.result?.value
  }

  return { ws, send, evaluate }
}

// ─── Relay connection ───

async function connectRelay() {
  const { connectRelay: connect } = await import("./relay-client.mjs")
  const client = await connect()
  return {
    ws: client,
    send: null, // relay doesn't support raw CDP commands
    evaluate: (expr) => client.command("eval", { expression: expr }),
    command: client.command,
    close: client.close,
    isRelay: true,
  }
}

// ─── Screenshot via CDP ───

async function captureScreenshotCDP(send, options = {}) {
  const params = {
    format: options.quality ? "jpeg" : "png",
    captureBeyondViewport: !!options.fullPage,
  }
  if (options.quality) params.quality = options.quality

  if (options.fullPage) {
    // Get full page dimensions
    const layout = await send("Page.getLayoutMetrics")
    const { width, height } = layout.contentSize || layout.cssContentSize
    params.clip = { x: 0, y: 0, width, height, scale: 1 }
  }

  const result = await send("Page.captureScreenshot", params)
  return Buffer.from(result.data, "base64")
}

// ─── Screenshot via Relay (uses CDP under the hood via eval) ───

async function captureScreenshotRelay(command) {
  // The relay can't do Page.captureScreenshot directly.
  // Use html2canvas approach via eval, or just capture via the extension.
  // For now, we'll use the canvas approach.
  const dataUrl = await command("eval", {
    expression: `
      new Promise((resolve) => {
        // Use the native browser screenshot API if available
        // Otherwise create a canvas from the viewport
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        // We can't actually screenshot via JS alone without html2canvas
        // Return a placeholder indicating relay screenshot needs CDP
        resolve(null);
      })
    `
  })

  if (!dataUrl) {
    console.log("Note: Full screenshot requires CDP mode. Relay mode can highlight elements but needs CDP for capture.")
    console.log("Use CDP mode: CDP_PORT=9225 node cli/screenshot.mjs -s \"#element\"")
    return null
  }

  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "")
  return Buffer.from(base64, "base64")
}

// ─── Spotlight an element ───

async function spotlightElement(evaluate, selector, caption) {
  return evaluate(`
    (() => {
      // Try to use the Field Trip extension's spotlight system via CustomEvent
      const detail = {
        type: 'spotlight',
        selector: ${JSON.stringify(selector)},
        caption: ${JSON.stringify(caption || "")},
        requestId: 'screenshot-' + Date.now()
      };
      document.dispatchEvent(new CustomEvent('__fieldTrip:command', { detail }));

      // Also add a visual highlight ring as fallback
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };

      const rect = el.getBoundingClientRect();

      // Create highlight overlay
      const overlay = document.createElement('div');
      overlay.id = '__ft-screenshot-highlight';
      overlay.style.cssText = [
        'position: fixed',
        'border: 3px solid #14b8a6',
        'border-radius: 8px',
        'box-shadow: 0 0 0 4px rgba(20, 184, 166, 0.3), 0 0 20px rgba(20, 184, 166, 0.2)',
        'pointer-events: none',
        'z-index: 2147483647',
        'transition: all 0.3s ease',
        'left: ' + (rect.left - 6) + 'px',
        'top: ' + (rect.top - 6) + 'px',
        'width: ' + (rect.width + 12) + 'px',
        'height: ' + (rect.height + 12) + 'px',
      ].join(';');
      document.body.appendChild(overlay);

      // Add caption if provided
      if (${JSON.stringify(!!caption)}) {
        const label = document.createElement('div');
        label.id = '__ft-screenshot-caption';
        label.textContent = ${JSON.stringify(caption || "")};
        label.style.cssText = [
          'position: fixed',
          'background: #0d1117',
          'color: #14b8a6',
          'font-family: -apple-system, system-ui, sans-serif',
          'font-size: 13px',
          'font-weight: 600',
          'padding: 6px 12px',
          'border-radius: 6px',
          'border: 1px solid #14b8a6',
          'z-index: 2147483647',
          'pointer-events: none',
          'white-space: nowrap',
          'left: ' + rect.left + 'px',
          'top: ' + (rect.bottom + 10) + 'px',
        ].join(';');
        document.body.appendChild(label);
      }

      // Scroll element into view
      el.scrollIntoView({ behavior: 'instant', block: 'center' });

      return { found: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60) };
    })()
  `)
}

// ─── Remove highlight ───

async function removeHighlight(evaluate) {
  return evaluate(`
    (() => {
      const h = document.getElementById('__ft-screenshot-highlight');
      if (h) h.remove();
      const c = document.getElementById('__ft-screenshot-caption');
      if (c) c.remove();
      // Also clear Field Trip spotlights
      document.dispatchEvent(new CustomEvent('__fieldTrip:command', {
        detail: { type: 'clear_spotlights', requestId: 'screenshot-clear' }
      }));
    })()
  `)
}

// ─── Main ───

async function main() {
  let connection

  if (flags.relay) {
    console.log("Connecting via relay...")
    connection = await connectRelay()
  } else {
    console.log(`Connecting via CDP (port ${PORT})...`)
    connection = await connectCDP()
  }

  const { send, evaluate } = connection

  // Set viewport if requested
  if (flags.width || flags.height) {
    if (send) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: flags.width || 1440,
        height: flags.height || 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      console.log(`Viewport set to ${flags.width || 1440}x${flags.height || 900}`)
    }
  }

  // Spotlight element if requested
  if (flags.selector) {
    console.log(`Highlighting: ${flags.selector}`)
    const result = await spotlightElement(evaluate, flags.selector, flags.caption)
    if (result && result.found) {
      console.log(`  Found: <${result.tag}> "${result.text}"`)
    } else {
      console.log(`  Warning: element not found — screenshot will be taken without highlight`)
    }
    // Wait for spotlight animation
    const delay = flags.delay || 1500
    await new Promise((r) => setTimeout(r, delay))
  } else {
    // Brief delay for page stability
    const delay = flags.delay || 500
    await new Promise((r) => setTimeout(r, delay))
  }

  // Capture screenshot
  let imageBuffer

  if (send) {
    // CDP mode — full screenshot support
    console.log(flags.fullPage ? "Capturing full page..." : "Capturing viewport...")
    imageBuffer = await captureScreenshotCDP(send, {
      fullPage: flags.fullPage,
      quality: flags.quality,
    })
  } else {
    // Relay mode — limited screenshot support
    imageBuffer = await captureScreenshotRelay(connection.command)
  }

  if (imageBuffer) {
    // Ensure output directory exists
    const dir = dirname(resolve(flags.output))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    writeFileSync(flags.output, imageBuffer)
    console.log(`Screenshot saved: ${flags.output} (${(imageBuffer.length / 1024).toFixed(1)} KB)`)
  }

  // Clean up highlight
  if (flags.selector && !flags.highlight) {
    await removeHighlight(evaluate)
  }

  // Reset viewport
  if ((flags.width || flags.height) && send) {
    await send("Emulation.clearDeviceMetricsOverride")
  }

  // Close connection
  if (connection.isRelay) {
    connection.close()
  } else {
    connection.ws.close()
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})

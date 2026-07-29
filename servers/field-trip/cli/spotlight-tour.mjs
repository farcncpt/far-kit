#!/usr/bin/env node
/**
 * spotlight-tour.mjs — Universal spotlight tour for ANY website.
 * Highlights elements with numbered steps, captions, pulsing rings, and cursor animation.
 * Works through the relay bridge (no CDP needed) or via CDP directly.
 *
 * Usage modes:
 *
 *   Manual steps:
 *     node cli/spotlight-tour.mjs --relay --step "Save:Save your work" --step "#copilot:Ask Copilot"
 *
 *   Auto mode (scan page, highlight key elements):
 *     node cli/spotlight-tour.mjs --relay --auto
 *
 *   From skill document:
 *     node cli/spotlight-tour.mjs --relay --skill src/skills/vercel-deploy.json
 *
 *   Interactive mode (pick from numbered list):
 *     node cli/spotlight-tour.mjs --relay --interactive
 *
 * Flags:
 *   --relay                Use WebSocket relay (default connection)
 *   --port <number>        Relay port (default: 9333) or CDP port (default: 9222)
 *   --delay <ms>           Hold time per step (default: 3000)
 *   --screenshot           Capture screenshot at each step (CDP mode only)
 *   --output <file.json>   Save tour as a skill document JSON for replay
 *   --no-cursor            Skip cursor animation between steps
 *   --no-cleanup           Leave highlights visible after tour ends
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname } from "path"
import http from "http"

// ─── Parse CLI flags ───

const rawArgs = process.argv.slice(2)

function hasFlag(name) {
  return rawArgs.includes(name)
}

function flagValue(name, fallback) {
  const idx = rawArgs.indexOf(name)
  if (idx === -1 || !rawArgs[idx + 1]) return fallback
  return rawArgs[idx + 1]
}

function collectFlags(name) {
  const values = []
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === name && rawArgs[i + 1]) {
      values.push(rawArgs[i + 1])
    }
  }
  return values
}

const useRelay = hasFlag("--relay") || !!process.env.RELAY_MODE
const customPort = flagValue("--port", null)
const holdDelay = parseInt(flagValue("--delay", "3000"))
const doScreenshot = hasFlag("--screenshot")
const outputFile = flagValue("--output", null)
const noCursor = hasFlag("--no-cursor")
const noCleanup = hasFlag("--no-cleanup")
const steps = collectFlags("--step")
const autoMode = hasFlag("--auto")
const interactiveMode = hasFlag("--interactive")
const skillFile = flagValue("--skill", null)

// ─── Help ───

if (hasFlag("--help") || hasFlag("-h") || rawArgs.length === 0) {
  console.log(`
Spotlight Tour — Universal element highlighter for any website

Modes:
  --step "target:caption"     Manual steps (repeat for multiple)
  --auto                      Auto-scan page for key interactive elements
  --skill <file.json>         Replay a skill document with highlights
  --interactive               Scan page, pick elements from numbered list

Connection:
  --relay                     Use WebSocket relay bridge (recommended)
  (default)                   CDP mode (requires CDP_PORT env or --port)

Options:
  --port <number>             Override port (relay: 9333, CDP: 9222)
  --delay <ms>                Hold time per step (default: 3000)
  --screenshot                Capture screenshot at each step (CDP only)
  --output <file.json>        Save tour as a skill document JSON
  --no-cursor                 Skip cursor animation between steps
  --no-cleanup                Leave highlights visible after tour ends

Target resolution (for --step):
  "Save:Caption"              Find by visible text "Save"
  "#myId:Caption"             Find by CSS selector "#myId"
  "[aria-label=X]:Caption"    Find by aria-label attribute
  ".btn-save:Caption"         Find by CSS class

Examples:
  node cli/spotlight-tour.mjs --relay --step "Save:Save your work" --step "Test:Test the flow"
  node cli/spotlight-tour.mjs --relay --auto
  node cli/spotlight-tour.mjs --relay --skill src/skills/vercel-deploy.json
  node cli/spotlight-tour.mjs --relay --interactive --delay 5000
  node cli/spotlight-tour.mjs --relay --auto --output my-tour.json --screenshot
`)
  process.exit(0)
}

// ─── CDP connection ───

const CDP_PORT = customPort ? parseInt(customPort) : parseInt(process.env.CDP_PORT || "9222")

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://")
  )
  if (!page) {
    console.error("No page tab found via CDP")
    process.exit(1)
  }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  let msgId = 0
  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP timeout")), 15000)
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
      const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "eval failed"
      throw new Error(desc)
    }
    return result.result?.value
  }

  async function screenshot(path) {
    const { data } = await send("Page.captureScreenshot", { format: "png" })
    const { writeFileSync: wfs } = await import("fs")
    wfs(path, Buffer.from(data, "base64"))
  }

  return { ws, send, evaluate, screenshot, close: () => ws.close() }
}

// ─── Relay connection ───

async function connectRelayMode() {
  const { connectRelay } = await import("./relay-client.mjs")
  const relay = await connectRelay({
    port: customPort ? parseInt(customPort) : parseInt(process.env.RELAY_PORT || "9333"),
    name: "spotlight-tour",
  })

  if (!relay.isExtensionConnected()) {
    console.error("Warning: Extension relay page not connected yet.")
    console.error("Open the relay page in Chrome: chrome-extension://<extension-id>/src/relay/index.html")
  }

  return relay
}

// ─── Unified driver ───

async function createDriver() {
  if (useRelay) {
    const relay = await connectRelayMode()
    return {
      mode: "relay",
      async evaluate(expr) {
        return relay.command("eval", { expression: expr })
      },
      async screenshot(path) {
        console.error(`  [screenshot skipped — requires CDP mode, not relay]`)
      },
      close() {
        relay.close()
      },
    }
  } else {
    const cdp = await connectCDP()
    return {
      mode: "cdp",
      async evaluate(expr) {
        return cdp.evaluate(expr)
      },
      async screenshot(path) {
        await cdp.screenshot(path)
      },
      close() {
        cdp.close()
      },
    }
  }
}

// ─── Highlight injection code ───

/**
 * Build the JS expression that highlights a single element in the page context.
 * Handles: scroll into view, pulsing ring, numbered badge, caption tooltip,
 * and cleanup of previous highlights.
 */
function buildHighlightExpr(target, caption, stepNum) {
  // target can be a selector or text — the resolve logic runs in-page
  return `
    (async () => {
      // Remove previous highlights
      document.getElementById('__ft-tour-ring')?.remove();
      document.getElementById('__ft-tour-caption')?.remove();
      document.getElementById('__ft-tour-badge')?.remove();
      document.getElementById('__ft-tour-ripple')?.remove();

      // Ensure animation styles exist
      if (!document.getElementById('__ft-tour-styles')) {
        const style = document.createElement('style');
        style.id = '__ft-tour-styles';
        style.textContent = [
          '@keyframes ftTourPulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(20,184,166,0.4), 0 0 20px rgba(20,184,166,0.15); } 50% { box-shadow: 0 0 0 8px rgba(20,184,166,0.2), 0 0 30px rgba(20,184,166,0.1); } }',
          '@keyframes ftTourFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }',
          '@keyframes ftTourRipple { 0% { width: 0; height: 0; opacity: 1; } 100% { width: 60px; height: 60px; opacity: 0; } }',
        ].join('\\n');
        document.head.appendChild(style);
      }

      // ── Resolve element ──
      const target = ${JSON.stringify(target)};
      let el = null;

      // 1. Try as ID (strip leading #)
      if (target.startsWith('#')) {
        el = document.getElementById(target.slice(1));
      }

      // 2. Try as CSS selector
      if (!el) {
        try { el = document.querySelector(target); } catch(e) {}
      }

      // 3. Try aria-label
      if (!el) {
        try { el = document.querySelector('[aria-label=' + JSON.stringify(target) + ']'); } catch(e) {}
      }

      // 4. Try data-testid
      if (!el) {
        try { el = document.querySelector('[data-testid=' + JSON.stringify(target) + ']'); } catch(e) {}
      }

      // 5. Text content search — prioritise buttons/links, then any element
      if (!el) {
        const lower = target.toLowerCase();
        const priority = [...document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"]')];
        const fallback = [...document.querySelectorAll('span, div, label, h1, h2, h3, h4, td, li, p')];
        for (const candidate of [...priority, ...fallback]) {
          const style = getComputedStyle(candidate);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = candidate.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const text = (candidate.textContent || '').trim();
          if (text.length > 300) continue;
          if (text.toLowerCase() === lower || (text.length < 200 && text.toLowerCase().includes(lower))) {
            el = candidate;
            break;
          }
        }
      }

      if (!el) {
        return { found: false, target: target };
      }

      // Scroll into view
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Wait for scroll to settle
      await new Promise(r => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)));
      });

      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // ── Pulsing ring ──
      const ring = document.createElement('div');
      ring.id = '__ft-tour-ring';
      ring.style.cssText = [
        'position: fixed',
        'left: ' + (rect.left - 8) + 'px',
        'top: ' + (rect.top - 8) + 'px',
        'width: ' + (rect.width + 16) + 'px',
        'height: ' + (rect.height + 16) + 'px',
        'border: 3px solid #14b8a6',
        'border-radius: 10px',
        'pointer-events: none',
        'z-index: 2147483647',
        'animation: ftTourPulse 1.5s ease infinite',
        'box-sizing: border-box',
      ].join(';');
      document.body.appendChild(ring);

      // ── Step number badge ──
      const badge = document.createElement('div');
      badge.id = '__ft-tour-badge';
      badge.textContent = '${stepNum}';
      badge.style.cssText = [
        'position: fixed',
        'left: ' + (rect.left - 18) + 'px',
        'top: ' + (rect.top - 18) + 'px',
        'width: 28px',
        'height: 28px',
        'background: #14b8a6',
        'color: #0d1117',
        'font-family: -apple-system, system-ui, sans-serif',
        'font-size: 14px',
        'font-weight: 700',
        'border-radius: 50%',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'pointer-events: none',
        'z-index: 2147483647',
        'animation: ftTourFadeIn 0.3s ease',
        'box-shadow: 0 2px 8px rgba(0,0,0,0.3)',
      ].join(';');
      document.body.appendChild(badge);

      // ── Caption tooltip ──
      const caption = document.createElement('div');
      caption.id = '__ft-tour-caption';
      caption.textContent = ${JSON.stringify(caption)};

      // Position below element, or above if near bottom of viewport
      const nearBottom = rect.bottom + 60 > vh;
      const captionTop = nearBottom
        ? (rect.top - 44) + 'px'
        : (rect.bottom + 12) + 'px';

      caption.style.cssText = [
        'position: fixed',
        'left: ' + Math.max(8, Math.min(rect.left, vw - 300)) + 'px',
        'top: ' + captionTop,
        'background: #0d1117',
        'color: #c9d1d9',
        'font-family: -apple-system, system-ui, sans-serif',
        'font-size: 14px',
        'font-weight: 500',
        'padding: 8px 16px',
        'border-radius: 8px',
        'border: 1px solid #14b8a6',
        'pointer-events: none',
        'z-index: 2147483647',
        'white-space: nowrap',
        'animation: ftTourFadeIn 0.3s ease',
        'box-shadow: 0 4px 12px rgba(0,0,0,0.4)',
        'max-width: 400px',
        'overflow: hidden',
        'text-overflow: ellipsis',
      ].join(';');
      document.body.appendChild(caption);

      // ── Click ripple ──
      const ripple = document.createElement('div');
      ripple.id = '__ft-tour-ripple';
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      ripple.style.cssText = [
        'position: fixed',
        'left: ' + cx + 'px',
        'top: ' + cy + 'px',
        'width: 0',
        'height: 0',
        'border-radius: 50%',
        'border: 2px solid #14b8a6',
        'pointer-events: none',
        'z-index: 2147483647',
        'transform: translate(-50%, -50%)',
        'animation: ftTourRipple 0.6s ease-out forwards',
      ].join(';');
      document.body.appendChild(ripple);

      return {
        found: true,
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
        id: el.id || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    })()
  `
}

/**
 * Build the JS expression for cursor animation from one point to another.
 * Uses quadratic bezier with easing.
 */
function buildCursorAnimExpr(fromRect, toRect, durationMs) {
  // Generate bezier path points
  const from = fromRect
    ? { x: fromRect.x + fromRect.w / 2, y: fromRect.y + fromRect.h / 2 }
    : { x: 0, y: 0 }
  const to = { x: toRect.x + toRect.w / 2, y: toRect.y + toRect.h / 2 }

  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance < 5) return `Promise.resolve(true)` // skip if same spot

  const offset = Math.min(distance * 0.2, 100)
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const perpX = (-dy / distance) * offset
  const perpY = (dx / distance) * offset
  const cp = { x: midX + perpX, y: midY + perpY }

  const numSteps = Math.max(10, Math.floor(distance / 20))
  const points = []
  for (let i = 0; i <= numSteps; i++) {
    const t = i / numSteps
    const inv = 1 - t
    points.push({
      x: Math.round(inv * inv * from.x + 2 * inv * t * cp.x + t * t * to.x),
      y: Math.round(inv * inv * from.y + 2 * inv * t * cp.y + t * t * to.y),
    })
  }

  const dur = durationMs || Math.min(1500, Math.max(300, Math.round(distance)))

  return `
    new Promise((resolve) => {
      // Ensure cursor overlay exists
      if (!document.getElementById('__ft-tour-cursor')) {
        const cursorEl = document.createElement('div');
        cursorEl.id = '__ft-tour-cursor';
        cursorEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 2L4 20L9.5 14.5L15 21L18 19L12.5 12.5L20 10L4 2Z" fill="#14b8a6" stroke="#0d1117" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        cursorEl.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;pointer-events:none;z-index:2147483646;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));will-change:transform;';
        document.body.appendChild(cursorEl);
      }
      const cursor = document.getElementById('__ft-tour-cursor');
      cursor.style.opacity = '1';

      const path = ${JSON.stringify(points)};
      const duration = ${dur};
      const start = performance.now();

      function ease(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }

      function tick(now) {
        const elapsed = now - start;
        const t = Math.min(1, elapsed / duration);
        const et = ease(t);
        const idx = et * (path.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, path.length - 1);
        const frac = idx - lo;
        const x = path[lo].x + (path[hi].x - path[lo].x) * frac;
        const y = path[lo].y + (path[hi].y - path[lo].y) * frac;
        cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          resolve(true);
        }
      }
      requestAnimationFrame(tick);
    })
  `
}

/**
 * Build the JS expression for the auto-scan.
 * Uses dom-simplify Level 1 logic: group visible interactive elements by
 * vertical region, pick the primary action per region.
 */
function buildAutoScanExpr() {
  return `
    (() => {
      const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]';
      const els = document.querySelectorAll(selectors);
      const items = [];

      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.top < -50 || rect.top > window.innerHeight + 50) continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const label = ariaLabel || text;
        if (!label) continue;

        // Build a reliable selector for this element
        let selector = '';
        if (el.id) {
          selector = '#' + CSS.escape(el.id);
        } else if (el.getAttribute('data-testid')) {
          selector = '[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']';
        } else if (ariaLabel) {
          selector = '[aria-label=' + JSON.stringify(ariaLabel) + ']';
        } else if (el.name) {
          selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
        }

        // Score: buttons/links are higher value than inputs
        let score = 0;
        if (['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role') === 'button') score += 10;
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) score += 5;
        if (el.getAttribute('role') === 'tab') score += 8;
        if (el.getAttribute('role') === 'menuitem') score += 7;
        if (style.cursor === 'pointer') score += 2;
        // Larger elements tend to be more important
        if (rect.width > 80 && rect.height > 24) score += 3;

        items.push({
          label: label.slice(0, 80),
          selector,
          tag: el.tagName.toLowerCase(),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          region: Math.floor(rect.top / 150),
          score,
        });
      }

      // Group by region, pick top-scoring element from each
      const regions = new Map();
      for (const item of items) {
        const existing = regions.get(item.region);
        if (!existing || item.score > existing.score) {
          regions.set(item.region, item);
        }
      }

      // Sort by vertical position, limit to 12 steps
      const picks = [...regions.values()]
        .sort((a, b) => a.rect.y - b.rect.y)
        .slice(0, 12);

      return picks;
    })()
  `
}

/**
 * Build the JS for a full interactive scan — returns all visible interactive elements.
 */
function buildInteractiveScanExpr() {
  return `
    (() => {
      const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], h1, h2, h3';
      const els = document.querySelectorAll(selectors);
      const items = [];

      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
        const ariaLabel = el.getAttribute('aria-label') || '';
        const label = ariaLabel || text;
        if (!label) continue;

        let selector = '';
        if (el.id) {
          selector = '#' + CSS.escape(el.id);
        } else if (el.getAttribute('data-testid')) {
          selector = '[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']';
        } else if (ariaLabel) {
          selector = '[aria-label=' + JSON.stringify(ariaLabel) + ']';
        } else if (el.name) {
          selector = el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
        }

        items.push({
          label: label.slice(0, 80),
          selector,
          tag: el.tagName.toLowerCase(),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      }

      // Deduplicate by label, sort by position
      const seen = new Set();
      const unique = [];
      for (const item of items.sort((a, b) => a.rect.y - b.rect.y)) {
        const key = item.label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
      }

      return unique.slice(0, 50);
    })()
  `
}

/**
 * Build the cleanup expression — remove all tour overlays.
 */
function buildCleanupExpr() {
  return `
    (() => {
      document.getElementById('__ft-tour-ring')?.remove();
      document.getElementById('__ft-tour-caption')?.remove();
      document.getElementById('__ft-tour-badge')?.remove();
      document.getElementById('__ft-tour-ripple')?.remove();
      document.getElementById('__ft-tour-cursor')?.remove();
      document.getElementById('__ft-tour-styles')?.remove();
      return 'cleaned up';
    })()
  `
}

// ─── Tour execution engine ───

/**
 * Run a spotlight tour with the given steps.
 * Each step: { target: string, caption: string }
 */
async function runTour(driver, tourSteps) {
  console.log(`\nStarting spotlight tour (${tourSteps.length} steps, ${holdDelay}ms per step)\n`)

  let prevRect = null
  const results = []

  for (let i = 0; i < tourSteps.length; i++) {
    const step = tourSteps[i]
    const stepNum = i + 1
    console.log(`  Step ${stepNum}: ${step.caption || step.target}`)

    // Cursor animation from previous element to current
    if (!noCursor && prevRect && i > 0) {
      // We need the target rect first — peek it
      const peekExpr = `
        (() => {
          const target = ${JSON.stringify(step.target)};
          let el = null;
          if (target.startsWith('#')) el = document.getElementById(target.slice(1));
          if (!el) try { el = document.querySelector(target); } catch(e) {}
          if (!el) try { el = document.querySelector('[aria-label=' + JSON.stringify(target) + ']'); } catch(e) {}
          if (!el) {
            const lower = target.toLowerCase();
            for (const c of document.querySelectorAll('button, a, [role="button"], span, div, label')) {
              const style = getComputedStyle(c);
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              const r = c.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              const t = (c.textContent || '').trim().toLowerCase();
              if (t === lower || (t.length < 200 && t.includes(lower))) { el = c; break; }
            }
          }
          if (!el) return null;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        })()
      `
      const targetRect = await driver.evaluate(peekExpr)
      if (targetRect) {
        const cursorExpr = buildCursorAnimExpr(prevRect, targetRect)
        await driver.evaluate(cursorExpr)
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    // Show highlight
    const highlightExpr = buildHighlightExpr(step.target, step.caption, stepNum)
    const result = await driver.evaluate(highlightExpr)

    if (result && result.found) {
      console.log(`    -> Found: <${result.tag}> "${result.text}"`)
      prevRect = result.rect
      results.push({ ...step, stepNum, result })
    } else {
      console.error(`    -> NOT FOUND: ${step.target}`)
      results.push({ ...step, stepNum, result: { found: false } })
    }

    // Screenshot
    if (doScreenshot && result && result.found) {
      const filename = `spotlight-step-${stepNum}.png`
      try {
        await driver.screenshot(filename)
        console.log(`    -> Screenshot: ${filename}`)
      } catch (err) {
        console.error(`    -> Screenshot failed: ${err.message}`)
      }
    }

    // Hold
    await new Promise((r) => setTimeout(r, holdDelay))
  }

  // Hide cursor
  if (!noCursor) {
    await driver.evaluate(`
      (() => {
        const c = document.getElementById('__ft-tour-cursor');
        if (c) c.style.opacity = '0';
        return true;
      })()
    `)
  }

  // Cleanup
  if (!noCleanup) {
    await driver.evaluate(buildCleanupExpr())
    console.log("\n  Highlights cleaned up.")
  } else {
    console.log("\n  Highlights left visible (--no-cleanup).")
  }

  // Output skill document
  if (outputFile) {
    const skillDoc = {
      id: "spotlight-tour-" + Date.now(),
      name: "Spotlight Tour",
      description: "Auto-generated spotlight tour",
      version: "1.0.0",
      urlPatterns: ["*"],
      author: "spotlight-tour.mjs",
      updatedAt: new Date().toISOString().slice(0, 10),
      steps: results
        .filter((r) => r.result.found)
        .map((r, i) => ({
          id: `step-${i + 1}`,
          title: r.caption,
          description: r.caption,
          target: {
            selector: r.target,
            expectedText: r.result.text || undefined,
          },
          action: { type: "highlight" },
          tooltip: {
            content: r.caption,
            position: "bottom",
          },
        })),
    }

    try {
      mkdirSync(dirname(outputFile), { recursive: true })
    } catch {
      // directory might already exist
    }
    writeFileSync(outputFile, JSON.stringify(skillDoc, null, 2))
    console.log(`\n  Tour saved to: ${outputFile}`)
  }

  return results
}

// ─── Mode: manual steps ───

function parseSteps(stepArgs) {
  return stepArgs.map((s) => {
    const colonIdx = s.indexOf(":")
    if (colonIdx === -1) {
      return { target: s, caption: s }
    }
    return {
      target: s.slice(0, colonIdx),
      caption: s.slice(colonIdx + 1),
    }
  })
}

// ─── Mode: from skill document ───

function loadSkillSteps(file) {
  const skill = JSON.parse(readFileSync(file, "utf-8"))
  console.log(`Loaded skill: ${skill.name} (${skill.steps?.length || 0} steps)`)

  return (skill.steps || []).map((step) => {
    const target = step.target?.selector || step.target?.fallbacks?.[0] || step.title
    const caption = step.tooltip?.content || step.description || step.title
    return { target, caption }
  })
}

// ─── Mode: interactive ───

async function runInteractive(driver) {
  const items = await driver.evaluate(buildInteractiveScanExpr())
  if (!items || items.length === 0) {
    console.error("No interactive elements found on page.")
    return
  }

  console.log(`\nFound ${items.length} interactive elements:\n`)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    console.log(`  ${String(i + 1).padStart(3)}. <${it.tag}> ${it.label}`)
  }

  // Read user input
  const readline = await import("readline")
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const answer = await new Promise((resolve) => {
    rl.question("\nEnter step numbers to highlight (e.g. 1,3,5 or 1-5 or 'all'): ", resolve)
  })
  rl.close()

  let indices = []
  const trimmed = answer.trim().toLowerCase()
  if (trimmed === "all") {
    indices = items.map((_, i) => i)
  } else {
    // Parse comma-separated, with range support
    for (const part of trimmed.split(",")) {
      const p = part.trim()
      if (p.includes("-")) {
        const [a, b] = p.split("-").map((x) => parseInt(x.trim()))
        if (!isNaN(a) && !isNaN(b)) {
          for (let i = a; i <= b; i++) indices.push(i - 1)
        }
      } else {
        const n = parseInt(p)
        if (!isNaN(n)) indices.push(n - 1)
      }
    }
  }

  // Filter valid indices
  indices = indices.filter((i) => i >= 0 && i < items.length)

  if (indices.length === 0) {
    console.log("No valid selections. Exiting.")
    return
  }

  const tourSteps = indices.map((i) => ({
    target: items[i].selector || items[i].label,
    caption: `${items[i].label} (${items[i].tag})`,
  }))

  await runTour(driver, tourSteps)
}

// ─── Main ───

const driver = await createDriver()
console.log(`[${driver.mode} mode] Connected.`)

try {
  if (steps.length > 0) {
    // Manual steps mode
    const tourSteps = parseSteps(steps)
    await runTour(driver, tourSteps)
  } else if (autoMode) {
    // Auto mode — scan and highlight
    console.log("Scanning page for key interactive elements...")
    const items = await driver.evaluate(buildAutoScanExpr())
    if (!items || items.length === 0) {
      console.error("No interactive elements found on page.")
    } else {
      console.log(`Found ${items.length} key elements across page regions.`)
      const tourSteps = items.map((it) => ({
        target: it.selector || it.label,
        caption: `${it.label} (${it.tag})`,
      }))
      await runTour(driver, tourSteps)
    }
  } else if (skillFile) {
    // Skill document mode
    const tourSteps = loadSkillSteps(skillFile)
    if (tourSteps.length === 0) {
      console.error("Skill document has no steps.")
    } else {
      await runTour(driver, tourSteps)
    }
  } else if (interactiveMode) {
    // Interactive mode
    await runInteractive(driver)
  } else {
    console.error("No mode specified. Use --step, --auto, --skill, or --interactive. Try --help.")
  }
} catch (err) {
  console.error(`\nError: ${err.message}`)
  if (process.env.DEBUG) console.error(err.stack)
} finally {
  // Final cleanup attempt
  try {
    if (!noCleanup) {
      await driver.evaluate(buildCleanupExpr())
    }
  } catch {
    // might already be closed
  }
  driver.close()
}

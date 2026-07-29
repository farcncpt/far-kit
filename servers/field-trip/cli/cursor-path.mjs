#!/usr/bin/env node
/**
 * cursor-path.mjs — Generate and test cursor paths via CDP.
 *
 * Usage:
 *   CDP_PORT=9225 node cli/cursor-path.mjs path "#nav-home" "#save-btn"
 *   CDP_PORT=9225 node cli/cursor-path.mjs exec "#name" type "Summer T-Shirt" --then "#price" type "29.99" --then "#save" click
 *   CDP_PORT=9225 node cli/cursor-path.mjs from-skill skills/dzidzor-create-product.json --output cursor-path.json
 *   CDP_PORT=9225 node cli/cursor-path.mjs demo "#nav-home" "#save-btn"
 */

import { readFileSync, writeFileSync } from "fs"
import http from "http"

const PORT = parseInt(process.env.CDP_PORT || "9222")

// ─── CDP connection (same pattern as walkthrough-builder) ───

async function connectCDP(port) {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let d = ""
      res.on("data", (c) => (d += c))
      res.on("end", () => resolve(JSON.parse(d)))
    }).on("error", reject)
  })
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://"))
  if (!page) throw new Error("No page tab found")

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => {
    ws.on("open", r)
    ws.on("error", j)
  })

  let msgId = 0
  const send = (method, params = {}) => {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP timeout")), 30000)
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id === id) {
          ws.off("message", handler)
          clearTimeout(timeout)
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
        }
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || "eval failed")
    return r.result?.value
  }

  return { ws, send, evaluate, close: () => ws.close() }
}

// ─── Path generation (mirrors CursorEngine.generatePath) ───

function generatePath(fromRect, toRect, style = "bezier") {
  const from = {
    x: fromRect.x + fromRect.width / 2,
    y: fromRect.y + fromRect.height / 2,
  }
  const to = {
    x: toRect.x + toRect.width / 2,
    y: toRect.y + toRect.height / 2,
  }

  if (style === "direct") return [from, to]

  if (style === "waypoint") {
    return [from, { x: from.x, y: to.y }, to]
  }

  // Bezier
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance < 1) return [from]

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
  return points
}

function pathDuration(path) {
  if (path.length < 2) return 0
  let dist = 0
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x
    const dy = path[i].y - path[i - 1].y
    dist += Math.sqrt(dx * dx + dy * dy)
  }
  return Math.min(1500, Math.max(300, Math.round(dist)))
}

// ─── Resolve element rect via CDP ───

async function resolveRect(cdp, selector) {
  const result = await cdp.evaluate(`
    (async () => {
      let el;
      try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}
      if (!el) return null;
      // Scroll the element into view first — elements below the viewport fold
      // return inaccurate coordinates from getBoundingClientRect()
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Wait for smooth scroll to settle
      await new Promise(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 350);
          });
        });
      });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()
  `)
  if (!result) throw new Error(`Element not found: ${selector}`)
  return result
}

async function resolveLabel(cdp, selector) {
  return await cdp.evaluate(`
    (() => {
      let el;
      try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}
      if (!el) return ${JSON.stringify(selector)};
      return el.getAttribute('aria-label')
        || el.getAttribute('title')
        || el.getAttribute('placeholder')
        || (el.textContent || '').trim().slice(0, 60)
        || el.tagName.toLowerCase();
    })()
  `)
}

// ─── Visual cursor injection ───

const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 2L4 20L9.5 14.5L15 21L18 19L12.5 12.5L20 10L4 2Z" fill="#14b8a6" stroke="#0d1117" stroke-width="1.5" stroke-linejoin="round"/></svg>`

function buildOverlayInjection() {
  return `
    (() => {
      // Remove previous if re-injected
      document.getElementById('__ft-cursor-overlay')?.remove();

      const container = document.createElement('div');
      container.id = '__ft-cursor-overlay';
      container.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
      document.body.appendChild(container);

      // Cursor element
      const cursor = document.createElement('div');
      cursor.id = '__ft-cursor';
      cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)};
      cursor.style.cssText = 'position:absolute;left:0;top:0;width:24px;height:24px;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.4));transition:none;will-change:transform;';
      container.appendChild(cursor);

      // Trail canvas
      const trail = document.createElement('canvas');
      trail.id = '__ft-cursor-trail';
      trail.width = window.innerWidth;
      trail.height = window.innerHeight;
      trail.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      container.appendChild(trail);

      // Click ripple template
      const ripple = document.createElement('div');
      ripple.id = '__ft-cursor-ripple';
      ripple.style.cssText = 'position:absolute;width:0;height:0;border-radius:50%;border:2px solid #14b8a6;pointer-events:none;opacity:0;transition:none;';
      container.appendChild(ripple);

      // Typing indicator
      const typeIndicator = document.createElement('div');
      typeIndicator.id = '__ft-cursor-typing';
      typeIndicator.style.cssText = 'position:absolute;background:#0d1117;color:#14b8a6;font-family:monospace;font-size:12px;padding:4px 8px;border-radius:4px;border:1px solid #14b8a6;pointer-events:none;opacity:0;white-space:nowrap;';
      container.appendChild(typeIndicator);

      window.__ftCursor = {
        cursor, trail, ripple, typeIndicator, container,
        trailCtx: trail.getContext('2d'),
        trailPoints: [],
      };

      return true;
    })()
  `
}

function buildAnimateScript(path, durationMs, action, value) {
  // Serialize the path and animation params, then run rAF-based animation
  return `
    new Promise((resolve) => {
      const c = window.__ftCursor;
      if (!c) return resolve(false);

      const path = ${JSON.stringify(path)};
      const duration = ${durationMs};
      const action = ${JSON.stringify(action || "click")};
      const value = ${JSON.stringify(value || "")};

      // Clear old trail
      c.trailCtx.clearRect(0, 0, c.trail.width, c.trail.height);
      c.trailPoints = [];

      const start = performance.now();

      function easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      }

      function tick(now) {
        const elapsed = now - start;
        const t = Math.min(1, elapsed / duration);
        const eased = easeInOutCubic(t);

        // Interpolate position along path
        const idx = eased * (path.length - 1);
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, path.length - 1);
        const frac = idx - lo;
        const x = path[lo].x + (path[hi].x - path[lo].x) * frac;
        const y = path[lo].y + (path[hi].y - path[lo].y) * frac;

        // Move cursor
        c.cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';

        // Draw trail
        c.trailPoints.push({ x: x + 4, y: y + 4, time: now });
        // Fade old points
        c.trailCtx.clearRect(0, 0, c.trail.width, c.trail.height);
        const cutoff = now - 600;
        c.trailPoints = c.trailPoints.filter(p => p.time > cutoff);
        if (c.trailPoints.length > 1) {
          for (let i = 1; i < c.trailPoints.length; i++) {
            const age = (now - c.trailPoints[i].time) / 600;
            const alpha = Math.max(0, 0.5 * (1 - age));
            c.trailCtx.beginPath();
            c.trailCtx.moveTo(c.trailPoints[i - 1].x, c.trailPoints[i - 1].y);
            c.trailCtx.lineTo(c.trailPoints[i].x, c.trailPoints[i].y);
            c.trailCtx.strokeStyle = 'rgba(20, 184, 166, ' + alpha + ')';
            c.trailCtx.lineWidth = 2;
            c.trailCtx.stroke();
          }
        }

        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          // Action effects at destination
          const destX = path[path.length - 1].x;
          const destY = path[path.length - 1].y;

          if (action === 'click' || action === 'select') {
            // Click ripple
            c.ripple.style.left = destX + 'px';
            c.ripple.style.top = destY + 'px';
            c.ripple.style.opacity = '1';
            c.ripple.style.width = '0px';
            c.ripple.style.height = '0px';
            c.ripple.style.transform = 'translate(-50%, -50%)';
            c.ripple.style.transition = 'width 0.4s ease-out, height 0.4s ease-out, opacity 0.4s ease-out';
            requestAnimationFrame(() => {
              c.ripple.style.width = '40px';
              c.ripple.style.height = '40px';
              c.ripple.style.opacity = '0';
            });
            setTimeout(() => resolve(true), 500);
          } else if (action === 'type') {
            // Typing indicator
            c.typeIndicator.style.left = (destX + 28) + 'px';
            c.typeIndicator.style.top = (destY - 6) + 'px';
            c.typeIndicator.style.opacity = '1';
            c.typeIndicator.textContent = '';
            let charIdx = 0;
            const typeInterval = setInterval(() => {
              if (charIdx < value.length) {
                c.typeIndicator.textContent += value[charIdx];
                charIdx++;
              } else {
                clearInterval(typeInterval);
                setTimeout(() => {
                  c.typeIndicator.style.opacity = '0';
                  resolve(true);
                }, 400);
              }
            }, 50);
          } else if (action === 'hover') {
            setTimeout(() => resolve(true), 600);
          } else {
            setTimeout(() => resolve(true), 200);
          }
        }
      }

      requestAnimationFrame(tick);
    })
  `
}

function buildCleanupScript() {
  return `
    (() => {
      document.getElementById('__ft-cursor-overlay')?.remove();
      delete window.__ftCursor;
      return true;
    })()
  `
}

// ─── CLI Modes ───

/**
 * path — Generate and display a cursor path between two selectors.
 */
async function modePath(fromSelector, toSelector, style = "bezier") {
  const cdp = await connectCDP(PORT)
  try {
    const fromRect = await resolveRect(cdp, fromSelector)
    const toRect = await resolveRect(cdp, toSelector)
    const fromLabel = await resolveLabel(cdp, fromSelector)
    const toLabel = await resolveLabel(cdp, toSelector)

    const path = generatePath(fromRect, toRect, style)
    const duration = pathDuration(path)

    const step = {
      from: { selector: fromSelector, label: fromLabel },
      to: { selector: toSelector, label: toLabel },
      path,
      action: "click",
      duration,
    }

    const cursorPath = {
      name: `Path: ${fromLabel} → ${toLabel}`,
      description: `Cursor path from ${fromSelector} to ${toSelector}`,
      steps: [step],
      totalDuration: duration,
    }

    console.log(JSON.stringify(cursorPath, null, 2))
    console.log(`\n${path.length} points, ${duration}ms duration, style: ${style}`)
  } finally {
    cdp.close()
  }
}

/**
 * exec — Execute a chain of cursor actions: selector action [value] --then ...
 */
async function modeExec(args) {
  // Parse: selector action [value] [--then selector action [value]] ...
  const chains = []
  let current = []
  for (const arg of args) {
    if (arg === "--then") {
      if (current.length >= 2) chains.push(current)
      current = []
    } else {
      current.push(arg)
    }
  }
  if (current.length >= 2) chains.push(current)

  if (chains.length === 0) {
    console.error("Usage: exec <selector> <action> [value] [--then <selector> <action> [value]] ...")
    process.exit(1)
  }

  const cdp = await connectCDP(PORT)
  try {
    // Inject visual overlay
    await cdp.evaluate(buildOverlayInjection())

    let prevRect = null

    for (let i = 0; i < chains.length; i++) {
      const [selector, action, ...rest] = chains[i]
      const value = rest.join(" ")

      console.log(`  Step ${i + 1}: ${action} ${selector}${value ? " → " + value : ""}`)

      const rect = await resolveRect(cdp, selector)

      // Generate path from previous position (or top-left corner for first)
      const fromRect = prevRect || { x: 0, y: 0, width: 0, height: 0 }
      const path = generatePath(fromRect, rect, "bezier")
      const duration = pathDuration(path)

      // Animate cursor to target + perform action
      await cdp.evaluate(buildAnimateScript(path, duration, action, value))

      // Actually perform the action on the real DOM element
      if (action === "click" || action === "select") {
        await cdp.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) el.click();
          })()
        `)
      } else if (action === "type" && value) {
        await cdp.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return;
            el.focus();
            // React-compatible input: use native setter + input event
            const nativeSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, 'value'
            )?.set || Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, 'value'
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(el, ${JSON.stringify(value)});
            } else {
              el.value = ${JSON.stringify(value)};
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()
        `)
      }

      prevRect = rect
      // Brief pause between steps
      await new Promise((r) => setTimeout(r, 200))
    }

    // Leave cursor visible for a moment, then clean up
    await new Promise((r) => setTimeout(r, 1000))
    await cdp.evaluate(buildCleanupScript())
    console.log("\nExecution complete.")
  } finally {
    cdp.close()
  }
}

/**
 * from-skill — Generate a CursorPath from a skill document.
 */
async function modeFromSkill(skillFile, outputFile) {
  const skill = JSON.parse(readFileSync(skillFile, "utf-8"))
  console.log(`Generating cursor path from skill: ${skill.name}`)

  const cdp = await connectCDP(PORT)
  try {
    const steps = []
    let prevRect = null
    let prevSelector = null
    let prevLabel = null

    for (const step of skill.steps) {
      const selector = step.target?.selector
      if (!selector) continue

      let rect
      try {
        rect = await resolveRect(cdp, selector)
      } catch {
        console.warn(`  Skipping step "${step.title}" — element not found: ${selector}`)
        continue
      }

      const label = await resolveLabel(cdp, selector)
      const fromRect = prevRect || { x: 0, y: 0, width: 0, height: 0 }

      // Use cursor config from skill step if available
      const style = step.cursor?.path || "bezier"
      const path = generatePath(fromRect, rect, style)
      const duration = step.cursor?.duration || pathDuration(path)

      // Map skill action types to cursor actions
      let action = "click"
      let value = undefined
      if (step.action) {
        if (step.action.type === "type") {
          action = "type"
          value = step.action.value
        } else if (step.action.type === "click") {
          action = "click"
        } else if (step.action.type === "hover") {
          action = "hover"
        } else if (step.action.type === "select") {
          action = "select"
          value = step.action.value
        } else if (step.action.type === "scroll") {
          action = "scroll"
        } else if (step.action.type === "drag") {
          action = "drag"
        }
      }

      steps.push({
        from: {
          selector: prevSelector || "viewport:origin",
          label: prevLabel || "Start",
        },
        to: { selector, label },
        path,
        action,
        value,
        duration,
      })

      console.log(`  Step ${steps.length}: ${action} → ${label} (${selector}) — ${duration}ms`)

      prevRect = rect
      prevSelector = selector
      prevLabel = label
    }

    const cursorPath = {
      name: skill.name,
      description: skill.description || `Cursor path for ${skill.name}`,
      steps,
      totalDuration: steps.reduce((sum, s) => sum + s.duration, 0),
    }

    const out = outputFile || "cursor-path.json"
    writeFileSync(out, JSON.stringify(cursorPath, null, 2))
    console.log(`\nCursor path saved: ${out}`)
    console.log(
      `  ${steps.length} steps, total duration: ${cursorPath.totalDuration}ms`
    )
  } finally {
    cdp.close()
  }
}

/**
 * demo — Inject a visual cursor and animate it between two selectors.
 */
async function modeDemo(fromSelector, toSelector, style = "bezier") {
  const cdp = await connectCDP(PORT)
  try {
    const fromRect = await resolveRect(cdp, fromSelector)
    const toRect = await resolveRect(cdp, toSelector)

    const path = generatePath(fromRect, toRect, style)
    const duration = pathDuration(path)

    console.log(`Demo: animating cursor from ${fromSelector} to ${toSelector}`)
    console.log(`  ${path.length} points, ${duration}ms, style: ${style}`)

    // Inject overlay
    await cdp.evaluate(buildOverlayInjection())

    // Animate with click at destination
    await cdp.evaluate(buildAnimateScript(path, duration, "click", ""))

    // Pause so user can see the result
    console.log("  Cursor visible on page. Cleaning up in 3 seconds...")
    await new Promise((r) => setTimeout(r, 3000))

    await cdp.evaluate(buildCleanupScript())
    console.log("  Done.")
  } finally {
    cdp.close()
  }
}

// ─── Main ───

const [, , mode, ...rest] = process.argv

switch (mode) {
  case "path": {
    const [from, to, style] = rest
    if (!from || !to) {
      console.error("Usage: cursor-path.mjs path <fromSelector> <toSelector> [bezier|direct|waypoint]")
      process.exit(1)
    }
    await modePath(from, to, style || "bezier")
    break
  }

  case "exec": {
    if (rest.length < 2) {
      console.error(
        'Usage: cursor-path.mjs exec <selector> <action> [value] [--then <selector> <action> [value]] ...'
      )
      process.exit(1)
    }
    await modeExec(rest)
    break
  }

  case "from-skill": {
    const skillFile = rest[0]
    let outputFile
    const outIdx = rest.indexOf("--output")
    if (outIdx >= 0) outputFile = rest[outIdx + 1]
    if (!skillFile) {
      console.error("Usage: cursor-path.mjs from-skill <skill.json> [--output cursor-path.json]")
      process.exit(1)
    }
    await modeFromSkill(skillFile, outputFile)
    break
  }

  case "demo": {
    const [from, to, style] = rest
    if (!from || !to) {
      console.error("Usage: cursor-path.mjs demo <fromSelector> <toSelector> [bezier|direct|waypoint]")
      process.exit(1)
    }
    await modeDemo(from, to, style || "bezier")
    break
  }

  default:
    console.log(`
Cursor Path — generate, test, and visualize cursor paths via CDP

  path       Generate a CursorPath between two selectors (JSON output)
             node cli/cursor-path.mjs path "#nav-home" "#save-btn"

  exec       Execute cursor actions: move + act at each step (with visual cursor)
             node cli/cursor-path.mjs exec "#name" type "Summer T-Shirt" --then "#price" type "29.99" --then "#save" click

  from-skill Generate a CursorPath from a skill document
             node cli/cursor-path.mjs from-skill skills/create-product.json --output cursor-path.json

  demo       Inject a visual cursor and animate it between two elements
             node cli/cursor-path.mjs demo "#nav-home" "#save-btn"

Environment:
  CDP_PORT   Chrome DevTools Protocol port (default: 9222)
`)
}

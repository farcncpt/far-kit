#!/usr/bin/env node
/**
 * Canvas Intelligence — Render Context Interception CLI
 *
 * For unknown canvas frameworks, injects proxies on CanvasRenderingContext2D
 * methods to build a virtual element map of what's been drawn.
 *
 * Usage:
 *   CDP_PORT=9225 node cli/canvas-render-intercept.mjs inject          # start intercepting
 *   CDP_PORT=9225 node cli/canvas-render-intercept.mjs read             # read intercepted elements
 *   CDP_PORT=9225 node cli/canvas-render-intercept.mjs read --text      # text elements only
 *   CDP_PORT=9225 node cli/canvas-render-intercept.mjs remove           # stop intercepting
 *   CDP_PORT=9225 node cli/canvas-render-intercept.mjs inject --canvas "#my-canvas"
 */

import http from "http"

// ─── Parse args ───

const rawArgs = process.argv.slice(2)

let canvasSelector = null
const canvasIdx = rawArgs.indexOf("--canvas")
if (canvasIdx !== -1 && rawArgs[canvasIdx + 1]) {
  canvasSelector = rawArgs[canvasIdx + 1]
}

const textOnly = rawArgs.includes("--text")

const filteredArgs = rawArgs.filter((a, i) =>
  a !== "--canvas" &&
  a !== "--text" &&
  (canvasIdx === -1 || i !== canvasIdx + 1)
)

const [cmd] = filteredArgs

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`
Canvas Intelligence — Render Context Interception

Commands:
  inject       Inject render interception proxies on the canvas 2D context
  read         Read all intercepted draw elements
  read --text  Read only text elements
  remove       Remove interception, restore original context methods

Flags:
  --canvas <selector>  Target a specific canvas (default: first canvas)

Environment:
  CDP_PORT  Chrome DevTools Protocol port (default: 9222)
`)
  process.exit(0)
}

// ─── CDP connection ───

const CDP_PORT = parseInt(process.env.CDP_PORT || "9222")

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const page = targets.find(
    (t) =>
      t.type === "page" &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("devtools://")
  )
  if (!page) {
    console.error("No page tab found")
    process.exit(1)
  }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    perMessageDeflate: false,
  })
  await new Promise((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  let msgId = 0
  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("CDP timeout")),
        15000
      )
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
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "eval failed"
      throw new Error(desc)
    }
    return result.result?.value
  }

  return { ws, send, evaluate, page }
}

// ─── Injection expression ───

const INJECT_INTERCEPT = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { success: false, error: 'Canvas not found: ' + canvasSelector }

  const ctx = canvas.getContext('2d')
  if (!ctx) return { success: false, error: 'No 2D rendering context available' }

  // Avoid double injection
  if (canvas.__canvasIntelligenceIntercepted) {
    return { success: true, alreadyInjected: true, elementCount: (canvas.__canvasIntelligenceElements || []).length }
  }

  const elements = []
  canvas.__canvasIntelligenceElements = elements
  canvas.__canvasIntelligenceIntercepted = true

  // Store original methods
  const originals = {
    fillText: ctx.fillText.bind(ctx),
    strokeText: ctx.strokeText.bind(ctx),
    fillRect: ctx.fillRect.bind(ctx),
    strokeRect: ctx.strokeRect.bind(ctx),
    fill: ctx.fill.bind(ctx),
    stroke: ctx.stroke.bind(ctx),
    drawImage: ctx.drawImage.bind(ctx),
    clearRect: ctx.clearRect.bind(ctx),
    beginPath: ctx.beginPath.bind(ctx),
    moveTo: ctx.moveTo.bind(ctx),
    lineTo: ctx.lineTo.bind(ctx),
    arc: ctx.arc.bind(ctx),
  }
  canvas.__canvasIntelligenceOriginals = originals

  // Path tracking state
  let currentPath = null
  let pathMinX = Infinity, pathMinY = Infinity, pathMaxX = -Infinity, pathMaxY = -Infinity

  function updatePathBounds(x, y) {
    pathMinX = Math.min(pathMinX, x)
    pathMinY = Math.min(pathMinY, y)
    pathMaxX = Math.max(pathMaxX, x)
    pathMaxY = Math.max(pathMaxY, y)
  }

  function resetPathBounds() {
    pathMinX = Infinity
    pathMinY = Infinity
    pathMaxX = -Infinity
    pathMaxY = -Infinity
  }

  // Intercept path operations
  ctx.beginPath = (...args) => {
    currentPath = { type: 'path', segments: [], timestamp: Date.now() }
    resetPathBounds()
    originals.beginPath(...args)
  }

  ctx.moveTo = (x, y) => {
    if (currentPath) {
      currentPath.segments.push({ op: 'moveTo', x: Math.round(x), y: Math.round(y) })
      updatePathBounds(x, y)
    }
    originals.moveTo(x, y)
  }

  ctx.lineTo = (x, y) => {
    if (currentPath) {
      currentPath.segments.push({ op: 'lineTo', x: Math.round(x), y: Math.round(y) })
      updatePathBounds(x, y)
    }
    originals.lineTo(x, y)
  }

  ctx.arc = (x, y, radius, startAngle, endAngle, ccw) => {
    if (currentPath) {
      currentPath.segments.push({
        op: 'arc',
        x: Math.round(x), y: Math.round(y),
        radius: Math.round(radius),
      })
      updatePathBounds(x - radius, y - radius)
      updatePathBounds(x + radius, y + radius)
    }
    originals.arc(x, y, radius, startAngle, endAngle, ccw)
  }

  // Intercept text drawing
  ctx.fillText = (text, x, y, maxWidth) => {
    elements.push({
      type: 'text',
      text: String(text),
      x: Math.round(x),
      y: Math.round(y),
      font: ctx.font,
      color: String(ctx.fillStyle),
      textAlign: ctx.textAlign,
      textBaseline: ctx.textBaseline,
      timestamp: Date.now(),
    })
    originals.fillText(text, x, y, maxWidth)
  }

  ctx.strokeText = (text, x, y, maxWidth) => {
    elements.push({
      type: 'text',
      text: String(text),
      x: Math.round(x),
      y: Math.round(y),
      font: ctx.font,
      color: String(ctx.strokeStyle),
      textAlign: ctx.textAlign,
      textBaseline: ctx.textBaseline,
      stroked: true,
      timestamp: Date.now(),
    })
    originals.strokeText(text, x, y, maxWidth)
  }

  // Intercept rectangle drawing
  ctx.fillRect = (x, y, w, h) => {
    elements.push({
      type: 'rect',
      x: Math.round(x), y: Math.round(y),
      width: Math.round(w), height: Math.round(h),
      color: String(ctx.fillStyle),
      filled: true,
      timestamp: Date.now(),
    })
    originals.fillRect(x, y, w, h)
  }

  ctx.strokeRect = (x, y, w, h) => {
    elements.push({
      type: 'rect',
      x: Math.round(x), y: Math.round(y),
      width: Math.round(w), height: Math.round(h),
      color: String(ctx.strokeStyle),
      filled: false,
      lineWidth: ctx.lineWidth,
      timestamp: Date.now(),
    })
    originals.strokeRect(x, y, w, h)
  }

  // Intercept path fill/stroke
  ctx.fill = (...args) => {
    if (currentPath && currentPath.segments.length > 0) {
      currentPath.color = String(ctx.fillStyle)
      currentPath.filled = true
      currentPath.bounds = {
        x: Math.round(pathMinX), y: Math.round(pathMinY),
        width: Math.round(pathMaxX - pathMinX), height: Math.round(pathMaxY - pathMinY),
      }
      elements.push({ ...currentPath })
    }
    originals.fill(...args)
  }

  ctx.stroke = (...args) => {
    if (currentPath && currentPath.segments.length > 0) {
      currentPath.color = String(ctx.strokeStyle)
      currentPath.filled = false
      currentPath.lineWidth = ctx.lineWidth
      currentPath.bounds = {
        x: Math.round(pathMinX), y: Math.round(pathMinY),
        width: Math.round(pathMaxX - pathMinX), height: Math.round(pathMaxY - pathMinY),
      }
      elements.push({ ...currentPath })
    }
    originals.stroke(...args)
  }

  // Intercept image drawing
  ctx.drawImage = (img, ...args) => {
    const x = args[0] || 0, y = args[1] || 0
    const w = args[2] || img.width || 0, h = args[3] || img.height || 0
    elements.push({
      type: 'image',
      x: Math.round(x), y: Math.round(y),
      width: Math.round(w), height: Math.round(h),
      src: img.src?.slice(0, 200) || 'inline',
      timestamp: Date.now(),
    })
    originals.drawImage(img, ...args)
  }

  // Intercept clear (frame boundary detection)
  ctx.clearRect = (x, y, w, h) => {
    // If clearing the full canvas, new frame — reset elements
    if (x === 0 && y === 0 && w >= canvas.width && h >= canvas.height) {
      elements.length = 0
    }
    originals.clearRect(x, y, w, h)
  }

  // Store restore function
  canvas.__canvasIntelligenceRestore = () => {
    ctx.fillText = originals.fillText
    ctx.strokeText = originals.strokeText
    ctx.fillRect = originals.fillRect
    ctx.strokeRect = originals.strokeRect
    ctx.fill = originals.fill
    ctx.stroke = originals.stroke
    ctx.drawImage = originals.drawImage
    ctx.clearRect = originals.clearRect
    ctx.beginPath = originals.beginPath
    ctx.moveTo = originals.moveTo
    ctx.lineTo = originals.lineTo
    ctx.arc = originals.arc
    delete canvas.__canvasIntelligenceElements
    delete canvas.__canvasIntelligenceIntercepted
    delete canvas.__canvasIntelligenceOriginals
    delete canvas.__canvasIntelligenceRestore
  }

  return { success: true, injected: true }
})
`

// ─── Read intercepted elements ───

const READ_ELEMENTS = `
((canvasSelector, textOnly) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { error: 'Canvas not found: ' + canvasSelector }

  if (!canvas.__canvasIntelligenceIntercepted) {
    return { error: 'No interception active. Run inject first.' }
  }

  const raw = canvas.__canvasIntelligenceElements || []

  // Filter text-only if requested
  let filtered = textOnly ? raw.filter(e => e.type === 'text') : [...raw]

  // Group related draw calls into logical elements
  // A rect followed closely by text = a "labeled box"
  const grouped = []
  const used = new Set()

  for (let i = 0; i < filtered.length; i++) {
    if (used.has(i)) continue

    const el = filtered[i]

    if (el.type === 'rect' && el.filled) {
      // Look for text elements that fall inside or near this rect
      const nearbyText = []
      for (let j = 0; j < filtered.length; j++) {
        if (used.has(j) || j === i) continue
        const other = filtered[j]
        if (other.type !== 'text') continue
        // Check if text is within or near the rect bounds
        if (other.x >= el.x - 10 && other.x <= el.x + el.width + 10 &&
            other.y >= el.y - 10 && other.y <= el.y + el.height + 10) {
          nearbyText.push({ index: j, element: other })
        }
      }

      if (nearbyText.length > 0) {
        // Merge into a labeled box
        used.add(i)
        for (const nt of nearbyText) used.add(nt.index)
        grouped.push({
          type: 'labeled-box',
          x: el.x, y: el.y,
          width: el.width, height: el.height,
          backgroundColor: el.color,
          labels: nearbyText.map(nt => ({
            text: nt.element.text,
            x: nt.element.x, y: nt.element.y,
            font: nt.element.font,
            color: nt.element.color,
          })),
        })
        continue
      }
    }

    grouped.push(el)
    used.add(i)
  }

  return {
    canvasSelector,
    rawCount: raw.length,
    filteredCount: filtered.length,
    groupedCount: grouped.length,
    elements: grouped.slice(0, 500),
  }
})
`

// ─── Remove interception ───

const REMOVE_INTERCEPT = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { success: false, error: 'Canvas not found: ' + canvasSelector }

  if (!canvas.__canvasIntelligenceIntercepted) {
    return { success: false, error: 'No interception active on this canvas' }
  }

  const elementCount = (canvas.__canvasIntelligenceElements || []).length

  // Call the stored restore function
  if (typeof canvas.__canvasIntelligenceRestore === 'function') {
    canvas.__canvasIntelligenceRestore()
  }

  return { success: true, removed: true, elementsCapturedBeforeRemoval: elementCount }
})
`

// ─── Main ───

async function main() {
  console.error(
    `[canvas-render-intercept] Connecting to CDP on port ${CDP_PORT}...`
  )
  const { ws, evaluate } = await connectCDP()

  try {
    // Resolve canvas selector
    let sel = canvasSelector
    if (!sel) {
      sel = await evaluate(`
        (() => {
          const c = document.querySelector('canvas')
          if (!c) return null
          if (c.id) return '#' + c.id
          return 'canvas'
        })()
      `)
      if (!sel) {
        console.error(
          "[canvas-render-intercept] No canvas element found on page"
        )
        process.exit(1)
      }
    }
    console.error(`[canvas-render-intercept] Using canvas: ${sel}`)

    switch (cmd) {
      case "inject": {
        console.error("[canvas-render-intercept] Injecting render interception...")
        const result = await evaluate(
          `(${INJECT_INTERCEPT})(${JSON.stringify(sel)})`
        )
        if (result.alreadyInjected) {
          console.error(
            "[canvas-render-intercept] Already injected. Elements captured so far: " +
              result.elementCount
          )
        } else if (result.success) {
          console.error(
            "[canvas-render-intercept] Interception injected successfully."
          )
          console.error(
            "[canvas-render-intercept] Interact with the canvas to trigger re-renders, then run 'read' to see captured elements."
          )
        } else {
          console.error(
            `[canvas-render-intercept] Failed: ${result.error}`
          )
        }
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case "read": {
        const result = await evaluate(
          `(${READ_ELEMENTS})(${JSON.stringify(sel)}, ${textOnly})`
        )
        if (result.error) {
          console.error(
            `[canvas-render-intercept] ${result.error}`
          )
        } else {
          console.error(
            `[canvas-render-intercept] Raw: ${result.rawCount}, Filtered: ${result.filteredCount}, Grouped: ${result.groupedCount}`
          )
        }
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case "remove": {
        console.error("[canvas-render-intercept] Removing interception...")
        const result = await evaluate(
          `(${REMOVE_INTERCEPT})(${JSON.stringify(sel)})`
        )
        console.log(JSON.stringify(result, null, 2))
        break
      }

      default:
        console.error(`Unknown command: ${cmd}`)
        console.error("Commands: inject, read, remove")
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(`[canvas-render-intercept] Error: ${err.message}`)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * Canvas Intelligence — Interaction CLI
 *
 * Interacts with canvas elements: click, drag, read element at coordinates,
 * and list all canvas elements using framework APIs or hit testing.
 *
 * Usage:
 *   CDP_PORT=9225 node cli/canvas-interact.mjs click 200 300           # click at x=200 y=300
 *   CDP_PORT=9225 node cli/canvas-interact.mjs drag 200 100 200 300    # drag from (200,100) to (200,300)
 *   CDP_PORT=9225 node cli/canvas-interact.mjs read 200 300            # what's at this coordinate?
 *   CDP_PORT=9225 node cli/canvas-interact.mjs list                    # list all canvas elements
 *   CDP_PORT=9225 node cli/canvas-interact.mjs list --framework gojs   # use framework-specific API
 *   CDP_PORT=9225 node cli/canvas-interact.mjs click 200 300 --canvas "#my-canvas"
 */

import http from "http"

// ─── Parse args ───

const rawArgs = process.argv.slice(2)

let canvasSelector = null
const canvasIdx = rawArgs.indexOf("--canvas")
if (canvasIdx !== -1 && rawArgs[canvasIdx + 1]) {
  canvasSelector = rawArgs[canvasIdx + 1]
}

let frameworkHint = null
const fwIdx = rawArgs.indexOf("--framework")
if (fwIdx !== -1 && rawArgs[fwIdx + 1]) {
  frameworkHint = rawArgs[fwIdx + 1]
}

const filteredArgs = rawArgs.filter((a, i) =>
  a !== "--canvas" &&
  a !== "--framework" &&
  (canvasIdx === -1 || i !== canvasIdx + 1) &&
  (fwIdx === -1 || i !== fwIdx + 1)
)

const [cmd, ...cmdArgs] = filteredArgs

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`
Canvas Intelligence — Interaction CLI

Commands:
  click <x> <y>                    Click at canvas coordinates
  drag <x1> <y1> <x2> <y2>        Drag from (x1,y1) to (x2,y2)
  read <x> <y>                     Read element at coordinates
  list                             List all canvas elements

Flags:
  --canvas <selector>              Target a specific canvas (default: first canvas)
  --framework <name>               Use framework-specific API (konva, fabric, gojs, etc.)

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

// ─── Canvas interaction expressions ───

/**
 * Resolve the canvas selector — use provided or find the first one.
 */
function resolveCanvasExpr(sel) {
  if (sel) return JSON.stringify(sel)
  return `(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    if (c.id) return '#' + c.id
    return 'canvas'
  })()`
}

/**
 * Click at canvas coordinates by dispatching a full mouse event sequence.
 */
const CLICK_AT = `
((canvasSelector, x, y) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { success: false, error: 'Canvas not found: ' + canvasSelector }

  const rect = canvas.getBoundingClientRect()
  const clientX = rect.left + x
  const clientY = rect.top + y

  const opts = { bubbles: true, cancelable: true, clientX, clientY, button: 0 }

  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }))
  canvas.dispatchEvent(new MouseEvent('mousedown', opts))
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }))
  canvas.dispatchEvent(new MouseEvent('mouseup', opts))
  canvas.dispatchEvent(new MouseEvent('click', opts))

  return { success: true, canvasSelector, x, y, clientX: Math.round(clientX), clientY: Math.round(clientY) }
})
`

/**
 * Drag from one canvas coordinate to another.
 * Dispatches mousedown at start, multiple mousemoves along the path, mouseup at end.
 */
const DRAG_BETWEEN = `
((canvasSelector, x1, y1, x2, y2) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { success: false, error: 'Canvas not found: ' + canvasSelector }

  const rect = canvas.getBoundingClientRect()
  const startX = rect.left + x1
  const startY = rect.top + y1
  const endX = rect.left + x2
  const endY = rect.top + y2

  // Mousedown at start
  const downOpts = { bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0 }
  canvas.dispatchEvent(new PointerEvent('pointerdown', { ...downOpts, pointerId: 1, pointerType: 'mouse' }))
  canvas.dispatchEvent(new MouseEvent('mousedown', downOpts))

  // Generate intermediate moves (10 steps)
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const cx = startX + (endX - startX) * t
    const cy = startY + (endY - startY) * t
    const moveOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 }
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...moveOpts, pointerId: 1, pointerType: 'mouse' }))
    canvas.dispatchEvent(new MouseEvent('mousemove', moveOpts))
  }

  // Mouseup at end
  const upOpts = { bubbles: true, cancelable: true, clientX: endX, clientY: endY, button: 0 }
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...upOpts, pointerId: 1, pointerType: 'mouse' }))
  canvas.dispatchEvent(new MouseEvent('mouseup', upOpts))

  return {
    success: true,
    canvasSelector,
    from: { x: x1, y: y1 },
    to: { x: x2, y: y2 },
  }
})
`

/**
 * Read what's at a given canvas coordinate.
 * Tries: framework-specific hit testing, then render interception data, then pixel color.
 */
const READ_AT = `
((canvasSelector, x, y, frameworkHint) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { error: 'Canvas not found' }

  const results = { x, y, elements: [] }

  // Try framework-specific hit testing
  try {
    // GoJS
    if ((frameworkHint === 'gojs' || window.go) && window.go) {
      const diagDiv = canvas.closest('[data-gojs-diagram]') || canvas.parentElement
      const diag = window.go.Diagram.fromDiv?.(diagDiv)
      if (diag) {
        const docPoint = diag.transformViewToDoc(new window.go.Point(x, y))
        const parts = diag.findObjectsAt(docPoint)
        parts.each(part => {
          const node = part.part
          if (node) {
            results.elements.push({
              type: node instanceof window.go.Node ? 'node' : node instanceof window.go.Link ? 'link' : 'part',
              label: node.data?.text || node.data?.label || node.data?.key || '',
              category: node.data?.category,
              key: node.data?.key,
              selected: node.isSelected,
              source: 'gojs-hit-test',
            })
          }
        })
      }
    }

    // Konva
    if ((frameworkHint === 'konva' || window.Konva) && window.Konva) {
      const stage = window.Konva.stages?.[0]
      if (stage) {
        const shape = stage.getIntersection({ x, y })
        if (shape) {
          results.elements.push({
            type: shape.className || 'Shape',
            label: shape.text?.() || shape.name?.() || '',
            id: shape.id?.(),
            source: 'konva-hit-test',
          })
        }
      }
    }

    // Fabric.js
    if ((frameworkHint === 'fabric' || canvas.fabric) && canvas.fabric) {
      const fc = canvas.fabric
      const targets = fc.getObjects().filter(obj => {
        return x >= obj.left && x <= obj.left + obj.width &&
               y >= obj.top && y <= obj.top + obj.height
      })
      for (const obj of targets) {
        results.elements.push({
          type: obj.type || 'object',
          label: obj.text || obj.name || '',
          source: 'fabric-bounds-test',
        })
      }
    }

    // Excalidraw
    if ((frameworkHint === 'excalidraw' || window.excalidrawAPI) && window.excalidrawAPI) {
      const sceneElements = window.excalidrawAPI.getSceneElements()
      for (const el of sceneElements) {
        if (x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height) {
          results.elements.push({
            type: el.type,
            label: el.text || '',
            id: el.id,
            source: 'excalidraw-bounds-test',
          })
        }
      }
    }

  } catch (err) {
    results.frameworkError = err.message
  }

  // Check render interception data
  if (canvas.__canvasIntelligenceElements) {
    const intercepted = canvas.__canvasIntelligenceElements
    for (const el of intercepted) {
      let hit = false
      if (el.type === 'text') {
        hit = Math.abs(el.x - x) < 60 && Math.abs(el.y - y) < 20
      } else if (el.type === 'rect' || el.type === 'image') {
        hit = x >= el.x && x <= el.x + (el.width || 0) && y >= el.y && y <= el.y + (el.height || 0)
      }
      if (hit) {
        results.elements.push({ ...el, source: 'render-interception' })
      }
    }
  }

  // Fallback: read pixel color
  try {
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const pixel = ctx.getImageData(x, y, 1, 1).data
      results.pixelColor = {
        r: pixel[0], g: pixel[1], b: pixel[2], a: pixel[3],
        hex: '#' + ((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1),
        isEmpty: pixel[3] === 0,
      }
    }
  } catch (err) {
    results.pixelError = err.message
  }

  return results
})
`

/**
 * List all canvas elements. Re-uses the framework element reader from canvas-detect.
 */
const LIST_ELEMENTS = `
((canvasSelector, frameworkHint) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { error: 'Canvas not found' }

  const result = { canvasSelector, elements: [], source: 'unknown' }

  try {
    // GoJS
    if ((frameworkHint === 'gojs' || window.go) && window.go) {
      const diagDiv = canvas.closest('[data-gojs-diagram]') || canvas.parentElement
      const diag = window.go.Diagram.fromDiv?.(diagDiv)
      if (diag) {
        result.source = 'gojs'
        diag.nodes.each(node => {
          const loc = node.location
          const bounds = node.actualBounds
          result.elements.push({
            type: 'node',
            label: node.data?.text || node.data?.label || node.data?.key || '',
            x: Math.round(loc?.x || bounds?.x || 0),
            y: Math.round(loc?.y || bounds?.y || 0),
            width: Math.round(bounds?.width || 0),
            height: Math.round(bounds?.height || 0),
            category: node.data?.category,
            key: node.data?.key,
            selected: node.isSelected,
          })
        })
        diag.links.each(link => {
          result.elements.push({
            type: 'link',
            from: link.data?.from,
            to: link.data?.to,
            label: link.data?.text || '',
          })
        })
        return result
      }
    }

    // Konva
    if ((frameworkHint === 'konva' || window.Konva) && window.Konva) {
      const stage = window.Konva.stages?.[0]
      if (stage) {
        result.source = 'konva'
        for (const node of stage.find('*')) {
          result.elements.push({
            type: node.className || node.nodeType,
            label: node.text?.() || node.name?.() || '',
            x: Math.round(node.x?.() || 0),
            y: Math.round(node.y?.() || 0),
            width: Math.round(node.width?.() || 0),
            height: Math.round(node.height?.() || 0),
            visible: node.visible?.() !== false,
            id: node.id?.() || undefined,
          })
        }
        return result
      }
    }

    // Fabric.js
    if ((frameworkHint === 'fabric' || canvas.fabric) && canvas.fabric) {
      const fc = canvas.fabric
      result.source = 'fabric'
      for (const obj of fc.getObjects()) {
        result.elements.push({
          type: obj.type || 'object',
          label: obj.text || obj.name || '',
          x: Math.round(obj.left || 0),
          y: Math.round(obj.top || 0),
          width: Math.round(obj.width || 0),
          height: Math.round(obj.height || 0),
          visible: obj.visible !== false,
          selectable: obj.selectable !== false,
        })
      }
      return result
    }

    // Excalidraw
    if ((frameworkHint === 'excalidraw' || window.excalidrawAPI) && window.excalidrawAPI) {
      result.source = 'excalidraw'
      for (const el of window.excalidrawAPI.getSceneElements()) {
        result.elements.push({
          type: el.type,
          label: el.text || '',
          x: Math.round(el.x),
          y: Math.round(el.y),
          width: Math.round(el.width),
          height: Math.round(el.height),
          id: el.id,
        })
      }
      return result
    }

    // Chart.js
    if ((frameworkHint === 'chartjs' || window.Chart) && window.Chart) {
      const chart = window.Chart.getChart?.(canvas)
      if (chart) {
        result.source = 'chartjs'
        const datasets = chart.data?.datasets || []
        for (const ds of datasets) {
          result.elements.push({
            type: 'dataset',
            label: ds.label || '',
            dataPoints: ds.data?.length || 0,
          })
        }
        return result
      }
    }

    // Paper.js
    if ((frameworkHint === 'paper' || window.paper) && window.paper) {
      result.source = 'paper'
      const items = window.paper.project?.activeLayer?.children || []
      for (const item of items) {
        result.elements.push({
          type: item.className || 'item',
          label: item.name || '',
          x: Math.round(item.bounds?.x || 0),
          y: Math.round(item.bounds?.y || 0),
          width: Math.round(item.bounds?.width || 0),
          height: Math.round(item.bounds?.height || 0),
        })
      }
      return result
    }

    // mxGraph
    if ((frameworkHint === 'mxgraph' || window.mxGraph || window.mxClient)) {
      const graphEl = canvas.parentElement
      const graph = graphEl?.mxGraph || graphEl?.graph
      if (graph) {
        result.source = 'mxgraph'
        const model = graph.getModel()
        const cells = model.cells || {}
        for (const cell of Object.values(cells)) {
          if (cell.vertex || cell.edge) {
            result.elements.push({
              type: cell.vertex ? 'vertex' : 'edge',
              label: cell.value?.toString?.() || '',
              id: cell.id,
              x: cell.geometry?.x || 0,
              y: cell.geometry?.y || 0,
              width: cell.geometry?.width || 0,
              height: cell.geometry?.height || 0,
            })
          }
        }
        return result
      }
    }

    // PixiJS
    if ((frameworkHint === 'pixi' || window.PIXI) && window.PIXI) {
      const app = canvas.__pixiApp || window.__PIXI_APP__
      if (app) {
        result.source = 'pixi'
        function walkPIXI(container, depth) {
          if (depth > 5 || result.elements.length > 200) return
          for (const child of (container.children || [])) {
            result.elements.push({
              type: child.constructor?.name || 'DisplayObject',
              label: child.name || child.text || '',
              x: Math.round(child.x || 0),
              y: Math.round(child.y || 0),
              width: Math.round(child.width || 0),
              height: Math.round(child.height || 0),
              visible: child.visible !== false,
            })
            if (child.children?.length) walkPIXI(child, depth + 1)
          }
        }
        walkPIXI(app.stage, 0)
        return result
      }
    }

    // Render interception fallback
    if (canvas.__canvasIntelligenceElements) {
      result.source = 'render-interception'
      result.elements = [...canvas.__canvasIntelligenceElements]
      return result
    }

    // Accessibility tree fallback
    const ariaOwns = canvas.getAttribute('aria-owns')
    if (ariaOwns) {
      result.source = 'accessibility-tree'
      const owned = ariaOwns.split(' ').map(id => document.getElementById(id)).filter(Boolean)
      for (const el of owned) {
        result.elements.push({
          role: el.getAttribute('role'),
          label: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 100),
          selected: el.getAttribute('aria-selected') === 'true',
        })
      }
      return result
    }

    // Check parent for accessible layer
    const parent = canvas.parentElement
    if (parent) {
      const accessibleLayer = parent.querySelector('[role="application"], [role="grid"], [role="tree"], [role="listbox"]')
      if (accessibleLayer && accessibleLayer !== canvas) {
        result.source = 'accessibility-tree'
        const items = accessibleLayer.querySelectorAll('[role]')
        for (const el of items) {
          result.elements.push({
            role: el.getAttribute('role'),
            label: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 100),
            selected: el.getAttribute('aria-selected') === 'true',
          })
        }
        return result
      }
    }

    result.source = 'none'
    result.message = 'No framework detected and no render interception data. Run canvas-detect.mjs --intercept first.'

  } catch (err) {
    result.error = err.message
  }

  return result
})
`

// ─── Main ───

async function main() {
  console.error(`[canvas-interact] Connecting to CDP on port ${CDP_PORT}...`)
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
        console.error("[canvas-interact] No canvas element found on page")
        process.exit(1)
      }
    }
    console.error(`[canvas-interact] Using canvas: ${sel}`)

    switch (cmd) {
      case "click": {
        const x = parseFloat(cmdArgs[0])
        const y = parseFloat(cmdArgs[1])
        if (isNaN(x) || isNaN(y)) {
          console.error("Usage: click <x> <y>")
          process.exit(1)
        }
        const result = await evaluate(
          `(${CLICK_AT})(${JSON.stringify(sel)}, ${x}, ${y})`
        )
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case "drag": {
        const x1 = parseFloat(cmdArgs[0])
        const y1 = parseFloat(cmdArgs[1])
        const x2 = parseFloat(cmdArgs[2])
        const y2 = parseFloat(cmdArgs[3])
        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) {
          console.error("Usage: drag <x1> <y1> <x2> <y2>")
          process.exit(1)
        }
        const result = await evaluate(
          `(${DRAG_BETWEEN})(${JSON.stringify(sel)}, ${x1}, ${y1}, ${x2}, ${y2})`
        )
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case "read": {
        const x = parseFloat(cmdArgs[0])
        const y = parseFloat(cmdArgs[1])
        if (isNaN(x) || isNaN(y)) {
          console.error("Usage: read <x> <y>")
          process.exit(1)
        }
        const result = await evaluate(
          `(${READ_AT})(${JSON.stringify(sel)}, ${x}, ${y}, ${JSON.stringify(frameworkHint)})`
        )
        console.log(JSON.stringify(result, null, 2))
        break
      }

      case "list": {
        const result = await evaluate(
          `(${LIST_ELEMENTS})(${JSON.stringify(sel)}, ${JSON.stringify(frameworkHint)})`
        )
        console.log(JSON.stringify(result, null, 2))
        break
      }

      default:
        console.error(`Unknown command: ${cmd}`)
        console.error("Commands: click, drag, read, list")
        process.exit(1)
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(`[canvas-interact] Error: ${err.message}`)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * Canvas Intelligence — Detection & API Discovery CLI
 *
 * Connects via CDP and discovers all <canvas> elements, their frameworks,
 * exposed APIs, accessibility trees, and element data.
 *
 * Usage:
 *   CDP_PORT=9225 node cli/canvas-detect.mjs                     # detect all canvases
 *   CDP_PORT=9225 node cli/canvas-detect.mjs --intercept          # also inject render interception
 *   CDP_PORT=9225 node cli/canvas-detect.mjs --output report.json # save to file
 */

import http from "http"
import fs from "fs"

// ─── Parse flags ───

const rawArgs = process.argv.slice(2)
const doIntercept = rawArgs.includes("--intercept")
let outputFile = null
const outputIdx = rawArgs.indexOf("--output")
if (outputIdx !== -1 && rawArgs[outputIdx + 1]) {
  outputFile = rawArgs[outputIdx + 1]
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(`
Canvas Intelligence — Detection & API Discovery

Usage:
  CDP_PORT=9225 node cli/canvas-detect.mjs                     detect all canvases
  CDP_PORT=9225 node cli/canvas-detect.mjs --intercept          also inject render interception
  CDP_PORT=9225 node cli/canvas-detect.mjs --output report.json save report to file

Environment:
  CDP_PORT  Chrome DevTools Protocol port (default: 9222)
`)
  process.exit(0)
}

// ─── CDP connection (same pattern as tt.mjs) ───

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

// ─── Canvas detection expressions ───

const DETECT_PAGE_FRAMEWORK = `
(() => {
  // React
  const bodyKeys = Object.keys(document.body || {})
  const hasReactFiber = bodyKeys.some(k => k.startsWith('__reactFiber'))
  const hasReactRoot = !!document.querySelector('[data-reactroot]')
  if (hasReactFiber || hasReactRoot) {
    const ver = window.React?.version || 'unknown'
    return { name: 'react', version: ver }
  }
  // Vue 3
  if (window.__VUE__) return { name: 'vue', version: '3' }
  // Vue 2
  if (document.querySelector('[data-v-]') && !window.__VUE__) return { name: 'vue', version: '2' }
  // Angular
  if (window.ng || document.querySelector('[ng-version]') || document.querySelector('[_nghost-]'))
    return { name: 'angular', version: document.querySelector('[ng-version]')?.getAttribute('ng-version') || 'unknown' }
  // Svelte
  if (document.querySelector('[class*="svelte-"]')) return { name: 'svelte', version: 'unknown' }
  // Lit
  if (window.litElementVersions) return { name: 'lit', version: 'unknown' }
  return { name: 'vanilla', version: null }
})()
`

const FIND_CANVASES = `
(() => {
  const canvases = document.querySelectorAll('canvas')
  return Array.from(canvases).map((c, i) => {
    const rect = c.getBoundingClientRect()
    let selector = ''
    if (c.id) selector = '#' + c.id
    else if (c.className) selector = 'canvas.' + c.className.toString().split(/\\s+/).join('.')
    else selector = 'canvas:nth-of-type(' + (i + 1) + ')'
    return {
      selector,
      index: i,
      size: { width: c.width || Math.round(rect.width), height: c.height || Math.round(rect.height) },
      boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      hasContext2d: !!c.__ctx2d || !!c.getContext('2d'),
      hasWebGL: !!(c.getContext('webgl') || c.getContext('webgl2')),
    }
  })
})()
`

const DETECT_CANVAS_FRAMEWORK = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { name: 'not-found', confidence: 'none', access: null }

  // Konva.js
  if (window.Konva || canvas._konvaNode) {
    const stageCount = window.Konva?.stages?.length || 0
    return { name: 'konva', confidence: 'high', access: 'Konva.stages[0].find("*")', stageCount }
  }

  // Fabric.js
  if (window.fabric || canvas.fabric) {
    return { name: 'fabric', confidence: 'high', access: 'canvas.fabric.getObjects()' }
  }

  // PixiJS
  if (window.PIXI || canvas.__pixiApp) {
    return { name: 'pixi', confidence: 'high', access: 'app.stage.children' }
  }

  // Three.js
  if (window.THREE || window.__THREE__) {
    return { name: 'three', confidence: 'high', access: 'scene.children (recursive)' }
  }

  // Paper.js
  if (window.paper) {
    return { name: 'paper', confidence: 'high', access: 'paper.project.activeLayer.children' }
  }

  // Chart.js
  if (window.Chart) {
    try {
      const chart = window.Chart.getChart?.(canvas)
      if (chart) return { name: 'chartjs', confidence: 'high', access: 'Chart.getChart(canvas).data' }
    } catch {}
    return { name: 'chartjs', confidence: 'medium', access: 'Chart.getChart(canvas).data' }
  }

  // GoJS
  if (window.go) {
    // GoJS creates a div container with a canvas inside
    const diagDiv = canvas.closest('[data-gojs-diagram]') || canvas.parentElement
    try {
      const diag = window.go.Diagram.fromDiv?.(diagDiv)
      if (diag) return { name: 'gojs', confidence: 'high', access: 'diagram.model.nodeDataArray' }
    } catch {}
    return { name: 'gojs', confidence: 'medium', access: 'go.Diagram.fromDiv(container).model.nodeDataArray' }
  }

  // mxGraph / draw.io
  if (window.mxGraph || window.mxClient) {
    return { name: 'mxgraph', confidence: 'high', access: 'graph.getModel().cells' }
  }

  // Excalidraw
  if (document.querySelector('[data-excalidraw]') || window.excalidrawAPI) {
    return { name: 'excalidraw', confidence: 'high', access: 'excalidrawAPI.getSceneElements()' }
  }

  // React Flow / XYFlow
  if (document.querySelector('.react-flow') || document.querySelector('.xy-flow')) {
    return { name: 'reactflow', confidence: 'high', access: 'React fiber → store.getState().nodes' }
  }

  // Check canvas expando properties for clues
  const expandoKeys = Object.keys(canvas).filter(k => !k.startsWith('__'))
  if (expandoKeys.length > 0) {
    return { name: 'unknown', confidence: 'low', access: 'expando properties: ' + expandoKeys.join(', '), expandoKeys }
  }

  return { name: 'unknown', confidence: 'none', access: 'render interception required' }
})
`

const DISCOVER_APIS = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  const apis = []

  // Check window for known API patterns
  const apiPatterns = [
    /^(editor|designer|builder|diagram|flow|canvas|board|stage)/i,
    /API$/i, /SDK$/i, /Instance$/i, /Manager$/i,
  ]

  const windowKeys = Object.getOwnPropertyNames(window)
  for (const key of windowKeys) {
    if (!apiPatterns.some(p => p.test(key))) continue
    try {
      const val = window[key]
      if (val && typeof val === 'object') {
        const proto = Object.getPrototypeOf(val)
        const methods = proto
          ? Object.getOwnPropertyNames(proto).filter(m => {
              try { return typeof val[m] === 'function' && !m.startsWith('_') && m !== 'constructor' } catch { return false }
            }).slice(0, 20)
          : []
        const ownMethods = Object.getOwnPropertyNames(val).filter(m => {
          try { return typeof val[m] === 'function' && !m.startsWith('_') } catch { return false }
        }).slice(0, 20)
        apis.push({
          source: 'window.' + key,
          type: typeof val,
          methods: [...new Set([...methods, ...ownMethods])].slice(0, 25),
        })
      }
    } catch {}
  }

  // Check canvas element expando properties
  if (canvas) {
    const canvasKeys = Object.keys(canvas).filter(k => !k.startsWith('__'))
    for (const key of canvasKeys) {
      try {
        const val = canvas[key]
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(val) || {})
            .filter(m => { try { return typeof val[m] === 'function' && m !== 'constructor' } catch { return false } })
            .slice(0, 15)
          apis.push({ source: 'canvas.' + key, type: typeof val, methods })
        }
      } catch {}
    }
  }

  return apis
})
`

const WALK_REACT_FIBER = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return []

  const reactKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber'))
  if (!reactKey) return []

  const components = []
  let fiber = canvas[reactKey]
  let depth = 0

  while (fiber && depth < 30) {
    const name = fiber.type?.name || fiber.type?.displayName || null
    const hasState = !!(fiber.memoizedState || fiber.stateNode?.state)
    const hasProps = !!fiber.memoizedProps

    if (name || hasState) {
      const entry = {
        depth,
        component: name || 'anonymous',
        hasState,
        hasProps,
      }

      // Try to extract prop keys (not values, to avoid serialization issues)
      if (fiber.memoizedProps && typeof fiber.memoizedProps === 'object') {
        entry.propKeys = Object.keys(fiber.memoizedProps).filter(k => k !== 'children').slice(0, 15)
      }

      // Check if this component has canvas-related state
      if (hasState && fiber.memoizedState) {
        const stateKeys = []
        let st = fiber.memoizedState
        let hookIdx = 0
        while (st && hookIdx < 10) {
          if (st.queue || st.memoizedState !== undefined) {
            stateKeys.push('hook_' + hookIdx)
          }
          st = st.next
          hookIdx++
        }
        if (stateKeys.length > 0) entry.stateHooks = stateKeys.length
      }

      components.push(entry)
    }
    fiber = fiber.return
    depth++
  }

  return components
})
`

const READ_ACCESSIBILITY_TREE = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return null

  const results = []

  // Check aria-owns
  const ariaOwns = canvas.getAttribute('aria-owns')
  if (ariaOwns) {
    const owned = ariaOwns.split(' ').map(id => document.getElementById(id)).filter(Boolean)
    for (const el of owned) {
      results.push({
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 100),
        selected: el.getAttribute('aria-selected') === 'true',
        expanded: el.getAttribute('aria-expanded'),
        level: el.getAttribute('aria-level'),
      })
    }
  }

  // Check sibling/child accessible layers
  const parent = canvas.parentElement
  if (parent) {
    const accessibleLayer = parent.querySelector('[role="application"], [role="grid"], [role="tree"], [role="listbox"]')
    if (accessibleLayer && accessibleLayer !== canvas) {
      const items = accessibleLayer.querySelectorAll('[role]')
      for (const el of items) {
        results.push({
          role: el.getAttribute('role'),
          label: el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 100),
          selected: el.getAttribute('aria-selected') === 'true',
          expanded: el.getAttribute('aria-expanded'),
          level: el.getAttribute('aria-level'),
        })
      }
    }
  }

  // Check canvas own ARIA attributes
  const canvasRole = canvas.getAttribute('role')
  const canvasLabel = canvas.getAttribute('aria-label')
  if (canvasRole || canvasLabel) {
    results.unshift({
      role: canvasRole,
      label: canvasLabel,
      self: true,
    })
  }

  return results.length > 0 ? results : null
})
`

const READ_FRAMEWORK_ELEMENTS = `
((canvasSelector, frameworkName) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return []

  try {
    // Konva
    if (frameworkName === 'konva' && window.Konva) {
      const stage = window.Konva.stages?.[0]
      if (!stage) return []
      return stage.find('*').map(node => ({
        type: node.className || node.nodeType,
        label: node.text?.() || node.name?.() || '',
        x: Math.round(node.x?.() || 0),
        y: Math.round(node.y?.() || 0),
        width: Math.round(node.width?.() || 0),
        height: Math.round(node.height?.() || 0),
        visible: node.visible?.() !== false,
        id: node.id?.() || undefined,
      })).slice(0, 200)
    }

    // Fabric.js
    if (frameworkName === 'fabric' && (canvas.fabric || window.fabric)) {
      const fc = canvas.fabric || canvas.__fabricCanvas
      if (!fc) return []
      return fc.getObjects().map(obj => ({
        type: obj.type || 'object',
        label: obj.text || obj.name || '',
        x: Math.round(obj.left || 0),
        y: Math.round(obj.top || 0),
        width: Math.round(obj.width || 0),
        height: Math.round(obj.height || 0),
        visible: obj.visible !== false,
        selectable: obj.selectable !== false,
      })).slice(0, 200)
    }

    // GoJS
    if (frameworkName === 'gojs' && window.go) {
      const diagDiv = canvas.closest('[data-gojs-diagram]') || canvas.parentElement
      const diag = window.go.Diagram.fromDiv?.(diagDiv)
      if (!diag) return []
      const nodes = []
      diag.nodes.each(node => {
        const loc = node.location
        const bounds = node.actualBounds
        nodes.push({
          type: 'node',
          label: node.data?.text || node.data?.label || node.data?.key || '',
          x: Math.round(loc?.x || bounds?.x || 0),
          y: Math.round(loc?.y || bounds?.y || 0),
          width: Math.round(bounds?.width || 0),
          height: Math.round(bounds?.height || 0),
          category: node.data?.category || undefined,
          key: node.data?.key,
          selected: node.isSelected,
        })
      })
      const links = []
      diag.links.each(link => {
        links.push({
          type: 'link',
          from: link.data?.from,
          to: link.data?.to,
          label: link.data?.text || '',
        })
      })
      return [...nodes, ...links].slice(0, 200)
    }

    // Excalidraw
    if (frameworkName === 'excalidraw' && window.excalidrawAPI) {
      const elements = window.excalidrawAPI.getSceneElements()
      return elements.map(el => ({
        type: el.type,
        label: el.text || '',
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width),
        height: Math.round(el.height),
        id: el.id,
        strokeColor: el.strokeColor,
        backgroundColor: el.backgroundColor,
      })).slice(0, 200)
    }

    // Chart.js
    if (frameworkName === 'chartjs' && window.Chart) {
      const chart = window.Chart.getChart?.(canvas)
      if (!chart) return []
      const datasets = chart.data?.datasets || []
      return datasets.map((ds, i) => ({
        type: 'dataset',
        label: ds.label || 'Dataset ' + i,
        dataPoints: ds.data?.length || 0,
        backgroundColor: typeof ds.backgroundColor === 'string' ? ds.backgroundColor : undefined,
        borderColor: typeof ds.borderColor === 'string' ? ds.borderColor : undefined,
      }))
    }

    // Paper.js
    if (frameworkName === 'paper' && window.paper) {
      const items = window.paper.project?.activeLayer?.children || []
      return items.map(item => ({
        type: item.className || 'item',
        label: item.name || '',
        x: Math.round(item.bounds?.x || 0),
        y: Math.round(item.bounds?.y || 0),
        width: Math.round(item.bounds?.width || 0),
        height: Math.round(item.bounds?.height || 0),
      })).slice(0, 200)
    }

    // mxGraph
    if (frameworkName === 'mxgraph' && (window.mxGraph || window.mxClient)) {
      // mxGraph typically stores graph instance on a container element
      const graphEl = canvas.parentElement
      if (graphEl?.mxGraph || graphEl?.graph) {
        const graph = graphEl.mxGraph || graphEl.graph
        const model = graph.getModel()
        const cells = model.cells || {}
        return Object.values(cells).filter(c => c.vertex || c.edge).map(cell => ({
          type: cell.vertex ? 'vertex' : 'edge',
          label: cell.value?.toString?.() || '',
          id: cell.id,
          x: cell.geometry?.x || 0,
          y: cell.geometry?.y || 0,
          width: cell.geometry?.width || 0,
          height: cell.geometry?.height || 0,
        })).slice(0, 200)
      }
      return []
    }

    // PixiJS
    if (frameworkName === 'pixi' && window.PIXI) {
      const app = canvas.__pixiApp || window.__PIXI_APP__
      if (!app) return []
      const items = []
      function walkPIXI(container, depth) {
        if (depth > 5 || items.length > 200) return
        for (const child of (container.children || [])) {
          items.push({
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
      return items.slice(0, 200)
    }

  } catch (err) {
    return [{ error: err.message }]
  }

  return []
})
`

// ─── Render interception injection ───

const INJECT_RENDER_INTERCEPT = `
((canvasSelector) => {
  const canvas = document.querySelector(canvasSelector)
  if (!canvas) return { success: false, error: 'Canvas not found' }

  const ctx = canvas.getContext('2d')
  if (!ctx) return { success: false, error: 'No 2D context' }

  // Avoid double injection
  if (canvas.__canvasIntelligenceIntercepted) return { success: true, alreadyInjected: true }

  const elements = []
  canvas.__canvasIntelligenceElements = elements
  canvas.__canvasIntelligenceIntercepted = true

  const origFillText = ctx.fillText.bind(ctx)
  const origStrokeText = ctx.strokeText.bind(ctx)
  const origFillRect = ctx.fillRect.bind(ctx)
  const origStrokeRect = ctx.strokeRect.bind(ctx)
  const origFill = ctx.fill.bind(ctx)
  const origStroke = ctx.stroke.bind(ctx)
  const origDrawImage = ctx.drawImage.bind(ctx)
  const origClearRect = ctx.clearRect.bind(ctx)
  const origBeginPath = ctx.beginPath.bind(ctx)
  const origMoveTo = ctx.moveTo.bind(ctx)
  const origLineTo = ctx.lineTo.bind(ctx)
  const origArc = ctx.arc.bind(ctx)

  let currentPath = null

  ctx.beginPath = (...args) => {
    currentPath = { type: 'path', segments: [], timestamp: Date.now() }
    origBeginPath(...args)
  }
  ctx.moveTo = (x, y) => {
    if (currentPath) currentPath.segments.push({ op: 'moveTo', x, y })
    origMoveTo(x, y)
  }
  ctx.lineTo = (x, y) => {
    if (currentPath) currentPath.segments.push({ op: 'lineTo', x, y })
    origLineTo(x, y)
  }
  ctx.arc = (x, y, r, startAngle, endAngle, ccw) => {
    if (currentPath) currentPath.segments.push({ op: 'arc', x, y, radius: r })
    origArc(x, y, r, startAngle, endAngle, ccw)
  }

  ctx.fillText = (text, x, y, maxWidth) => {
    elements.push({ type: 'text', text, x, y, font: ctx.font, color: ctx.fillStyle, timestamp: Date.now() })
    origFillText(text, x, y, maxWidth)
  }
  ctx.strokeText = (text, x, y, maxWidth) => {
    elements.push({ type: 'text', text, x, y, font: ctx.font, color: ctx.strokeStyle, timestamp: Date.now() })
    origStrokeText(text, x, y, maxWidth)
  }
  ctx.fillRect = (x, y, w, h) => {
    elements.push({ type: 'rect', x, y, width: w, height: h, color: ctx.fillStyle, filled: true, timestamp: Date.now() })
    origFillRect(x, y, w, h)
  }
  ctx.strokeRect = (x, y, w, h) => {
    elements.push({ type: 'rect', x, y, width: w, height: h, color: ctx.strokeStyle, filled: false, timestamp: Date.now() })
    origStrokeRect(x, y, w, h)
  }
  ctx.fill = (...args) => {
    if (currentPath) {
      currentPath.color = ctx.fillStyle
      currentPath.filled = true
      elements.push({ ...currentPath })
    }
    origFill(...args)
  }
  ctx.stroke = (...args) => {
    if (currentPath) {
      currentPath.color = ctx.strokeStyle
      currentPath.filled = false
      elements.push({ ...currentPath })
    }
    origStroke(...args)
  }
  ctx.drawImage = (img, ...args) => {
    const x = args[0] || 0, y = args[1] || 0
    const w = args[2] || img.width, h = args[3] || img.height
    elements.push({ type: 'image', x, y, width: w, height: h, src: img.src || 'inline', timestamp: Date.now() })
    origDrawImage(img, ...args)
  }
  ctx.clearRect = (x, y, w, h) => {
    if (x === 0 && y === 0 && w >= canvas.width && h >= canvas.height) {
      elements.length = 0
    }
    origClearRect(x, y, w, h)
  }

  // Store restore function
  canvas.__canvasIntelligenceRestore = () => {
    ctx.fillText = origFillText
    ctx.strokeText = origStrokeText
    ctx.fillRect = origFillRect
    ctx.strokeRect = origStrokeRect
    ctx.fill = origFill
    ctx.stroke = origStroke
    ctx.drawImage = origDrawImage
    ctx.clearRect = origClearRect
    ctx.beginPath = origBeginPath
    ctx.moveTo = origMoveTo
    ctx.lineTo = origLineTo
    ctx.arc = origArc
    delete canvas.__canvasIntelligenceElements
    delete canvas.__canvasIntelligenceIntercepted
    delete canvas.__canvasIntelligenceRestore
  }

  return { success: true, injected: true }
})
`

// ─── Main ───

async function main() {
  console.error(`[canvas-detect] Connecting to CDP on port ${CDP_PORT}...`)
  const { ws, evaluate } = await connectCDP()

  try {
    // Step 1: Detect page framework
    console.error("[canvas-detect] Detecting page framework...")
    const pageFramework = await evaluate(DETECT_PAGE_FRAMEWORK)

    // Step 2: Find all canvas elements
    console.error("[canvas-detect] Scanning for canvas elements...")
    const canvases = await evaluate(FIND_CANVASES)

    if (!canvases || canvases.length === 0) {
      const report = {
        canvasElements: [],
        pageFramework,
        hasCanvas: false,
      }
      console.log(JSON.stringify(report, null, 2))
      if (outputFile) {
        fs.writeFileSync(outputFile, JSON.stringify(report, null, 2))
        console.error(`[canvas-detect] Report saved to ${outputFile}`)
      }
      ws.close()
      return
    }

    console.error(
      `[canvas-detect] Found ${canvases.length} canvas element(s)`
    )

    // Step 3: For each canvas, detect framework, discover APIs, read accessibility
    const canvasElements = []

    for (const canvasInfo of canvases) {
      const sel = canvasInfo.selector
      console.error(`[canvas-detect] Analyzing ${sel}...`)

      // Detect framework
      const framework = await evaluate(
        `(${DETECT_CANVAS_FRAMEWORK})(${JSON.stringify(sel)})`
      )

      // Discover APIs
      const apis = await evaluate(
        `(${DISCOVER_APIS})(${JSON.stringify(sel)})`
      )

      // Walk React fiber tree
      const reactComponents = await evaluate(
        `(${WALK_REACT_FIBER})(${JSON.stringify(sel)})`
      )

      // Read accessibility tree
      const accessibilityTree = await evaluate(
        `(${READ_ACCESSIBILITY_TREE})(${JSON.stringify(sel)})`
      )

      // Read framework-specific elements
      let elements = []
      if (framework.name !== "unknown" && framework.name !== "not-found") {
        elements = await evaluate(
          `(${READ_FRAMEWORK_ELEMENTS})(${JSON.stringify(sel)}, ${JSON.stringify(framework.name)})`
        )
      }

      // Inject render interception if requested and framework is unknown
      if (doIntercept && framework.name === "unknown") {
        console.error(
          `[canvas-detect] Injecting render interception for ${sel}...`
        )
        const interceptResult = await evaluate(
          `(${INJECT_RENDER_INTERCEPT})(${JSON.stringify(sel)})`
        )
        if (interceptResult?.success) {
          console.error(
            `[canvas-detect] Interception injected. Re-render the canvas to capture elements.`
          )
          // Wait a moment for any ongoing renders to be captured
          await new Promise((r) => setTimeout(r, 1000))
          // Read intercepted elements
          const interceptedElements = await evaluate(`
            (() => {
              const c = document.querySelector(${JSON.stringify(sel)})
              return c?.__canvasIntelligenceElements || []
            })()
          `)
          if (interceptedElements?.length > 0) {
            elements = interceptedElements
          }
        }
      }

      const entry = {
        selector: sel,
        size: canvasInfo.size,
        boundingRect: canvasInfo.boundingRect,
        framework,
        apis: apis || [],
        reactComponents:
          reactComponents?.length > 0 ? reactComponents : undefined,
        accessibilityTree: accessibilityTree || undefined,
        elements: elements || [],
      }

      canvasElements.push(entry)
    }

    const report = {
      canvasElements,
      pageFramework,
      hasCanvas: true,
    }

    console.log(JSON.stringify(report, null, 2))

    if (outputFile) {
      fs.writeFileSync(outputFile, JSON.stringify(report, null, 2))
      console.error(`[canvas-detect] Report saved to ${outputFile}`)
    }
  } finally {
    ws.close()
  }
}

main().catch((err) => {
  console.error(`[canvas-detect] Error: ${err.message}`)
  process.exit(1)
})

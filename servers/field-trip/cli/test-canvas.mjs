#!/usr/bin/env node
/**
 * Test canvas detection on Excalidraw or any canvas-heavy page.
 * Navigates to the URL, waits for load, then runs canvas detection.
 */
import { connectRelay } from "./relay-client.mjs"

const url = process.argv[2] || "https://excalidraw.com"
const relay = await connectRelay({ port: 9333, name: "canvas-test" })

console.log(`Navigating to ${url}...`)
await relay.command("navigate", { url })
console.log("Waiting for page to load...")
await new Promise(r => setTimeout(r, 5000))

const pageInfo = await relay.command("page")
console.log(`Page: ${pageInfo.title}`)
console.log(`URL: ${pageInfo.url}\n`)

// Detect canvases
console.log("=== CANVAS DETECTION ===\n")
const canvasInfo = await relay.command("eval", {
  expression: `
    (() => {
      const canvases = document.querySelectorAll('canvas');
      if (canvases.length === 0) return { hasCanvas: false, message: 'No canvas elements found' };

      const results = [];
      for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        const info = {
          id: canvas.id || undefined,
          className: (canvas.className || '').toString().slice(0, 60) || undefined,
          size: { width: canvas.width, height: canvas.height },
          displaySize: { width: Math.round(rect.width), height: Math.round(rect.height) },
          visible: rect.width > 0 && rect.height > 0,
        };

        // Check for known frameworks
        // Excalidraw
        if (document.querySelector('[data-excalidraw]') || document.querySelector('.excalidraw')) {
          info.framework = 'excalidraw';
          info.confidence = 'high';
        }
        // Konva
        if (canvas._konvaNode || window.Konva) {
          info.framework = 'konva';
          info.confidence = 'high';
        }
        // Fabric.js
        if (canvas.fabric || window.fabric) {
          info.framework = 'fabric';
          info.confidence = 'high';
        }
        // GoJS
        if (window.go) {
          info.framework = 'gojs';
          info.confidence = 'high';
        }

        // Check for expando properties
        const expandos = Object.keys(canvas).filter(k => !k.startsWith('__') && k !== 'style');
        if (expandos.length > 0) info.expandoKeys = expandos.slice(0, 10);

        // Check React fiber
        const reactKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber'));
        if (reactKey) {
          info.hasReactFiber = true;
          let fiber = canvas[reactKey];
          let depth = 0;
          const components = [];
          while (fiber && depth < 15) {
            if (fiber.type && typeof fiber.type === 'function') {
              const name = fiber.type.name || fiber.type.displayName;
              if (name) components.push(name);
            }
            fiber = fiber.return;
            depth++;
          }
          if (components.length) info.reactComponents = components;
        }

        results.push(info);
      }

      // Check for APIs on window
      const apiKeys = [];
      const patterns = ['editor', 'designer', 'excalidraw', 'canvas', 'diagram', 'board', 'stage', 'scene'];
      for (const key of Object.keys(window)) {
        const lower = key.toLowerCase();
        if (patterns.some(p => lower.includes(p)) && typeof window[key] === 'object' && window[key] !== null) {
          const methods = [];
          try {
            const proto = Object.getPrototypeOf(window[key]);
            if (proto) {
              methods.push(...Object.getOwnPropertyNames(proto).filter(m => typeof window[key][m] === 'function' && !m.startsWith('_') && m !== 'constructor').slice(0, 10));
            }
          } catch(e) {}
          apiKeys.push({ key: key, type: typeof window[key], methods: methods.length ? methods : undefined });
        }
      }

      // Check for accessibility tree near canvas
      const a11y = [];
      for (const canvas of canvases) {
        const parent = canvas.parentElement;
        if (parent) {
          const roles = parent.querySelectorAll('[role]');
          for (const el of roles) {
            if (el === canvas) continue;
            a11y.push({
              role: el.getAttribute('role'),
              label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60),
            });
          }
        }
      }

      return {
        hasCanvas: true,
        count: canvases.length,
        canvases: results,
        windowAPIs: apiKeys.length ? apiKeys : undefined,
        accessibilityElements: a11y.length ? a11y.slice(0, 20) : undefined,
      };
    })()
  `
})

console.log(JSON.stringify(canvasInfo, null, 2))

// Also scan the DOM elements (toolbar, menus, etc.)
console.log("\n=== DOM ELEMENTS (non-canvas UI) ===\n")
const scan = await relay.command("scan", { maxItems: 30 })
if (Array.isArray(scan)) {
  for (const el of scan) {
    const parts = [`<${el.tag}>`]
    if (el.id) parts.push(`id="${el.id}"`)
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
    if (el.role) parts.push(`role="${el.role}"`)
    if (el.clickable) parts.push('[clickable]')
    if (el.text) parts.push(`"${el.text.slice(0, 50)}"`)
    console.log('  ' + parts.join(' '))
  }
} else {
  console.log("  Scan returned:", typeof scan, JSON.stringify(scan)?.slice(0, 200))
}

relay.close()
console.log("\nDone!")

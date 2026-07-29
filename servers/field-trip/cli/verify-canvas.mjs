#!/usr/bin/env node
/** Verify what's on the Excalidraw canvas by reading scene elements */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "verify" })

const result = await relay.command("eval", {
  expression: `
    (() => {
      const appEl = document.querySelector('.excalidraw');
      const reactKey = Object.keys(appEl).find(k => k.startsWith('__reactFiber'));
      let fiber = appEl[reactKey];
      let depth = 0;

      while (fiber && depth < 50) {
        if (fiber.stateNode && typeof fiber.stateNode.getSceneElements === 'function') {
          const els = fiber.stateNode.getSceneElements();
          return {
            count: els.length,
            elements: els.map(e => ({
              id: (e.id || '').slice(0, 15),
              type: e.type,
              x: Math.round(e.x),
              y: Math.round(e.y),
              width: Math.round(e.width || 0),
              height: Math.round(e.height || 0),
              text: e.text || undefined,
              strokeColor: e.strokeColor || undefined,
              backgroundColor: e.backgroundColor || undefined,
            }))
          };
        }
        fiber = fiber.return;
        depth++;
      }
      return { error: 'getSceneElements not found', depth };
    })()
  `
})

console.log("=== Canvas Elements ===")
console.log(JSON.stringify(result, null, 2))

if (result?.elements) {
  console.log(`\nTotal: ${result.count} elements on canvas`)
  for (const el of result.elements) {
    const parts = [`[${el.type}]`]
    if (el.text) parts.push(`"${el.text}"`)
    parts.push(`at (${el.x}, ${el.y})`)
    if (el.width) parts.push(`${el.width}x${el.height}`)
    if (el.strokeColor) parts.push(`color: ${el.strokeColor}`)
    console.log(`  ${parts.join(' ')}`)
  }
}

relay.close()

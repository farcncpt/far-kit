#!/usr/bin/env node
/** Fix text rendering on Excalidraw — use proper element properties */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "excalidraw-text" })
console.log("Connected. Adding text to Excalidraw...\n")

const result = await relay.command("eval", {
  expression: `
    (() => {
      const appEl = document.querySelector('.excalidraw');
      const reactKey = Object.keys(appEl).find(k => k.startsWith('__reactFiber'));
      let fiber = appEl[reactKey];
      let depth = 0;
      let app = null;

      while (fiber && depth < 50) {
        if (fiber.stateNode && typeof fiber.stateNode.getSceneElements === 'function') {
          app = fiber.stateNode;
          break;
        }
        fiber = fiber.return;
        depth++;
      }

      if (!app) return { error: 'App not found' };

      // Get existing elements
      const existing = app.getSceneElements();

      // Clear old elements and create fresh ones
      const now = Date.now();
      const seed1 = Math.floor(Math.random() * 2147483647);
      const seed2 = Math.floor(Math.random() * 2147483647);
      const seed3 = Math.floor(Math.random() * 2147483647);
      const seed4 = Math.floor(Math.random() * 2147483647);

      const newElements = [
        // Big teal rectangle
        {
          id: 'ft-rect-' + now,
          type: 'rectangle',
          x: 250,
          y: 150,
          width: 300,
          height: 150,
          angle: 0,
          strokeColor: '#14b8a6',
          backgroundColor: 'rgba(20, 184, 166, 0.15)',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          index: 'a0',
          roundness: { type: 3 },
          seed: seed1,
          version: 1,
          versionNonce: seed1,
          isDeleted: false,
          boundElements: null,
          updated: now,
          link: null,
          locked: false,
        },
        // Second rectangle
        {
          id: 'ft-rect2-' + now,
          type: 'rectangle',
          x: 600,
          y: 150,
          width: 200,
          height: 100,
          angle: 0,
          strokeColor: '#f97316',
          backgroundColor: 'rgba(249, 115, 22, 0.15)',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          index: 'a1',
          roundness: { type: 3 },
          seed: seed2,
          version: 1,
          versionNonce: seed2,
          isDeleted: false,
          boundElements: null,
          updated: now,
          link: null,
          locked: false,
        },
        // Arrow connecting them
        {
          id: 'ft-arrow-' + now,
          type: 'arrow',
          x: 550,
          y: 225,
          width: 50,
          height: 0,
          angle: 0,
          strokeColor: '#6366f1',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          index: 'a2',
          roundness: { type: 2 },
          seed: seed3,
          version: 1,
          versionNonce: seed3,
          isDeleted: false,
          boundElements: null,
          updated: now,
          link: null,
          locked: false,
          points: [[0, 0], [50, 0]],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: 'arrow',
          elbowed: false,
        },
        // Diamond shape
        {
          id: 'ft-diamond-' + now,
          type: 'diamond',
          x: 350,
          y: 350,
          width: 100,
          height: 100,
          angle: 0,
          strokeColor: '#ec4899',
          backgroundColor: 'rgba(236, 72, 153, 0.15)',
          fillStyle: 'solid',
          strokeWidth: 2,
          strokeStyle: 'solid',
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          index: 'a3',
          roundness: { type: 2 },
          seed: seed4,
          version: 1,
          versionNonce: seed4,
          isDeleted: false,
          boundElements: null,
          updated: now,
          link: null,
          locked: false,
        },
      ];

      // Clear canvas and add fresh elements
      app.updateScene({ elements: newElements });

      // Verify
      const verify = app.getSceneElements();
      return {
        success: true,
        added: newElements.length,
        verified: verify.length,
        elements: verify.map(e => ({
          type: e.type,
          x: Math.round(e.x),
          y: Math.round(e.y),
          w: Math.round(e.width || 0),
          h: Math.round(e.height || 0),
          color: e.strokeColor,
        }))
      };
    })()
  `
})

console.log("Result:", JSON.stringify(result, null, 2))

if (result?.success) {
  console.log("\nDrawn on canvas:")
  for (const el of result.elements) {
    console.log(`  [${el.type}] at (${el.x}, ${el.y}) ${el.w}x${el.h} — ${el.color}`)
  }
  console.log("\nCheck Excalidraw — you should see:")
  console.log("  - Teal rectangle (left)")
  console.log("  - Orange rectangle (right)")
  console.log("  - Purple arrow connecting them")
  console.log("  - Pink diamond below")
}

relay.close()

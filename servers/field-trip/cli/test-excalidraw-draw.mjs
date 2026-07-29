#!/usr/bin/env node
/**
 * Test drawing on Excalidraw canvas via the relay bridge.
 * Uses coordinate-based mouse events to interact with the canvas.
 */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "excalidraw-draw" })

console.log("Connected to relay.")

const page = await relay.command("page")
console.log(`Page: ${page.title} — ${page.url}\n`)

// Step 1: Find the canvas and toolbar
console.log("=== Step 1: Finding canvas and tools ===")
const canvasInfo = await relay.command("eval", {
  expression: `
    (() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return { error: 'No canvas found' };
      const rect = canvas.getBoundingClientRect();

      // Find toolbar buttons by aria-label
      const buttons = document.querySelectorAll('button[aria-label], label[aria-label]');
      const tools = [];
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label');
        if (label) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            tools.push({
              label,
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              tag: btn.tagName.toLowerCase()
            });
          }
        }
      }

      return {
        canvas: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          centerX: Math.round(rect.x + rect.width / 2),
          centerY: Math.round(rect.y + rect.height / 2),
        },
        tools: tools.slice(0, 25),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    })()
  `
})

if (canvasInfo?.error) {
  console.error("Error:", canvasInfo.error)
  relay.close()
  process.exit(1)
}

console.log(`Canvas: ${canvasInfo.canvas.width}x${canvasInfo.canvas.height} at (${canvasInfo.canvas.x}, ${canvasInfo.canvas.y})`)
console.log(`Center: (${canvasInfo.canvas.centerX}, ${canvasInfo.canvas.centerY})`)
console.log(`\nToolbar buttons found (${canvasInfo.tools.length}):`)
for (const t of canvasInfo.tools) {
  console.log(`  <${t.tag}> aria="${t.label}" at (${t.x}, ${t.y})`)
}

// Step 2: Click the Rectangle tool
console.log("\n=== Step 2: Selecting Rectangle tool ===")
const rectTool = canvasInfo.tools.find(t =>
  t.label.toLowerCase().includes('rectangle') ||
  t.label.toLowerCase().includes('rect')
)

if (rectTool) {
  console.log(`Clicking: "${rectTool.label}" at (${rectTool.x}, ${rectTool.y})`)
  await relay.command("eval", {
    expression: `
      (() => {
        const btn = document.querySelector('button[aria-label="${rectTool.label}"], label[aria-label="${rectTool.label}"]');
        if (btn) { btn.click(); return { clicked: true, label: '${rectTool.label}' }; }
        return { clicked: false };
      })()
    `
  })
} else {
  // Try finding by keyboard shortcut — R is rectangle in Excalidraw
  console.log("Rectangle tool not found by aria-label. Using keyboard shortcut 'R'...")
  await relay.command("eval", {
    expression: `
      (() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true }));
        return { pressedKey: 'r' };
      })()
    `
  })
}

await new Promise(r => setTimeout(r, 500))

// Step 3: Draw a rectangle on the canvas by simulating mouse events
console.log("\n=== Step 3: Drawing a rectangle on the canvas ===")
const cx = canvasInfo.canvas.centerX
const cy = canvasInfo.canvas.centerY
const startX = cx - 100
const startY = cy - 50
const endX = cx + 100
const endY = cy + 50

console.log(`Drawing from (${startX}, ${startY}) to (${endX}, ${endY})`)

await relay.command("eval", {
  expression: `
    (() => {
      const canvas = document.querySelector('canvas');
      if (!canvas) return { error: 'no canvas' };

      function dispatchMouse(type, x, y, extra = {}) {
        const event = new PointerEvent(type, {
          clientX: x, clientY: y,
          screenX: x, screenY: y,
          bubbles: true, cancelable: true,
          pointerId: 1, pointerType: 'mouse',
          button: 0, buttons: type === 'pointerup' ? 0 : 1,
          ...extra
        });
        canvas.dispatchEvent(event);
      }

      // Mouse down at start
      dispatchMouse('pointerdown', ${startX}, ${startY});

      // Move to end (with intermediate points for smooth drawing)
      const steps = 15;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = ${startX} + (${endX} - ${startX}) * t;
        const y = ${startY} + (${endY} - ${startY}) * t;
        dispatchMouse('pointermove', Math.round(x), Math.round(y));
      }

      // Mouse up at end
      dispatchMouse('pointerup', ${endX}, ${endY});

      return { drawn: true, from: { x: ${startX}, y: ${startY} }, to: { x: ${endX}, y: ${endY} } };
    })()
  `
})

console.log("Rectangle drawn!")

// Step 4: Now let's add text — press T for text tool
console.log("\n=== Step 4: Adding text ===")
await relay.command("eval", {
  expression: `
    (() => {
      // Press T for text tool
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true }));
      return { pressedKey: 't' };
    })()
  `
})

await new Promise(r => setTimeout(r, 300))

// Click on canvas to place text
const textX = cx
const textY = cy + 100
console.log(`Placing text at (${textX}, ${textY})`)

await relay.command("eval", {
  expression: `
    (() => {
      const canvas = document.querySelector('canvas');

      // Double-click to create text element
      const events = ['pointerdown', 'pointerup', 'pointerdown', 'pointerup'];
      for (const type of events) {
        canvas.dispatchEvent(new PointerEvent(type, {
          clientX: ${textX}, clientY: ${textY},
          screenX: ${textX}, screenY: ${textY},
          bubbles: true, cancelable: true,
          pointerId: 1, pointerType: 'mouse',
          button: 0, buttons: type.includes('up') ? 0 : 1,
        }));
      }

      // Try to type text
      setTimeout(() => {
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = 'Hello from Field Trip!';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, 500);

      return { textPlaced: true, x: ${textX}, y: ${textY} };
    })()
  `
})

await new Promise(r => setTimeout(r, 1500))

// Step 5: Try to draw an arrow
console.log("\n=== Step 5: Drawing an arrow ===")
await relay.command("eval", {
  expression: `
    (() => {
      // Press A for arrow tool
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }));
      return { pressedKey: 'a' };
    })()
  `
})

await new Promise(r => setTimeout(r, 300))

const arrowStartX = cx - 150
const arrowStartY = cy - 100
const arrowEndX = cx + 150
const arrowEndY = cy - 100

console.log(`Drawing arrow from (${arrowStartX}, ${arrowStartY}) to (${arrowEndX}, ${arrowEndY})`)

await relay.command("eval", {
  expression: `
    (() => {
      const canvas = document.querySelector('canvas');

      function dispatch(type, x, y) {
        canvas.dispatchEvent(new PointerEvent(type, {
          clientX: x, clientY: y,
          screenX: x, screenY: y,
          bubbles: true, cancelable: true,
          pointerId: 1, pointerType: 'mouse',
          button: 0, buttons: type === 'pointerup' ? 0 : 1,
        }));
      }

      dispatch('pointerdown', ${arrowStartX}, ${arrowStartY});
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        dispatch('pointermove', Math.round(${arrowStartX} + (${arrowEndX} - ${arrowStartX}) * t), ${arrowStartY});
      }
      dispatch('pointerup', ${arrowEndX}, ${arrowEndY});

      return { drawn: true };
    })()
  `
})

console.log("Arrow drawn!")

// Final: Check what's on the canvas
console.log("\n=== Final: Checking canvas state ===")
const elements = await relay.command("eval", {
  expression: `
    (() => {
      // Try to access Excalidraw's API
      const app = document.querySelector('.excalidraw');
      if (!app) return { api: false, message: 'No excalidraw app element' };

      // Check for React state
      const reactKey = Object.keys(app).find(k => k.startsWith('__reactFiber'));
      if (!reactKey) return { api: false, message: 'No React fiber found' };

      // Walk up to find the app component with scene elements
      let fiber = app[reactKey];
      let depth = 0;
      let elements = null;

      while (fiber && depth < 30) {
        const state = fiber.memoizedState;
        if (state) {
          // Look for excalidraw elements in state
          let current = state;
          for (let i = 0; i < 10; i++) {
            if (current && current.memoizedState && Array.isArray(current.memoizedState)) {
              elements = current.memoizedState;
              break;
            }
            if (current) current = current.next;
            else break;
          }
        }
        if (elements) break;
        fiber = fiber.return;
        depth++;
      }

      // Try window for excalidraw API
      const sceneElements = document.querySelectorAll('[data-excalidraw-element]');

      return {
        api: false,
        reactDepthSearched: depth,
        sceneElementsInDOM: sceneElements.length,
        canvasCount: document.querySelectorAll('canvas').length,
      };
    })()
  `
})

console.log("Canvas state:", JSON.stringify(elements, null, 2))
console.log("\nDone! Check Excalidraw in your browser to see if shapes were drawn.")

relay.close()

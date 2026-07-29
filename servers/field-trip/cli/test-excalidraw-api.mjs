#!/usr/bin/env node
/**
 * Draw on Excalidraw using its internal API instead of synthetic pointer events.
 */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "excalidraw-api" })
console.log("Connected. Discovering Excalidraw API...\n")

// Step 1: Find the Excalidraw API
const apiInfo = await relay.command("eval", {
  expression: `
    (() => {
      // Method 1: Check for excalidrawAPI on the app container
      const appEl = document.querySelector('.excalidraw');
      if (!appEl) return { found: false, reason: 'No .excalidraw element' };

      // Method 2: Walk React fiber to find the App component with scene state
      const reactKey = Object.keys(appEl).find(k => k.startsWith('__reactFiber'));
      if (!reactKey) return { found: false, reason: 'No React fiber' };

      let fiber = appEl[reactKey];
      let depth = 0;
      let appInstance = null;
      let stateInfo = [];

      while (fiber && depth < 40) {
        // Check for component with excalidraw-related methods
        if (fiber.stateNode && typeof fiber.stateNode === 'object') {
          const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(fiber.stateNode) || {})
            .filter(m => typeof fiber.stateNode[m] === 'function');
          if (methods.some(m => m.includes('scene') || m.includes('Element') || m.includes('canvas') || m.includes('update'))) {
            appInstance = fiber.stateNode;
            stateInfo.push({
              depth,
              component: fiber.type?.name || fiber.type?.displayName || 'unknown',
              methods: methods.filter(m => !m.startsWith('_') && m !== 'constructor').slice(0, 30),
              hasState: !!fiber.stateNode.state,
              stateKeys: fiber.stateNode.state ? Object.keys(fiber.stateNode.state).slice(0, 20) : [],
            });
          }
        }

        // Check memoizedState for hooks-based components
        if (fiber.memoizedState && fiber.type?.name) {
          stateInfo.push({
            depth,
            component: fiber.type.name,
            isHooks: true,
          });
        }

        fiber = fiber.return;
        depth++;
      }

      // Method 3: Check window for any exposed API
      const windowAPIs = [];
      for (const key of Object.keys(window)) {
        const lower = key.toLowerCase();
        if (lower.includes('excalidraw') || lower.includes('scene') || lower.includes('elements')) {
          windowAPIs.push({ key, type: typeof window[key] });
        }
      }

      // Method 4: Check for the Excalidraw ref pattern — often stored on a data attribute
      const containers = document.querySelectorAll('[data-excalidraw], .excalidraw-container, #root');
      const containerInfo = [];
      for (const c of containers) {
        const keys = Object.keys(c).filter(k => !k.startsWith('__react'));
        if (keys.length) containerInfo.push({ tag: c.tagName, id: c.id, keys });
      }

      return {
        found: stateInfo.length > 0 || windowAPIs.length > 0,
        components: stateInfo,
        windowAPIs,
        containers: containerInfo,
        depthSearched: depth,
      };
    })()
  `
})

console.log("API Discovery:")
console.log(JSON.stringify(apiInfo, null, 2))

// Step 2: Try to add elements directly via Excalidraw's updateScene
console.log("\n=== Attempting to draw via React state ===")

const drawResult = await relay.command("eval", {
  expression: `
    (() => {
      // Excalidraw stores its API on the app ref
      // Try to find it through the React tree
      const appEl = document.querySelector('.excalidraw');
      const reactKey = Object.keys(appEl).find(k => k.startsWith('__reactFiber'));
      let fiber = appEl[reactKey];
      let depth = 0;
      let excalidrawAPI = null;

      // Walk the fiber tree looking for the API ref
      while (fiber && depth < 50) {
        // Check refs
        if (fiber.ref && fiber.ref.current) {
          const ref = fiber.ref.current;
          if (typeof ref.updateScene === 'function' ||
              typeof ref.getSceneElements === 'function' ||
              typeof ref.addElements === 'function') {
            excalidrawAPI = ref;
            break;
          }
        }

        // Check stateNode for class components
        if (fiber.stateNode && typeof fiber.stateNode.updateScene === 'function') {
          excalidrawAPI = fiber.stateNode;
          break;
        }

        // Check memoizedState for hook refs
        let hookState = fiber.memoizedState;
        let hookDepth = 0;
        while (hookState && hookDepth < 20) {
          if (hookState.memoizedState && typeof hookState.memoizedState === 'object') {
            const val = hookState.memoizedState;
            // Check if this looks like a ref ({ current: ... })
            if (val && val.current && typeof val.current === 'object') {
              const current = val.current;
              if (typeof current.updateScene === 'function' ||
                  typeof current.getSceneElements === 'function') {
                excalidrawAPI = current;
                break;
              }
            }
            // Check the value directly
            if (typeof val.updateScene === 'function') {
              excalidrawAPI = val;
              break;
            }
          }
          hookState = hookState.next;
          hookDepth++;
        }
        if (excalidrawAPI) break;

        fiber = fiber.return;
        depth++;
      }

      if (!excalidrawAPI) {
        // Last resort: check window.__EXCALIDRAW_SHA__ or similar
        // Try dispatching through Excalidraw's own event system
        return {
          method: 'none',
          depth,
          message: 'Could not find excalidrawAPI ref. Trying alternative...',
        };
      }

      // Found the API! Let's use it
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(excalidrawAPI) || {})
        .concat(Object.keys(excalidrawAPI))
        .filter(m => typeof excalidrawAPI[m] === 'function' && !m.startsWith('_'));

      // Create elements using the API
      const id1 = 'rect-' + Date.now();
      const id2 = 'text-' + Date.now();
      const id3 = 'arrow-' + Date.now();

      const newElements = [
        {
          id: id1,
          type: 'rectangle',
          x: 300, y: 200,
          width: 200, height: 100,
          strokeColor: '#14b8a6',
          backgroundColor: '#14b8a620',
          fillStyle: 'solid',
          strokeWidth: 2,
          roughness: 1,
          opacity: 100,
          angle: 0,
          groupIds: [],
          boundElements: null,
          updated: Date.now(),
          seed: Math.floor(Math.random() * 1000000),
          version: 1,
          versionNonce: Math.floor(Math.random() * 1000000),
          isDeleted: false,
          locked: false,
        },
        {
          id: id2,
          type: 'text',
          x: 320, y: 230,
          width: 160, height: 40,
          text: 'Field Trip!',
          fontSize: 24,
          fontFamily: 1,
          textAlign: 'center',
          verticalAlign: 'middle',
          strokeColor: '#14b8a6',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 1,
          roughness: 0,
          opacity: 100,
          angle: 0,
          groupIds: [],
          boundElements: null,
          updated: Date.now(),
          seed: Math.floor(Math.random() * 1000000),
          version: 1,
          versionNonce: Math.floor(Math.random() * 1000000),
          isDeleted: false,
          locked: false,
          baseline: 20,
          containerId: null,
          originalText: 'Field Trip!',
        },
      ];

      try {
        if (typeof excalidrawAPI.updateScene === 'function') {
          const existing = typeof excalidrawAPI.getSceneElements === 'function'
            ? excalidrawAPI.getSceneElements() : [];
          excalidrawAPI.updateScene({
            elements: [...existing, ...newElements],
          });
          return {
            method: 'updateScene',
            success: true,
            elementsAdded: newElements.length,
            apiMethods: methods.slice(0, 15),
          };
        }
        return { method: 'found_but_no_updateScene', apiMethods: methods };
      } catch (e) {
        return { method: 'updateScene_error', error: e.message, apiMethods: methods };
      }
    })()
  `
})

console.log("Draw result:")
console.log(JSON.stringify(drawResult, null, 2))

if (drawResult?.success) {
  console.log("\nShapes should be visible on the Excalidraw canvas now!")
  console.log("A teal rectangle with 'Field Trip!' text inside.")
} else if (drawResult?.method === 'none') {
  console.log("\nCouldn't find the API through React fiber.")
  console.log("Let's try the keyboard shortcut + clipboard approach...")

  // Alternative: Use Excalidraw's paste functionality
  const pasteResult = await relay.command("eval", {
    expression: `
      (() => {
        // Excalidraw supports pasting JSON elements from clipboard
        const elements = [
          {
            id: 'ft-rect-' + Date.now(),
            type: 'rectangle',
            x: 300, y: 200,
            width: 250, height: 120,
            strokeColor: '#14b8a6',
            backgroundColor: 'rgba(20, 184, 166, 0.1)',
            fillStyle: 'solid',
            strokeWidth: 2,
            roughness: 1,
            opacity: 100,
            angle: 0,
            groupIds: [],
            boundElements: null,
            seed: Math.floor(Math.random() * 1000000),
            version: 1,
            versionNonce: Math.floor(Math.random() * 1000000),
            isDeleted: false,
          }
        ];

        // Create clipboard data in Excalidraw format
        const clipData = JSON.stringify({
          type: 'excalidraw/clipboard',
          elements: elements,
          files: {},
        });

        // Try to paste via clipboard API
        try {
          const clipboardItem = new ClipboardItem({
            'text/plain': new Blob([clipData], { type: 'text/plain' }),
          });
          navigator.clipboard.write([clipboardItem]).then(() => {
            // Trigger Ctrl+V
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'v', code: 'KeyV', ctrlKey: true, bubbles: true
            }));
          });
          return { method: 'clipboard', status: 'attempted' };
        } catch(e) {
          return { method: 'clipboard', error: e.message };
        }
      })()
    `
  })
  console.log("Paste attempt:", JSON.stringify(pasteResult))
}

relay.close()
console.log("\nDone! Check Excalidraw in your browser.")

#!/usr/bin/env node
/**
 * Test the cursor engine — injects a visual cursor that travels
 * between elements on the current page via the relay bridge.
 */
import { connectRelay } from "./relay-client.mjs"

const relay = await connectRelay({ port: 9333, name: "cursor-demo" })

console.log("Connected to relay. Scanning for visible elements...")

// Get ALL visible elements with real coordinates — scroll each into view first
// so elements below the fold are measured accurately
const elements = await relay.command("eval", {
  expression: `
    (async () => {
      const results = [];
      const els = document.querySelectorAll('h1, h2, h3, a, button, input');
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        // Scroll element into view before measuring
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(resolve => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setTimeout(resolve, 300);
            });
          });
        });
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // After scrolling, verify the element is within the viewport
        if (rect.y < 0 || rect.y > window.innerHeight) continue;
        if (rect.x < 0 || rect.x > window.innerWidth) continue;
        // Also verify positive coordinates and within viewport bounds
        const cx = Math.round(rect.x + rect.width / 2);
        const cy = Math.round(rect.y + rect.height / 2);
        if (cx <= 0 || cy <= 0) continue;
        if (cx > window.innerWidth || cy > window.innerHeight) continue;
        results.push({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 50),
          x: cx,
          y: cy,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          // Store a unique selector hint so we can re-scroll later
          index: results.length,
        });
      }
      // Scroll back to top so the demo starts from a natural position
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 400));
      return results.slice(0, 20);
    })()
  `
})

console.log("Visible elements:")
for (const el of elements) {
  console.log(`  <${el.tag}> "${el.text}" at (${el.x}, ${el.y}) ${el.w}x${el.h}`)
}

if (elements.length < 2) {
  console.error("Need at least 2 visible elements")
  relay.close()
  process.exit(1)
}

// Pick two elements that are clearly visible and separated
const fromEl = elements[0]
const toEl = elements[Math.min(3, elements.length - 1)]

// Scroll the "from" element into view and get fresh coordinates
const fromFresh = await relay.command("eval", {
  expression: `
    (async () => {
      const els = document.querySelectorAll('h1, h2, h3, a, button, input');
      let idx = 0;
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r0 = el.getBoundingClientRect();
        if (r0.width === 0 || r0.height === 0) continue;
        if (idx === ${fromEl.index}) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 500));
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) };
        }
        idx++;
      }
      return null;
    })()
  `
})
const from = fromFresh ? { ...fromEl, ...fromFresh } : fromEl

// Scroll the "to" element into view, wait 500ms, then get its rect
const toFresh = await relay.command("eval", {
  expression: `
    (async () => {
      const els = document.querySelectorAll('h1, h2, h3, a, button, input');
      let idx = 0;
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const r0 = el.getBoundingClientRect();
        if (r0.width === 0 || r0.height === 0) continue;
        if (idx === ${toEl.index}) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise(r => setTimeout(r, 500));
          const rect = el.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) };
        }
        idx++;
      }
      return null;
    })()
  `
})
const to = toFresh ? { ...toEl, ...toFresh } : toEl

console.log(`\nCursor path:`)
console.log(`  From: "${from.text}" at (${from.x}, ${from.y})`)
console.log(`  To:   "${to.text}" at (${to.x}, ${to.y})`)

// Generate bezier path
const dx = to.x - from.x
const dy = to.y - from.y
const dist = Math.sqrt(dx * dx + dy * dy) || 1
const offset = Math.min(dist * 0.25, 100)
const midX = (from.x + to.x) / 2
const midY = (from.y + to.y) / 2
const perpX = -dy / dist * offset
const perpY = dx / dist * offset
const cp = { x: midX + perpX, y: midY + perpY }

const pathPoints = []
const steps = 40
for (let i = 0; i <= steps; i++) {
  const t = i / steps
  const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cp.x + t * t * to.x
  const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cp.y + t * t * to.y
  pathPoints.push({ x: Math.round(x), y: Math.round(y) })
}

console.log(`  Path: ${pathPoints.length} points\n`)
console.log("Injecting cursor animation... WATCH YOUR BROWSER!")

// Inject cursor and animate
const result = await relay.command("eval", {
  expression: `
    (() => {
      // Clean up previous
      document.getElementById('__ft-cursor-container')?.remove();
      document.getElementById('__ft-cursor-styles')?.remove();

      // Styles
      const style = document.createElement('style');
      style.id = '__ft-cursor-styles';
      style.textContent = \`
        @keyframes ftRipple { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(5); opacity: 0; } }
        @keyframes ftPulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(20,184,166,0.3); } 50% { box-shadow: 0 0 0 8px rgba(20,184,166,0.1); } }
      \`;
      document.head.appendChild(style);

      // Container
      const container = document.createElement('div');
      container.id = '__ft-cursor-container';
      container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden';
      document.body.appendChild(container);

      // Cursor SVG — large and visible
      const cursor = document.createElement('div');
      cursor.innerHTML = \`<svg width="32" height="32" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 8px rgba(0,0,0,0.6))">
        <path d="M5 2l15 9-8 2.5-3 8z" fill="#14b8a6" stroke="#0d1117" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>\`;
      cursor.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;transform:translate(-4px,-2px)';
      container.appendChild(cursor);

      // Highlight source element
      const srcRing = document.createElement('div');
      srcRing.style.cssText = 'position:fixed;border:2px solid rgba(20,184,166,0.5);border-radius:8px;pointer-events:none;z-index:2147483645;left:${from.x - from.w/2 - 6}px;top:${from.y - from.h/2 - 6}px;width:${from.w + 12}px;height:${from.h + 12}px;animation:ftPulse 1.5s ease infinite';
      container.appendChild(srcRing);

      const path = ${JSON.stringify(pathPoints)};
      const trailPoints = [];
      let step = 0;

      // Position cursor at start
      cursor.style.left = path[0].x + 'px';
      cursor.style.top = path[0].y + 'px';

      function drawTrail() {
        // Draw trail using divs (more reliable than canvas)
        const now = Date.now();
        for (let i = trailPoints.length - 1; i >= 0; i--) {
          const age = now - trailPoints[i].time;
          if (age > 800) {
            trailPoints[i].el?.remove();
            trailPoints.splice(i, 1);
          } else if (trailPoints[i].el) {
            const alpha = 1 - age / 800;
            trailPoints[i].el.style.opacity = String(alpha * 0.7);
          }
        }
      }

      function animate() {
        if (step >= path.length) {
          // Arrival — highlight target
          srcRing.remove();
          const ring = document.createElement('div');
          ring.style.cssText = 'position:fixed;border:3px solid #14b8a6;border-radius:8px;box-shadow:0 0 0 4px rgba(20,184,166,0.3),0 0 30px rgba(20,184,166,0.15);pointer-events:none;z-index:2147483645;left:${to.x - to.w/2 - 8}px;top:${to.y - to.h/2 - 8}px;width:${to.w + 16}px;height:${to.h + 16}px;animation:ftPulse 1.5s ease infinite';
          container.appendChild(ring);

          // Click ripple
          for (let i = 0; i < 3; i++) {
            setTimeout(() => {
              const ripple = document.createElement('div');
              ripple.style.cssText = 'position:fixed;border:2px solid #14b8a6;border-radius:50%;pointer-events:none;z-index:2147483647;width:12px;height:12px;left:' + (path[path.length-1].x - 6) + 'px;top:' + (path[path.length-1].y - 6) + 'px;animation:ftRipple 0.8s ease-out forwards';
              container.appendChild(ripple);
            }, i * 200);
          }

          // Clean up after 4 seconds
          setTimeout(() => {
            container.remove();
            style.remove();
          }, 4000);
          return;
        }

        const p = path[step];
        cursor.style.left = p.x + 'px';
        cursor.style.top = p.y + 'px';

        // Add trail dot
        const dot = document.createElement('div');
        dot.style.cssText = 'position:fixed;width:4px;height:4px;border-radius:50%;background:#14b8a6;pointer-events:none;z-index:2147483646;left:' + (p.x + 4) + 'px;top:' + (p.y + 8) + 'px';
        container.appendChild(dot);
        trailPoints.push({ x: p.x, y: p.y, time: Date.now(), el: dot });
        drawTrail();

        step++;
        requestAnimationFrame(() => setTimeout(animate, 30));
      }

      // Start after a brief pause
      setTimeout(animate, 500);

      return { ok: true, from: '${from.text}', to: '${to.text}', steps: path.length };
    })()
  `
})

console.log("Result:", JSON.stringify(result))
console.log("\nThe teal cursor should be animating NOW in your browser!")
console.log("It travels from the heading to the link with a dotted trail and ripple on arrival.")

// Wait for animation
await new Promise(r => setTimeout(r, 6000))
relay.close()

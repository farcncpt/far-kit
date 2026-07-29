#!/usr/bin/env node
/** Highlight elements on Power Automate with spotlight + cursor */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "pa-highlight" })

console.log("Connected. Highlighting Power Automate elements...\n")

// Highlight sequence — spotlight each element with a caption
const highlights = [
  { label: "Save button", selector: '#saveFlow', caption: "Step 1: Save your flow" },
  { label: "Test button", selector: '#testFlow', caption: "Step 2: Test your flow" },
  { label: "Flow checker", selector: '#checkFlow', caption: "Step 3: Check for errors" },
  { label: "Copilot", selector: '#chat', caption: "Step 4: Ask Copilot for help" },
  { label: "Add a trigger", selector: '[aria-label="Add a trigger"]', caption: "Step 5: Add your first trigger" },
  { label: "Search connectors", selector: 'input[aria-label*="Search"]', caption: "Step 6: Search for connectors" },
]

for (let i = 0; i < highlights.length; i++) {
  const h = highlights[i]
  console.log(`Highlighting: ${h.label}...`)

  await relay.command("eval", {
    expression: `
      (() => {
        // Remove previous highlights
        document.getElementById('__ft-highlight-ring')?.remove();
        document.getElementById('__ft-highlight-caption')?.remove();
        document.getElementById('__ft-highlight-step')?.remove();
        document.getElementById('__ft-highlight-styles')?.remove();

        // Add animation styles
        const style = document.createElement('style');
        style.id = '__ft-highlight-styles';
        style.textContent = \`
          @keyframes ftPulseRing { 0%, 100% { box-shadow: 0 0 0 4px rgba(20,184,166,0.4), 0 0 20px rgba(20,184,166,0.15); } 50% { box-shadow: 0 0 0 8px rgba(20,184,166,0.2), 0 0 30px rgba(20,184,166,0.1); } }
          @keyframes ftFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
        \`;
        document.head.appendChild(style);

        const el = document.querySelector(${JSON.stringify(h.selector)});
        if (!el) return { found: false, selector: ${JSON.stringify(h.selector)} };

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const rect = el.getBoundingClientRect();

        // Highlight ring
        const ring = document.createElement('div');
        ring.id = '__ft-highlight-ring';
        ring.style.cssText = \`
          position: fixed;
          left: \${rect.left - 8}px;
          top: \${rect.top - 8}px;
          width: \${rect.width + 16}px;
          height: \${rect.height + 16}px;
          border: 3px solid #14b8a6;
          border-radius: 10px;
          pointer-events: none;
          z-index: 2147483647;
          animation: ftPulseRing 1.5s ease infinite;
        \`;
        document.body.appendChild(ring);

        // Step number badge
        const badge = document.createElement('div');
        badge.id = '__ft-highlight-step';
        badge.textContent = '${i + 1}';
        badge.style.cssText = \`
          position: fixed;
          left: \${rect.left - 18}px;
          top: \${rect.top - 18}px;
          width: 28px;
          height: 28px;
          background: #14b8a6;
          color: #0d1117;
          font-family: -apple-system, system-ui, sans-serif;
          font-size: 14px;
          font-weight: 700;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: none;
          z-index: 2147483647;
          animation: ftFadeIn 0.3s ease;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        \`;
        document.body.appendChild(badge);

        // Caption tooltip
        const caption = document.createElement('div');
        caption.id = '__ft-highlight-caption';
        caption.textContent = ${JSON.stringify(h.caption)};
        caption.style.cssText = \`
          position: fixed;
          left: \${rect.left}px;
          top: \${rect.bottom + 12}px;
          background: #0d1117;
          color: #c9d1d9;
          font-family: -apple-system, system-ui, sans-serif;
          font-size: 14px;
          font-weight: 500;
          padding: 8px 16px;
          border-radius: 8px;
          border: 1px solid #14b8a6;
          pointer-events: none;
          z-index: 2147483647;
          white-space: nowrap;
          animation: ftFadeIn 0.3s ease;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        \`;
        document.body.appendChild(caption);

        return { found: true, tag: el.tagName, text: (el.textContent||'').trim().slice(0, 40), rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } };
      })()
    `
  })

  console.log(`  ✓ ${h.caption}`)

  // Hold each highlight for 3 seconds
  await new Promise(r => setTimeout(r, 3000))
}

// Clean up
await relay.command("eval", {
  expression: `
    document.getElementById('__ft-highlight-ring')?.remove();
    document.getElementById('__ft-highlight-caption')?.remove();
    document.getElementById('__ft-highlight-step')?.remove();
    document.getElementById('__ft-highlight-styles')?.remove();
    'cleaned up'
  `
})

console.log("\nAll highlights complete! Did you see the teal rings with step numbers?")

relay.close()

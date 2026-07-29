#!/usr/bin/env node
/**
 * annotate.mjs — Toggle annotation mode and manage annotations via relay.
 *
 * Usage:
 *   node cli/annotate.mjs --relay on              # Turn on annotation mode
 *   node cli/annotate.mjs --relay off             # Turn off annotation mode
 *   node cli/annotate.mjs --relay list            # List all annotations
 *   node cli/annotate.mjs --relay get             # Get annotations for current tab
 *   node cli/annotate.mjs --relay demo            # Inject demo annotation UI
 */

import { connectRelay } from "./relay-client.mjs"

const args = process.argv.slice(2)
const useRelay = args.includes("--relay")
const tabIdx = args.indexOf("--tab")
const tabId = tabIdx !== -1 ? parseInt(args[tabIdx + 1]) : undefined
const command = args.find(a => !a.startsWith("--") && a !== args[tabIdx + 1]) || "demo"

if (!useRelay) {
  console.error("Usage: node cli/annotate.mjs --relay [on|off|list|get|demo]")
  process.exit(1)
}

const relay = await connectRelay({ port: 9333, tabId })

try {
  if (command === "demo") {
    console.log("Injecting annotation mode UI via eval...")

    // Inject the annotation overlay directly into the page via eval
    const result = await relay.command("eval", {
      expression: `(() => {
        // Remove existing annotation layer if any
        const existing = document.getElementById('ft-annotation-layer');
        if (existing) { existing.remove(); return 'Annotation mode OFF'; }

        // Create annotation layer container
        const layer = document.createElement('div');
        layer.id = 'ft-annotation-layer';
        layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';

        // Blue border
        const border = document.createElement('div');
        border.style.cssText = 'position:fixed;inset:0;border:3px solid #3b82f6;pointer-events:none;z-index:2147483646;opacity:0.7;';
        layer.appendChild(border);

        // Status bar
        const status = document.createElement('div');
        status.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:6px 16px;border-radius:8px;font-size:12px;font-family:system-ui,sans-serif;font-weight:500;z-index:2147483647;pointer-events:auto;box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;align-items:center;gap:8px;';
        status.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block"></span> Annotation Mode — Click elements to annotate • Alt+A or click X to exit <button id="ft-ann-close" style="margin-left:8px;background:#334155;border:none;color:#94a3b8;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">✕</button>';
        layer.appendChild(status);

        document.body.appendChild(layer);

        // Hover highlight
        let hoverEl = null;
        const highlight = document.createElement('div');
        highlight.id = 'ft-ann-highlight';
        highlight.style.cssText = 'position:fixed;border:2px solid #3b82f6;border-radius:4px;background:rgba(59,130,246,0.08);pointer-events:none;z-index:2147483645;transition:all 0.1s ease-out;display:none;';
        document.body.appendChild(highlight);

        // Click handler — intercept clicks to annotate
        const clickHandler = (e) => {
          if (e.target.id === 'ft-ann-close' || e.target.closest('#ft-annotation-layer')) {
            if (e.target.id === 'ft-ann-close') {
              cleanup();
            }
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          const el = e.target;
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().substring(0, 40);
          const selector = el.id ? '#' + el.id : el.className ? '.' + (el.className.split(' ')[0]) : tag;

          // Show annotation popup
          const popup = document.createElement('div');
          popup.id = 'ft-ann-popup';
          popup.style.cssText = 'position:fixed;top:' + Math.min(rect.bottom + 8, window.innerHeight - 280) + 'px;left:' + Math.min(Math.max(rect.left, 8), window.innerWidth - 340) + 'px;width:320px;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;z-index:2147483647;pointer-events:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4);font-family:system-ui,sans-serif;color:#e2e8f0;font-size:13px;';

          popup.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:12px"><span style="font-weight:600;font-size:14px">New Annotation</span><button id="ft-popup-close" style="background:#334155;border:none;color:#94a3b8;padding:2px 8px;border-radius:4px;cursor:pointer">✕</button></div>' +
            '<div style="background:#0f172a;border-radius:6px;padding:8px 10px;font-size:11px;color:#94a3b8;margin-bottom:12px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">&lt;' + tag + '&gt; "' + text + '"</div>' +
            '<textarea id="ft-ann-input" placeholder="Instructions for the agent..." style="width:100%;min-height:60px;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;color:#e2e8f0;font-size:13px;font-family:system-ui;resize:vertical;outline:none;box-sizing:border-box"></textarea>' +
            '<div style="display:flex;gap:8px;margin-top:10px;align-items:center"><span style="font-size:11px;color:#94a3b8;min-width:55px">Scope</span><select id="ft-ann-scope" style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:5px 8px;color:#e2e8f0;font-size:12px;outline:none"><option value="exact">This exact page</option><option value="pattern">This section</option><option value="domain">Entire domain</option></select></div>' +
            '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end"><button id="ft-ann-cancel" style="padding:7px 14px;border-radius:8px;border:none;font-size:12px;font-weight:600;cursor:pointer;background:#334155;color:#94a3b8">Cancel</button><button id="ft-ann-save" style="padding:7px 14px;border-radius:8px;border:none;font-size:12px;font-weight:600;cursor:pointer;background:#3b82f6;color:#fff">Save</button></div>' +
            '<div style="font-size:10px;color:#64748b;margin-top:8px">Ctrl+Enter to save</div>';

          // Remove any existing popup
          const oldPopup = document.getElementById('ft-ann-popup');
          if (oldPopup) oldPopup.remove();

          document.body.appendChild(popup);

          // Focus the textarea
          setTimeout(() => document.getElementById('ft-ann-input')?.focus(), 100);

          // Popup button handlers
          document.getElementById('ft-popup-close')?.addEventListener('click', () => popup.remove());
          document.getElementById('ft-ann-cancel')?.addEventListener('click', () => popup.remove());
          document.getElementById('ft-ann-save')?.addEventListener('click', () => {
            const instruction = document.getElementById('ft-ann-input')?.value;
            const scope = document.getElementById('ft-ann-scope')?.value;
            if (instruction) {
              // Save to chrome.storage if available, otherwise console log
              const annotation = {
                id: 'ann-' + Date.now() + '-' + Math.random().toString(36).slice(2,8),
                type: 'structural',
                selector: selector,
                instruction: instruction,
                category: 'info',
                scope: scope || 'exact',
                urlPattern: window.location.href,
                elementSnapshot: { tag: tag.toUpperCase(), text, classes: el.className?.toString()?.substring(0,100) || '' },
                createdAt: new Date().toISOString()
              };
              console.log('[Field Trip] Annotation saved:', annotation);

              // Create a badge on the element
              const badge = document.createElement('div');
              badge.style.cssText = 'position:fixed;left:' + (rect.right - 10) + 'px;top:' + (rect.top - 10) + 'px;width:22px;height:22px;border-radius:50%;background:#3b82f6;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;z-index:2147483645;pointer-events:none;border:2px solid #3b82f6;box-shadow:0 2px 8px rgba(59,130,246,0.4);font-family:system-ui';
              badge.textContent = '!';
              badge.title = instruction;
              document.body.appendChild(badge);
            }
            popup.remove();
          });

          // Ctrl+Enter to save
          document.getElementById('ft-ann-input')?.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) {
              document.getElementById('ft-ann-save')?.click();
            }
            if (ke.key === 'Escape') popup.remove();
            ke.stopPropagation();
          });
        };

        // Hover handler
        const moveHandler = (e) => {
          if (document.getElementById('ft-ann-popup')) return;
          if (e.target.closest('#ft-annotation-layer')) { highlight.style.display = 'none'; return; }
          const rect = e.target.getBoundingClientRect();
          highlight.style.display = 'block';
          highlight.style.left = rect.left + 'px';
          highlight.style.top = rect.top + 'px';
          highlight.style.width = rect.width + 'px';
          highlight.style.height = rect.height + 'px';
        };

        // Keyboard handler
        const keyHandler = (e) => {
          if (e.altKey && e.code === 'KeyA') { e.preventDefault(); cleanup(); }
          if (e.key === 'Escape' && !document.getElementById('ft-ann-popup')) { cleanup(); }
        };

        function cleanup() {
          document.removeEventListener('click', clickHandler, true);
          document.removeEventListener('mousemove', moveHandler, true);
          document.removeEventListener('keydown', keyHandler, true);
          layer.remove();
          highlight.remove();
          const popup = document.getElementById('ft-ann-popup');
          if (popup) popup.remove();
        }

        document.addEventListener('click', clickHandler, true);
        document.addEventListener('mousemove', moveHandler, true);
        document.addEventListener('keydown', keyHandler, true);

        return 'Annotation mode ON — click any element to annotate, Alt+A or Escape to exit';
      })()`
    }, { tabId })

    console.log(result)

  } else if (command === "on") {
    console.log("Use: node cli/annotate.mjs --relay demo")
    console.log("This injects annotation mode directly into the page.")

  } else if (command === "off") {
    const result = await relay.command("eval", {
      expression: `(() => {
        const layer = document.getElementById('ft-annotation-layer');
        const highlight = document.getElementById('ft-ann-highlight');
        const popup = document.getElementById('ft-ann-popup');
        if (layer) layer.remove();
        if (highlight) highlight.remove();
        if (popup) popup.remove();
        return 'Annotation mode OFF';
      })()`
    }, { tabId })
    console.log(result)

  } else if (command === "list") {
    const result = await relay.command("annotations", { action: "list" }, { tabId })
    console.log(JSON.stringify(result, null, 2))

  } else if (command === "get") {
    const result = await relay.command("annotations", { action: "get", url: "current" }, { tabId })
    console.log(JSON.stringify(result, null, 2))
  }

} catch (err) {
  console.error("Error:", err.message)
} finally {
  process.exit(0)
}

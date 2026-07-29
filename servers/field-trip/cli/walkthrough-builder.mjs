#!/usr/bin/env node
/**
 * Walkthrough Builder — explores a site, builds a skill document, and generates
 * annotated screenshot guides.
 *
 * Modes:
 *   explore   — scan site pages, catalog all interactive elements and navigation
 *   build     — create a skill document from an exploration or manual steps
 *   capture   — replay a skill document, spotlighting + screenshotting each step
 *   guide     — generate a markdown guide with embedded screenshots
 *
 * Usage:
 *   node cli/walkthrough-builder.mjs explore --url https://app.example.com --output catalog.json
 *   node cli/walkthrough-builder.mjs build --catalog catalog.json --name "Create Invoice" --output skill.json
 *   node cli/walkthrough-builder.mjs capture --skill skill.json --output-dir walkthrough/
 *   node cli/walkthrough-builder.mjs guide --skill skill.json --screenshots walkthrough/ --output guide.md
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { resolve, join, basename } from "path"
import http from "http"

const PORT = parseInt(process.env.CDP_PORT || "9222")

// ─── CDP connection ───

async function connectCDP(port) {
  const targets = await new Promise((r, j) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => r(JSON.parse(d)))
    }).on("error", j)
  })
  const page = targets.find(t => t.type === "page" && !t.url.startsWith("chrome://"))
  if (!page) throw new Error("No page tab found")

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => { ws.on("open", r); ws.on("error", j) })

  let msgId = 0
  const send = (method, params = {}) => {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 30000)
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id === id) { ws.off("message", handler); clearTimeout(timeout); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result) }
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed")
    return r.result?.value
  }
  const screenshot = async (opts = {}) => {
    const params = { format: "png", captureBeyondViewport: false }
    const result = await send("Page.captureScreenshot", params)
    return Buffer.from(result.data, "base64")
  }

  return { ws, send, evaluate, screenshot, close: () => ws.close() }
}

// ─── Explore mode ───

async function explore(url, outputPath) {
  console.log(`Exploring: ${url}`)
  const cdp = await connectCDP(PORT)

  // Navigate
  await cdp.send("Page.navigate", { url })
  await new Promise(r => setTimeout(r, 3000))

  const pageInfo = await cdp.evaluate(`({ title: document.title, url: location.href })`)
  console.log(`  Page: ${pageInfo.title}`)

  // Scan all interactive elements
  const elements = await cdp.evaluate(`
    (() => {
      const sels = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], h1, h2, h3, h4, label, [data-testid], nav, [role="navigation"]';
      const els = document.querySelectorAll(sels);
      const items = [];
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200);
        if (!text && !['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) continue;

        // Build best selector
        let selector = '';
        if (el.id) selector = '#' + CSS.escape(el.id);
        else if (el.getAttribute('data-testid')) selector = '[data-testid="' + el.getAttribute('data-testid') + '"]';
        else if (el.getAttribute('aria-label')) selector = '[aria-label="' + el.getAttribute('aria-label') + '"]';

        items.push({
          tag: el.tagName.toLowerCase(),
          text,
          id: el.id || undefined,
          name: el.name || undefined,
          type: el.type || undefined,
          role: el.getAttribute('role') || undefined,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          dataTestid: el.getAttribute('data-testid') || undefined,
          href: (el.href || '').slice(0, 200) || undefined,
          placeholder: el.placeholder || undefined,
          selector: selector || undefined,
          y: Math.round(rect.y),
          clickable: ['A','BUTTON','SELECT'].includes(el.tagName) || el.getAttribute('role') === 'button' || style.cursor === 'pointer',
        });
      }
      items.sort((a, b) => a.y - b.y);
      return items;
    })()
  `)

  // Extract navigation links
  const links = elements
    .filter(e => e.tag === "a" && e.href && !e.href.startsWith("javascript:"))
    .map(e => ({ text: e.text, href: e.href }))

  // Extract forms
  const forms = elements
    .filter(e => ["input", "select", "textarea"].includes(e.tag))
    .map(e => ({
      tag: e.tag,
      type: e.type,
      name: e.name,
      id: e.id,
      placeholder: e.placeholder,
      selector: e.selector,
      ariaLabel: e.ariaLabel,
    }))

  // Extract buttons/actions
  const actions = elements
    .filter(e => e.clickable && e.tag !== "a")
    .map(e => ({
      text: e.text.slice(0, 80),
      selector: e.selector,
      tag: e.tag,
      id: e.id,
      ariaLabel: e.ariaLabel,
    }))

  // Extract headings for page structure
  const headings = elements
    .filter(e => ["h1", "h2", "h3", "h4"].includes(e.tag))
    .map(e => ({ level: parseInt(e.tag[1]), text: e.text.slice(0, 100) }))

  const catalog = {
    url: pageInfo.url,
    title: pageInfo.title,
    exploredAt: new Date().toISOString(),
    summary: {
      totalElements: elements.length,
      links: links.length,
      forms: forms.length,
      actions: actions.length,
      headings: headings.length,
    },
    headings,
    links,
    forms,
    actions,
    allElements: elements,
  }

  writeFileSync(outputPath, JSON.stringify(catalog, null, 2))
  console.log(`\nCatalog saved: ${outputPath}`)
  console.log(`  ${elements.length} elements, ${links.length} links, ${forms.length} form fields, ${actions.length} actions`)

  cdp.close()
  return catalog
}

// ─── Capture mode — replay skill + screenshot each step ───

async function capture(skillPath, outputDir) {
  const skill = JSON.parse(readFileSync(skillPath, "utf-8"))
  console.log(`Capturing walkthrough: ${skill.name} (${skill.steps.length} steps)`)

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })

  const cdp = await connectCDP(PORT)
  const screenshots = []

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i]
    console.log(`\n  Step ${i + 1}/${skill.steps.length}: ${step.title}`)

    // Navigate if needed
    if (step.action.type === "navigate" && step.action.url) {
      await cdp.send("Page.navigate", { url: step.action.url })
      await new Promise(r => setTimeout(r, 3000))
    }

    // Wait for element
    if (step.waitFor) {
      console.log(`    Waiting for: ${step.waitFor}`)
      await cdp.evaluate(`
        new Promise((resolve) => {
          const existing = document.querySelector(${JSON.stringify(step.waitFor.split(",")[0].trim())});
          if (existing) return resolve(true);
          const observer = new MutationObserver(() => {
            try {
              if (document.querySelector(${JSON.stringify(step.waitFor.split(",")[0].trim())})) {
                observer.disconnect();
                resolve(true);
              }
            } catch(e) { resolve(false); }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => { observer.disconnect(); resolve(false); }, 10000);
        })
      `)
    }

    // Apply delay
    if (step.delay) await new Promise(r => setTimeout(r, step.delay))

    // Highlight the target element
    const selector = step.target?.selector
    if (selector) {
      const caption = step.tooltip?.content || step.title
      await cdp.evaluate(`
        (() => {
          // Remove previous highlight
          document.getElementById('__ft-wt-highlight')?.remove();
          document.getElementById('__ft-wt-caption')?.remove();
          document.getElementById('__ft-wt-step')?.remove();

          let el;
          try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}

          // Try fallbacks
          ${step.target?.fallbacks ? `
          if (!el) {
            const fallbacks = ${JSON.stringify(step.target.fallbacks)};
            for (const fb of fallbacks) {
              try { el = document.querySelector(fb); if (el) break; } catch(e) {}
            }
          }` : ""}

          if (!el) return { found: false };

          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          const rect = el.getBoundingClientRect();

          // Highlight ring
          const ring = document.createElement('div');
          ring.id = '__ft-wt-highlight';
          ring.style.cssText = 'position:fixed;border:3px solid #14b8a6;border-radius:8px;box-shadow:0 0 0 4px rgba(20,184,166,0.3),0 0 30px rgba(20,184,166,0.15);pointer-events:none;z-index:2147483647;transition:none;left:'+(rect.left-8)+'px;top:'+(rect.top-8)+'px;width:'+(rect.width+16)+'px;height:'+(rect.height+16)+'px';
          document.body.appendChild(ring);

          // Step number badge
          const badge = document.createElement('div');
          badge.id = '__ft-wt-step';
          badge.textContent = ${JSON.stringify(String(i + 1))};
          badge.style.cssText = 'position:fixed;background:#14b8a6;color:#0d1117;font-family:-apple-system,system-ui,sans-serif;font-size:14px;font-weight:700;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;z-index:2147483647;pointer-events:none;left:'+(rect.left-20)+'px;top:'+(rect.top-20)+'px';
          document.body.appendChild(badge);

          // Caption tooltip
          const label = document.createElement('div');
          label.id = '__ft-wt-caption';
          label.textContent = ${JSON.stringify(caption)};
          label.style.cssText = 'position:fixed;background:#0d1117;color:#c9d1d9;font-family:-apple-system,system-ui,sans-serif;font-size:13px;padding:8px 14px;border-radius:8px;border:1px solid #14b8a6;z-index:2147483647;pointer-events:none;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,0.4);left:'+rect.left+'px;top:'+(rect.bottom+14)+'px';
          document.body.appendChild(label);

          return { found: true, tag: el.tagName.toLowerCase(), text: (el.textContent||'').trim().slice(0, 60) };
        })()
      `)
    }

    // Wait for highlight to render
    await new Promise(r => setTimeout(r, 800))

    // Take screenshot
    const filename = `step-${String(i + 1).padStart(2, "0")}-${step.id || "unknown"}.png`
    const filepath = join(outputDir, filename)
    const imageBuffer = await cdp.screenshot()
    writeFileSync(filepath, imageBuffer)
    console.log(`    Screenshot: ${filename} (${(imageBuffer.length / 1024).toFixed(1)} KB)`)

    screenshots.push({
      step: i + 1,
      id: step.id,
      title: step.title,
      description: step.description,
      tooltip: step.tooltip?.content,
      action: step.action,
      filename,
    })

    // Clean up highlight
    await cdp.evaluate(`
      document.getElementById('__ft-wt-highlight')?.remove();
      document.getElementById('__ft-wt-caption')?.remove();
      document.getElementById('__ft-wt-step')?.remove();
    `)

    // Execute action if it's a click or type (to advance the flow)
    if (step.action.type === "click" && selector) {
      await cdp.evaluate(`
        (() => {
          let el;
          try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) {}
          if (el) el.click();
        })()
      `)
      await new Promise(r => setTimeout(r, 1500))
    }
  }

  // Save manifest
  const manifest = {
    skill: skill.name,
    capturedAt: new Date().toISOString(),
    steps: screenshots,
  }
  writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2))
  console.log(`\nCapture complete: ${screenshots.length} screenshots in ${outputDir}`)

  cdp.close()
  return manifest
}

// ─── Guide mode — generate markdown from screenshots ───

async function guide(skillPath, screenshotsDir, outputPath) {
  const skill = JSON.parse(readFileSync(skillPath, "utf-8"))
  const manifest = JSON.parse(readFileSync(join(screenshotsDir, "manifest.json"), "utf-8"))

  let md = `# ${skill.name}\n\n`
  md += `${skill.description}\n\n`
  md += `---\n\n`

  for (const step of manifest.steps) {
    md += `## Step ${step.step}: ${step.title}\n\n`
    md += `${step.description}\n\n`
    if (step.tooltip) {
      md += `> ${step.tooltip}\n\n`
    }
    md += `![Step ${step.step} — ${step.title}](./${basename(screenshotsDir)}/${step.filename})\n\n`

    if (step.action.type === "click") {
      md += `**Action:** Click the highlighted element\n\n`
    } else if (step.action.type === "type") {
      md += `**Action:** Enter \`${step.action.value}\` in this field\n\n`
    } else if (step.action.type === "navigate") {
      md += `**Action:** Navigate to ${step.action.url}\n\n`
    } else if (step.action.type === "wait") {
      md += `**Action:** ${step.action.description}\n\n`
    }

    md += `---\n\n`
  }

  md += `*Generated by Field Trip Walkthrough Builder on ${new Date().toLocaleDateString()}*\n`

  writeFileSync(outputPath, md)
  console.log(`Guide generated: ${outputPath} (${manifest.steps.length} steps)`)
}

// ─── Main ───

const [,, mode, ...rest] = process.argv
const modeFlags = {}
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].replace(/^--/, "")
    modeFlags[key] = rest[i + 1] || true
    i++
  }
}

switch (mode) {
  case "explore":
    await explore(
      modeFlags.url || "http://localhost:3000",
      modeFlags.output || "catalog.json"
    )
    break

  case "capture":
    if (!modeFlags.skill) { console.error("--skill required"); process.exit(1) }
    await capture(
      modeFlags.skill,
      modeFlags["output-dir"] || modeFlags.output || "walkthrough"
    )
    break

  case "guide":
    if (!modeFlags.skill) { console.error("--skill required"); process.exit(1) }
    await guide(
      modeFlags.skill,
      modeFlags.screenshots || "walkthrough",
      modeFlags.output || "guide.md"
    )
    break

  default:
    console.log(`
Walkthrough Builder — explore, catalog, screenshot, document

  explore   Scan a site and catalog all interactive elements
            node cli/walkthrough-builder.mjs explore --url https://app.example.com --output catalog.json

  capture   Replay a skill document with highlighted screenshots
            node cli/walkthrough-builder.mjs capture --skill skills/my-flow.json --output-dir walkthrough/

  guide     Generate a markdown guide from captured screenshots
            node cli/walkthrough-builder.mjs guide --skill skills/my-flow.json --screenshots walkthrough/ --output guide.md

Full pipeline:
  1. explore → generates catalog.json
  2. Create/edit a skill document (or auto-generate from catalog)
  3. capture → replays skill with spotlighted screenshots
  4. guide → assembles markdown doc with embedded images
    `)
}

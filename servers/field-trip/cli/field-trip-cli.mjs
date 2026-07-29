#!/usr/bin/env node

/**
 * Field Trip CLI — drives the browser via Chrome DevTools Protocol (CDP).
 *
 * Uses the extension's DOMNavigator pattern (read, click, type, scroll, wait)
 * directly through CDP Runtime.evaluate, so we get all the same DOM interaction
 * that the content script uses — no Playwright needed.
 *
 * Usage:
 *   1. Launch Chrome with: chrome --remote-debugging-port=9222
 *   2. Navigate to TurboTax (or any site)
 *   3. Run: node cli/field-trip-cli.mjs --skill src/skills/turbotax-filing.json
 *
 * Flags:
 *   --skill <path>       Path to skill document JSON
 *   --port <number>      CDP port (default: 9222)
 *   --step <id>          Start at a specific step ID
 *   --auto               Don't pause for confirmation on safe steps
 *   --dry-run            Read-only — never click or type, just show what would happen
 */

import { readFileSync } from "fs"
import { createInterface } from "readline"
import http from "http"

// ─── CDP Client (minimal, no deps) ───

class CDPClient {
  constructor(port = 9222) {
    this.port = port
    this.ws = null
    this.msgId = 0
    this.pending = new Map()
  }

  /** List available targets (tabs) */
  async listTargets() {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${this.port}/json`, (res) => {
        let data = ""
        res.on("data", (chunk) => (data += chunk))
        res.on("end", () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error(`Failed to parse targets: ${e.message}`))
          }
        })
      }).on("error", (e) => {
        reject(new Error(
          `Cannot connect to Chrome on port ${this.port}. ` +
          `Launch Chrome with: chrome --remote-debugging-port=${this.port}\n` +
          `Error: ${e.message}`
        ))
      })
    })
  }

  /** Connect to a specific tab's WebSocket debugger URL */
  async connect(wsUrl) {
    const { WebSocket } = await import("ws")
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { perMessageDeflate: false })
      this.ws.on("open", () => resolve())
      this.ws.on("error", (e) => reject(e))
      this.ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      })
    })
  }

  /** Send a CDP command and await the result */
  async send(method, params = {}) {
    const id = ++this.msgId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate JS in the page context and return the result */
  async evaluate(expression, returnByValue = true) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Evaluation failed"
      )
    }
    return result.result?.value
  }

  async close() {
    if (this.ws) this.ws.close()
  }
}

// ─── DOM interaction via CDP (mirrors DOMNavigator API) ───

class RemoteNavigator {
  constructor(cdp) {
    this.cdp = cdp
  }

  /**
   * Inject the query helper into the page.
   * Converts :has-text('...') pseudo-selectors into JS-based DOM queries
   * since native querySelector doesn't support them.
   */
  async injectQueryHelper() {
    await this.cdp.evaluate(`
      if (!window.__ftQuery) {
        window.__ftQuery = function(selector) {
          // Check if selector uses :has-text() pseudo-selector
          const hasTextMatch = selector.match(/^(.+?):has-text\\(['"](.+?)['"]\\)$/);
          if (hasTextMatch) {
            const [, tagPart, text] = hasTextMatch;
            const tag = tagPart.trim() || '*';
            const candidates = document.querySelectorAll(tag);
            const lower = text.toLowerCase();
            for (const el of candidates) {
              if (el.textContent && el.textContent.trim().toLowerCase().includes(lower)) {
                return el;
              }
            }
            return null;
          }

          // Check for label:has-text('X') ~ input or + input patterns
          const labelInputMatch = selector.match(/^label:has-text\\(['"](.+?)['"]\\)\\s*([~+])\\s*(.+)$/);
          if (labelInputMatch) {
            const [, text, combinator, target] = labelInputMatch;
            const labels = document.querySelectorAll('label');
            const lower = text.toLowerCase();
            for (const label of labels) {
              if (label.textContent && label.textContent.trim().toLowerCase().includes(lower)) {
                if (combinator === '+') {
                  const next = label.nextElementSibling;
                  if (next && next.matches(target)) return next;
                } else {
                  let sib = label.nextElementSibling;
                  while (sib) {
                    try { if (sib.matches(target)) return sib; } catch(e) {}
                    sib = sib.nextElementSibling;
                  }
                }
              }
            }
            return null;
          }

          // Check for div/fieldset:has-text('X') input patterns
          const containerMatch = selector.match(/^(\\w+):has-text\\(['"](.+?)['"]\\)\\s+(.+)$/);
          if (containerMatch) {
            const [, container, text, child] = containerMatch;
            const containers = document.querySelectorAll(container);
            const lower = text.toLowerCase();
            for (const el of containers) {
              if (el.textContent && el.textContent.trim().toLowerCase().includes(lower)) {
                const found = el.querySelector(child);
                if (found) return found;
              }
            }
            return null;
          }

          // Standard querySelector
          try {
            return document.querySelector(selector);
          } catch (e) {
            return null;
          }
        };

        window.__ftQueryAll = function(selector) {
          const hasTextMatch = selector.match(/^(.+?):has-text\\(['"](.+?)['"]\\)$/);
          if (hasTextMatch) {
            const [, tagPart, text] = hasTextMatch;
            const tag = tagPart.trim() || '*';
            const candidates = document.querySelectorAll(tag);
            const lower = text.toLowerCase();
            const results = [];
            for (const el of candidates) {
              if (el.textContent && el.textContent.trim().toLowerCase().includes(lower)) {
                results.push(el);
              }
            }
            return results;
          }
          try {
            return Array.from(document.querySelectorAll(selector));
          } catch (e) {
            return [];
          }
        };
      }
    `)
  }

  /** Read an element's text, attributes, rect, visibility */
  async readElement(selector) {
    return this.cdp.evaluate(`
      (() => {
        const el = window.__ftQuery(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        const style = getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) !== 0;
        return {
          text: (el.textContent || '').trim().slice(0, 500),
          tagName: el.tagName.toLowerCase(),
          attributes: attrs,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible,
          value: el.value !== undefined ? el.value : undefined,
        };
      })()
    `)
  }

  /** Find elements by text content */
  async findByText(text, tag) {
    return this.cdp.evaluate(`
      (() => {
        const results = [];
        const lower = ${JSON.stringify(text)}.toLowerCase();
        const tagFilter = ${JSON.stringify(tag || null)};
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.textContent && node.textContent.toLowerCase().includes(lower)
              ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
        });
        const seen = new Set();
        let node;
        while ((node = walker.nextNode())) {
          const el = node.parentElement;
          if (!el || seen.has(el)) continue;
          if (tagFilter && el.tagName.toLowerCase() !== tagFilter.toLowerCase()) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          results.push({
            text: (el.textContent || '').trim().slice(0, 300),
            tagName: el.tagName.toLowerCase(),
            attributes: attrs,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible: true,
          });
        }
        return results;
      })()
    `)
  }

  /** Find all interactive elements on the page */
  async findInteractive() {
    return this.cdp.evaluate(`
      (() => {
        const sels = "a, button, input, select, textarea, [role='button'], [tabindex]";
        const els = document.querySelectorAll(sels);
        const results = [];
        for (const el of els) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          results.push({
            text: (el.textContent || '').trim().slice(0, 200),
            tagName: el.tagName.toLowerCase(),
            attributes: attrs,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            value: el.value !== undefined ? el.value : undefined,
          });
        }
        return results;
      })()
    `)
  }

  /** Click an element */
  async click(selector) {
    return this.cdp.evaluate(`
      (() => {
        const el = window.__ftQuery(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()
    `)
  }

  /** Type text into an input/textarea */
  async typeText(selector, value, clearFirst = false) {
    return this.cdp.evaluate(`
      (() => {
        const el = window.__ftQuery(${JSON.stringify(selector)});
        if (!el || !('value' in el)) return false;
        el.focus();
        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        if (${clearFirst}) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
  }

  /** Select a dropdown value */
  async select(selector, value) {
    return this.cdp.evaluate(`
      (() => {
        const el = window.__ftQuery(${JSON.stringify(selector)});
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()
    `)
  }

  /** Scroll an element into view */
  async scrollTo(selector) {
    return this.cdp.evaluate(`
      (() => {
        const el = window.__ftQuery(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      })()
    `)
  }

  /** Wait for an element to appear in the DOM */
  async waitForElement(selector, timeout = 10000) {
    return this.cdp.evaluate(`
      new Promise((resolve) => {
        const existing = window.__ftQuery(${JSON.stringify(selector)});
        if (existing) return resolve(true);
        let timer;
        const observer = new MutationObserver(() => {
          if (window.__ftQuery(${JSON.stringify(selector)})) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(true);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(() => { observer.disconnect(); resolve(false); }, ${timeout});
      })
    `)
  }

  /** Get current page info */
  async getPageInfo() {
    return this.cdp.evaluate(`
      ({ url: location.href, title: document.title, readyState: document.readyState })
    `)
  }

  /** Navigate to a URL */
  async navigate(url) {
    await this.cdp.send("Page.navigate", { url })
    // Wait for load
    await this.cdp.evaluate(`
      new Promise(resolve => {
        if (document.readyState === 'complete') return resolve(true);
        window.addEventListener('load', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 15000);
      })
    `)
    // Re-inject query helper on new page
    await this.injectQueryHelper()
  }

  /** Try multiple selectors until one matches */
  async resolveSelector(target) {
    // Try primary selector
    const primary = await this.readElement(target.selector)
    if (primary) return { element: primary, selector: target.selector }

    // Try fallbacks
    if (target.fallbacks) {
      for (const fallback of target.fallbacks) {
        const el = await this.readElement(fallback)
        if (el) return { element: el, selector: fallback }
      }
    }

    // Try finding by expected text
    if (target.expectedText) {
      const byText = await this.findByText(target.expectedText)
      if (byText && byText.length > 0) {
        return { element: byText[0], selector: null, foundByText: true }
      }
    }

    return null
  }
}

// ─── CLI Runner ───

class FieldTripCLI {
  constructor(options) {
    this.skillPath = options.skill
    this.port = options.port || 9222
    this.startStep = options.step || null
    this.autoMode = options.auto || false
    this.dryRun = options.dryRun || false
    this.cdp = new CDPClient(this.port)
    this.nav = null
    this.rl = createInterface({ input: process.stdin, output: process.stdout })
  }

  async prompt(question) {
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => resolve(answer.trim()))
    })
  }

  log(msg) {
    console.log(`\x1b[36m[field-trip]\x1b[0m ${msg}`)
  }

  success(msg) {
    console.log(`\x1b[32m  ✓\x1b[0m ${msg}`)
  }

  warn(msg) {
    console.log(`\x1b[33m  ⚠\x1b[0m ${msg}`)
  }

  error(msg) {
    console.log(`\x1b[31m  ✗\x1b[0m ${msg}`)
  }

  step(index, total, title) {
    console.log(`\n\x1b[1m\x1b[35m━━━ Step ${index + 1}/${total}: ${title} ━━━\x1b[0m`)
  }

  /** Classify whether a step needs user confirmation */
  isSensitiveStep(step) {
    // Always confirm steps that type sensitive data
    const sensitivePatterns = /ssn|social.security|bank|routing|account.number|password|ein|wages|income|refund/i
    if (step.action.type === "type" && sensitivePatterns.test(step.id + " " + step.title)) {
      return true
    }
    // Click actions on submit/file/pay buttons
    if (step.action.type === "click" && /submit|file|pay|sign|e-file/i.test(step.id + " " + step.title)) {
      return true
    }
    return false
  }

  async run() {
    // Load skill document
    this.log("Loading skill document...")
    const skillJson = readFileSync(this.skillPath, "utf-8")
    const skill = JSON.parse(skillJson)
    this.log(`Skill: ${skill.name} (${skill.steps.length} steps)`)
    this.log(`Target: ${skill.targetApp}`)

    // Connect to Chrome via CDP
    this.log(`Connecting to Chrome on port ${this.port}...`)
    const targets = await this.cdp.listTargets()
    const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))

    if (pages.length === 0) {
      this.error("No browser tabs found. Open a tab first.")
      process.exit(1)
    }

    // Show available tabs
    console.log("\nAvailable tabs:")
    pages.forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.title} — ${p.url}`)
    })

    // Auto-select matching tab or ask
    let target = pages.find((p) =>
      skill.urlPatterns.some((pattern) => {
        const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
        return regex.test(p.url)
      })
    )

    if (!target) {
      if (pages.length === 1) {
        target = pages[0]
      } else {
        const choice = await this.prompt(`\nSelect tab (1-${pages.length}): `)
        target = pages[parseInt(choice) - 1] || pages[0]
      }
    }

    this.log(`Connecting to: ${target.title}`)
    await this.cdp.connect(target.webSocketDebuggerUrl)
    this.nav = new RemoteNavigator(this.cdp)
    await this.nav.injectQueryHelper()

    // Get page info
    const pageInfo = await this.nav.getPageInfo()
    this.log(`Page: ${pageInfo.title} (${pageInfo.url})`)

    // Find starting step
    let startIndex = 0
    if (this.startStep) {
      const idx = skill.steps.findIndex((s) => s.id === this.startStep)
      if (idx >= 0) {
        startIndex = idx
        this.log(`Starting at step: ${this.startStep} (${idx + 1}/${skill.steps.length})`)
      } else {
        this.warn(`Step "${this.startStep}" not found, starting from beginning`)
      }
    }

    // Execute steps
    for (let i = startIndex; i < skill.steps.length; i++) {
      const stepDef = skill.steps[i]
      this.step(i, skill.steps.length, stepDef.title)
      console.log(`  ${stepDef.description}`)

      if (stepDef.tooltip?.content) {
        console.log(`\x1b[2m  ${stepDef.tooltip.content}\x1b[0m`)
      }

      // Handle navigation steps
      if (stepDef.action.type === "navigate" && stepDef.action.url) {
        if (this.dryRun) {
          this.warn(`[DRY RUN] Would navigate to: ${stepDef.action.url}`)
        } else {
          this.log(`Navigating to ${stepDef.action.url}...`)
          await this.nav.navigate(stepDef.action.url)
          this.success("Navigated")
        }
        continue
      }

      // Wait for prerequisite element
      if (stepDef.waitFor) {
        this.log(`Waiting for: ${stepDef.waitFor}`)
        const found = await this.nav.waitForElement(stepDef.waitFor.split(",")[0].trim(), 15000)
        if (!found) {
          this.warn("Wait target not found, continuing anyway...")
        }
      }

      // Apply delay
      if (stepDef.delay) {
        await new Promise((r) => setTimeout(r, stepDef.delay))
      }

      // Find target element
      const resolved = await this.nav.resolveSelector(stepDef.target)
      if (!resolved) {
        this.warn(`Target not found: ${stepDef.target.selector}`)
        const action = await this.prompt("  (s)kip, (r)etry, (q)uit? ")
        if (action === "r") { i--; continue }
        if (action === "q") break
        continue
      }

      const { element, selector } = resolved
      this.success(`Found: <${element.tagName}> "${element.text?.slice(0, 60) || ""}"`)
      if (element.value !== undefined && element.value !== "") {
        console.log(`  Current value: "${element.value}"`)
      }

      // Execute action
      const needsConfirm = !this.autoMode || this.isSensitiveStep(stepDef)

      switch (stepDef.action.type) {
        case "spotlight":
          // Just highlight — scroll into view
          if (selector) await this.nav.scrollTo(selector)
          this.success("Spotlighted")
          break

        case "click": {
          const clickSelector = stepDef.action.selector || selector
          if (!clickSelector) {
            this.warn("No selector available for click")
            break
          }
          if (this.dryRun) {
            this.warn(`[DRY RUN] Would click: ${clickSelector}`)
            break
          }
          if (needsConfirm) {
            const confirm = await this.prompt("  Click this element? (y/n/s)kip: ")
            if (confirm !== "y") break
          }
          const clicked = await this.nav.click(clickSelector)
          clicked ? this.success("Clicked") : this.error("Click failed")
          // Wait for any page transitions
          await new Promise((r) => setTimeout(r, 1000))
          break
        }

        case "type": {
          const typeSelector = stepDef.action.selector || selector
          if (!typeSelector) {
            this.warn("No selector available for type")
            break
          }
          let value = stepDef.action.value
          // If value contains a placeholder like {{income}}, prompt for it
          const placeholders = value.match(/\{\{(\w+)\}\}/g)
          if (placeholders) {
            for (const ph of placeholders) {
              const key = ph.replace(/[{}]/g, "")
              const input = await this.prompt(`  Enter ${key}: `)
              value = value.replace(ph, input)
            }
          }
          if (this.dryRun) {
            this.warn(`[DRY RUN] Would type "${value}" into: ${typeSelector}`)
            break
          }
          if (needsConfirm) {
            const confirm = await this.prompt(`  Type "${value}" here? (y/n/e)dit: `)
            if (confirm === "e") {
              value = await this.prompt("  Enter value: ")
            } else if (confirm !== "y") break
          }
          const typed = await this.nav.typeText(typeSelector, value, true)
          typed ? this.success(`Typed: ${value}`) : this.error("Type failed")
          break
        }

        case "select": {
          const selSelector = stepDef.action.selector || selector
          if (!selSelector) break
          let value = stepDef.action.value
          const placeholders = value.match(/\{\{(\w+)\}\}/g)
          if (placeholders) {
            for (const ph of placeholders) {
              const key = ph.replace(/[{}]/g, "")
              const input = await this.prompt(`  Select ${key}: `)
              value = value.replace(ph, input)
            }
          }
          if (this.dryRun) {
            this.warn(`[DRY RUN] Would select "${value}" in: ${selSelector}`)
            break
          }
          if (needsConfirm) {
            const confirm = await this.prompt(`  Select "${value}"? (y/n): `)
            if (confirm !== "y") break
          }
          const selected = await this.nav.select(selSelector, value)
          selected ? this.success(`Selected: ${value}`) : this.error("Select failed")
          break
        }

        case "wait": {
          this.log(stepDef.action.description || "Waiting for user action...")
          await this.prompt("  Press Enter when ready to continue...")
          break
        }
      }

      // Validate step completion
      if (stepDef.validation) {
        await new Promise((r) => setTimeout(r, 500))
        const v = stepDef.validation

        if (v.expectSelector) {
          const found = await this.nav.waitForElement(v.expectSelector, v.timeout || 5000)
          found ? this.success("Validation: expected element found") : this.warn("Validation: expected element not found")
        }

        if (v.expectText) {
          const pageInfo = await this.nav.getPageInfo()
          const bodyText = await this.cdp.evaluate("document.body.innerText.slice(0, 5000)")
          if (bodyText && bodyText.includes(v.expectText)) {
            this.success(`Validation: found "${v.expectText}"`)
          } else {
            this.warn(`Validation: "${v.expectText}" not found on page`)
          }
        }

        if (v.expectUrl) {
          const pageInfo = await this.nav.getPageInfo()
          const urlPattern = new RegExp("^" + v.expectUrl.replace(/\*/g, ".*") + "$")
          if (urlPattern.test(pageInfo.url)) {
            this.success("Validation: URL matches")
          } else {
            this.warn(`Validation: expected URL ${v.expectUrl}, got ${pageInfo.url}`)
          }
        }
      }
    }

    console.log("\n\x1b[1m\x1b[32m━━━ Skill complete! ━━━\x1b[0m\n")
    this.rl.close()
    await this.cdp.close()
  }
}

// ─── Argument parsing ───

function parseArgs() {
  const args = process.argv.slice(2)
  const options = {}

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--skill":
        options.skill = args[++i]
        break
      case "--port":
        options.port = parseInt(args[++i])
        break
      case "--step":
        options.step = args[++i]
        break
      case "--auto":
        options.auto = true
        break
      case "--dry-run":
        options.dryRun = true
        break
      case "--help":
      case "-h":
        console.log(`
Field Trip CLI — drive any web app from the terminal

Usage: node cli/field-trip-cli.mjs --skill <path.json> [options]

Options:
  --skill <path>    Path to skill document JSON (required)
  --port <number>   Chrome CDP port (default: 9222)
  --step <id>       Start at a specific step ID
  --auto            Skip confirmations on non-sensitive steps
  --dry-run         Read-only mode — show what would happen without acting
  --help            Show this help
        `)
        process.exit(0)
    }
  }

  if (!options.skill) {
    console.error("Error: --skill <path> is required. Run with --help for usage.")
    process.exit(1)
  }

  return options
}

// ─── Main ───

const options = parseArgs()
const cli = new FieldTripCLI(options)
cli.run().catch((err) => {
  console.error(`\x1b[31mFatal:\x1b[0m ${err.message}`)
  process.exit(1)
})

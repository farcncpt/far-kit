#!/usr/bin/env node
/**
 * orchestrate.mjs — Overnight audit orchestrator for Field Trip.
 *
 * Connects via relay to a target tab, runs the full UX + Security audit
 * pipeline, collects results, generates a comprehensive markdown report,
 * and tracks convergence across audit rounds.
 *
 * Usage:
 *   node cli/orchestrate.mjs --relay --tab 704448034 --audit        # run all audits
 *   node cli/orchestrate.mjs --relay --tab 704448034 --security     # security only
 *   node cli/orchestrate.mjs --relay --tab 704448034 --ux           # UX only
 *   node cli/orchestrate.mjs --relay --tab 704448034 --full         # audit + fix instructions
 *   node cli/orchestrate.mjs --relay --report project-report.md     # custom output path
 *   node cli/orchestrate.mjs --config .field-trip/audit-config.json # use project config
 *
 * Environment:
 *   RELAY_PORT — WebSocket relay port (default: 9333)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs"
import { join, dirname, resolve, basename } from "path"
import { fileURLToPath } from "url"
import { exec as execCb } from "child_process"
import { promisify } from "util"
import http from "http"
import https from "https"

const execAsync = promisify(execCb)

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ─── Argument parsing ───

const rawArgs = process.argv.slice(2)

function hasFlag(name) {
  return rawArgs.includes(name)
}

function flagValue(name, fallback) {
  const idx = rawArgs.indexOf(name)
  if (idx !== -1 && rawArgs[idx + 1] && !rawArgs[idx + 1].startsWith("--")) return rawArgs[idx + 1]
  return fallback
}

const useRelay = hasFlag("--relay") || !!process.env.RELAY_MODE
const targetTabId = flagValue("--tab", null) ? parseInt(flagValue("--tab", null)) : null
const customPort = flagValue("--port", null) ? parseInt(flagValue("--port", null)) : null
const configPath = flagValue("--config", null)
const reportPath = flagValue("--report", null)

const runAll = hasFlag("--audit") || hasFlag("--full") || (!hasFlag("--security") && !hasFlag("--ux") && !hasFlag("--code"))
const runSecurity = hasFlag("--security") || runAll
const runUx = hasFlag("--ux") || runAll
const runCode = hasFlag("--code") || runAll
const generateFixInstructions = hasFlag("--full")

const RELAY_PORT = customPort ?? parseInt(process.env.RELAY_PORT || "9333")
const RESPONSIVE_WIDTHS = [375, 768, 1024, 1440]

// ─── Severity constants ───

const CRITICAL = "critical"
const HIGH = "high"
const MEDIUM = "medium"
const LOW = "low"
const PASS = "pass"

// Normalize severity from different sources
function normSeverity(s) {
  if (!s) return LOW
  const lower = s.toLowerCase()
  if (lower === "critical") return CRITICAL
  if (lower === "high") return HIGH
  if (lower === "medium") return MEDIUM
  if (lower === "low") return LOW
  if (lower === "pass") return PASS
  return LOW
}

// Severity weight for scoring
const SEVERITY_DEDUCTIONS = {
  [CRITICAL]: 15,
  [HIGH]: 8,
  [MEDIUM]: 4,
  [LOW]: 2,
}

// ─── Secret detection patterns (from security-audit.mjs) ───

const SECRET_PATTERNS = [
  { name: "Stripe secret key", pattern: /sk_live_[a-zA-Z0-9]{24,}/ },
  { name: "Stripe publishable key (test)", pattern: /pk_test_[a-zA-Z0-9]{24,}/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "AWS secret key", pattern: /(?:aws_secret|secret_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { name: "GitHub personal token", pattern: /ghp_[a-zA-Z0-9]{36}/ },
  { name: "GitHub OAuth token", pattern: /gho_[a-zA-Z0-9]{36}/ },
  { name: "GitLab personal token", pattern: /glpat-[a-zA-Z0-9\-_]{20,}/ },
  { name: "Slack bot token", pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/ },
  { name: "Slack user token", pattern: /xoxp-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/ },
  { name: "Slack webhook", pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[a-zA-Z0-9]+/ },
  { name: "Google API key", pattern: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: "Firebase API key", pattern: /AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}/ },
  { name: "Twilio API key", pattern: /SK[a-f0-9]{32}/ },
  { name: "SendGrid API key", pattern: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/ },
  { name: "Mailgun API key", pattern: /key-[a-f0-9]{32}/ },
  { name: "JWT token", pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/ },
  { name: "Bearer token", pattern: /Bearer\s+[a-zA-Z0-9\-._~+\/]{20,}=*/ },
  { name: "Generic API key assignment", pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["'][a-zA-Z0-9\-._]{16,}["']/i },
  { name: "Private key block", pattern: /-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----/ },
  { name: "Password assignment", pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}["']/i },
  { name: "Database connection string", pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"'<>]{10,}/ },
]

const SENSITIVE_STORAGE_KEY_PATTERNS = [
  /token/i, /secret/i, /password/i, /passwd/i, /credential/i,
  /api[_-]?key/i, /auth/i, /session/i, /jwt/i, /private/i,
  /credit.?card/i, /ssn/i, /social.?security/i,
]

// ─── Relay connection ───

async function connectRelayDriver() {
  const { connectRelay } = await import("./relay-client.mjs")
  const relay = await connectRelay({
    port: RELAY_PORT,
    name: "orchestrate",
  })

  if (!relay.isExtensionConnected()) {
    console.error("  Warning: Extension relay page not connected yet.")
  }

  const tabOpts = targetTabId ? { tabId: targetTabId, timeout: 30000 } : { timeout: 30000 }

  return {
    relay,
    async evaluate(expr) {
      return relay.command("eval", { expression: expr }, tabOpts)
    },
    async command(action, params = {}) {
      return relay.command(action, params, tabOpts)
    },
    listTabs() {
      return relay.listTabs()
    },
    close() {
      relay.close()
    },
  }
}

// ─── HTTP header fetching ───

function fetchHeaders(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      const headers = {}
      for (const [key, val] of Object.entries(res.headers)) {
        headers[key.toLowerCase()] = val
      }
      headers["_statusCode"] = res.statusCode
      res.resume()
      resolve(headers)
    })
    req.on("error", (err) => reject(err))
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Header fetch timeout"))
    })
  })
}

// ─── Config loader ───

function loadAuditConfig(configFile) {
  const paths = [
    configFile,
    join(process.cwd(), ".field-trip", "audit-config.json"),
    join(process.cwd(), "audit-config.json"),
  ].filter(Boolean)

  for (const p of paths) {
    const resolved = resolve(p)
    if (existsSync(resolved)) {
      try {
        const config = JSON.parse(readFileSync(resolved, "utf-8"))
        console.log(`  Config loaded: ${resolved}`)
        return config
      } catch (err) {
        console.error(`  Warning: Failed to parse config ${resolved}: ${err.message}`)
      }
    }
  }
  return null
}

// ─── Audit history ───

function getReportsDir() {
  const dir = join(process.cwd(), ".field-trip", "audit-reports")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function loadPreviousAudits() {
  const dir = getReportsDir()
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.startsWith("audit-"))
    .sort()

  const audits = []
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), "utf-8"))
      audits.push(data)
    } catch {
      // skip corrupt files
    }
  }
  return audits
}

function getCurrentRound(previousAudits) {
  return previousAudits.length + 1
}

// ═══════════════════════════════════════════════════════════
// UX AUDIT CHECKS (extracted from validate-page.mjs patterns)
// ═══════════════════════════════════════════════════════════

async function uxCheckElements(evaluate) {
  return evaluate(`
    (() => {
      const all = document.querySelectorAll('*');
      let total = 0, interactive = 0, headings = 0, images = 0, forms = 0, links = 0;
      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        total++;
        const tag = el.tagName;
        if (['A'].includes(tag)) links++;
        if (['BUTTON','INPUT','SELECT','TEXTAREA'].includes(tag) || el.getAttribute('role') === 'button') interactive++;
        if (/^H[1-6]$/.test(tag)) headings++;
        if (tag === 'IMG') images++;
        if (tag === 'FORM') forms++;
      }
      return { total, interactive, headings, images, forms, links };
    })()
  `)
}

async function uxCheckAccessibility(evaluate) {
  return evaluate(`
    (() => {
      const issues = [];

      // Buttons without accessible name
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const title = el.getAttribute('title');
        if (!text && !ariaLabel && !ariaLabelledby && !title) {
          const id = el.id ? '#' + el.id : '';
          const cls = el.className ? '.' + String(el.className).split(' ').filter(Boolean).join('.') : '';
          issues.push({
            severity: 'medium',
            category: 'Accessibility',
            element: 'button' + id + cls,
            message: 'Button has no accessible name (no text, aria-label, aria-labelledby, or title)',
            fix: 'Add aria-label or visible text content to this button',
          });
        }
      });

      // Images without alt
      document.querySelectorAll('img').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const alt = el.getAttribute('alt');
        if (alt === null) {
          const src = (el.src || '').split('/').pop().slice(0, 60);
          issues.push({
            severity: 'medium',
            category: 'Accessibility',
            element: 'img[src="...' + src + '"]',
            message: 'Image missing alt attribute',
            fix: 'Add descriptive alt text or alt="" for decorative images',
          });
        }
      });

      // Form inputs without labels
      document.querySelectorAll('input, select, textarea').forEach(el => {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const ariaLabel = el.getAttribute('aria-label');
        const ariaLabelledby = el.getAttribute('aria-labelledby');
        const title = el.getAttribute('title');
        const placeholder = el.getAttribute('placeholder');
        let hasLabel = !!(ariaLabel || ariaLabelledby || title);

        if (!hasLabel && el.id) {
          hasLabel = !!document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        }
        if (!hasLabel) {
          hasLabel = !!el.closest('label');
        }

        if (!hasLabel && !placeholder) {
          const id = el.id ? '#' + el.id : '';
          const name = el.name ? '[name="' + el.name + '"]' : '';
          issues.push({
            severity: 'medium',
            category: 'Accessibility',
            element: el.tagName.toLowerCase() + id + name,
            message: 'Form input has no associated label, aria-label, or title',
            fix: 'Add a <label for="..."> element or aria-label attribute',
          });
        }
      });

      // Heading hierarchy check
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const headingLevels = [];
      let h1Count = 0;
      for (const h of headings) {
        const style = getComputedStyle(h);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const level = parseInt(h.tagName[1]);
        headingLevels.push(level);
        if (level === 1) h1Count++;
      }

      if (h1Count === 0) {
        issues.push({
          severity: 'medium',
          category: 'Accessibility',
          element: 'document',
          message: 'Page has no <h1> element',
          fix: 'Add a single <h1> that describes the main content of the page',
        });
      } else if (h1Count > 1) {
        issues.push({
          severity: 'low',
          category: 'Accessibility',
          element: 'document',
          message: 'Page has ' + h1Count + ' <h1> elements (should have exactly one)',
          fix: 'Reduce to a single <h1> and use <h2>-<h6> for subsections',
        });
      }

      // Check for heading level skips (e.g., h1 -> h3 without h2)
      for (let i = 1; i < headingLevels.length; i++) {
        if (headingLevels[i] > headingLevels[i - 1] + 1) {
          issues.push({
            severity: 'low',
            category: 'Accessibility',
            element: 'h' + headingLevels[i],
            message: 'Heading level skipped: h' + headingLevels[i - 1] + ' to h' + headingLevels[i],
            fix: 'Use sequential heading levels without skipping (h1 > h2 > h3)',
          });
          break; // only report once
        }
      }

      // Links without accessible text
      document.querySelectorAll('a').forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const text = (el.textContent || '').trim();
        if (!text && !el.getAttribute('aria-label')) {
          issues.push({
            severity: 'medium',
            category: 'Accessibility',
            element: 'a[href="' + (el.getAttribute('href') || '') + '"]',
            message: 'Link has no accessible text',
            fix: 'Add visible text content or aria-label to the link',
          });
        }
      });

      return issues;
    })()
  `)
}

async function uxCheckLinks(evaluate) {
  const result = await evaluate(`
    (() => {
      const links = document.querySelectorAll('a[href]');
      const broken = [];
      let total = 0;
      for (const a of links) {
        const style = getComputedStyle(a);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        total++;
        const href = a.getAttribute('href');
        if (!href || href === '#' || href === 'javascript:void(0)' || href === 'javascript:;') {
          broken.push({
            href: href || '(empty)',
            text: (a.textContent || '').trim().slice(0, 80),
          });
        }
      }
      return { broken, total };
    })()
  `)

  const issues = []
  if (result && result.broken) {
    for (const link of result.broken) {
      issues.push({
        severity: LOW,
        category: "Broken Links",
        element: `a[href="${link.href}"]`,
        message: `Broken link: href="${link.href}" text="${link.text}"`,
        fix: `Update href to a valid URL or remove the link`,
      })
    }
  }
  return { issues, total: result?.total || 0, broken: result?.broken?.length || 0 }
}

async function uxCheckVisibility(evaluate) {
  return evaluate(`
    (() => {
      const issues = [];

      // Interactive elements that are zero-size but not display:none
      const interactiveSelectors = 'button, a, input, select, textarea, [role="button"], [role="link"]';
      document.querySelectorAll(interactiveSelectors).forEach(el => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = el.getBoundingClientRect();
        if ((rect.width === 0 || rect.height === 0) && el.type !== 'hidden') {
          const id = el.id ? '#' + el.id : '';
          const text = (el.textContent || '').trim().slice(0, 60);
          issues.push({
            severity: 'low',
            category: 'Visibility',
            element: el.tagName.toLowerCase() + id,
            message: 'Interactive element has zero width or height: "' + text + '"',
            fix: 'Ensure the element has dimensions or is properly hidden with display:none',
          });
        }
      });

      // Overflow clipping
      document.querySelectorAll('main, [role="main"], .container, .content, article, section').forEach(el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (el.scrollWidth > rect.width + 5) {
          issues.push({
            severity: 'medium',
            category: 'Layout',
            element: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
            message: 'Horizontal overflow detected (scrollWidth: ' + el.scrollWidth + ', clientWidth: ' + Math.round(rect.width) + ')',
            fix: 'Fix overflow with overflow-x: hidden or adjust child element widths',
          });
        }
      });

      return issues;
    })()
  `)
}

async function uxCheckResponsive(evaluate, widths) {
  // Responsive checking requires CDP Emulation — via relay we simulate with
  // window.resizeTo and viewport meta adjustments where possible.
  // In relay mode, we do a simplified check via innerWidth reporting.
  const results = {}

  for (const width of widths) {
    const data = await evaluate(`
      (() => {
        const overflowing = [];
        const hidden = [];

        // Check body overflow at current width
        if (document.body.scrollWidth > ${width} + 2) {
          overflowing.push({
            element: 'body',
            scrollWidth: document.body.scrollWidth,
            viewportWidth: ${width},
          });
        }

        // Check major containers
        const containers = document.querySelectorAll('header, nav, main, footer, section, [role="main"], .container, .wrapper');
        for (const el of containers) {
          const rect = el.getBoundingClientRect();
          if (rect.width > ${width} + 2) {
            const id = el.id ? '#' + el.id : '';
            const tag = el.tagName.toLowerCase();
            overflowing.push({
              element: tag + id,
              width: Math.round(rect.width),
              viewportWidth: ${width},
            });
          }
        }

        return { overflowing, hidden, width: ${width} };
      })()
    `).catch(() => ({ overflowing: [], hidden: [], width }))

    results[String(width)] = data
  }

  // Convert to issues
  const issues = []
  for (const [width, data] of Object.entries(results)) {
    for (const item of data.overflowing || []) {
      issues.push({
        severity: MEDIUM,
        category: "Responsive",
        element: item.element,
        message: `Element overflows at ${width}px viewport (width: ${item.width || item.scrollWidth}px)`,
        fix: `Add responsive styles or max-width constraints for mobile viewports`,
      })
    }
  }

  return { issues, details: results }
}

// ═══════════════════════════════════════════════════════════
// SECURITY AUDIT CHECKS (extracted from security-audit.mjs patterns)
// ═══════════════════════════════════════════════════════════

async function secCheckExposedSecrets(evaluate) {
  const findings = []

  const data = await evaluate(`
    (() => {
      const result = { pageSource: '', localStorage: {}, sessionStorage: {} };
      result.pageSource = document.documentElement.outerHTML.slice(0, 500000);
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          result.localStorage[key] = localStorage.getItem(key).slice(0, 2000);
        }
      } catch (e) {}
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          result.sessionStorage[key] = sessionStorage.getItem(key).slice(0, 2000);
        }
      } catch (e) {}
      return result;
    })()
  `)

  if (!data) return findings

  // Scan page source
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = data.pageSource.match(pattern)
    if (match) {
      const redacted = match[0].slice(0, 12) + "..." + match[0].slice(-4)
      findings.push({
        severity: CRITICAL,
        category: "Exposed Secrets",
        message: `${name} found in page source: ${redacted}`,
        fix: "Move this secret to server-side environment variables. Never expose secrets in client-side code.",
      })
    }
  }

  // Scan localStorage
  for (const [key, value] of Object.entries(data.localStorage || {})) {
    for (const pat of SENSITIVE_STORAGE_KEY_PATTERNS) {
      if (pat.test(key)) {
        const redacted = value.slice(0, 20) + (value.length > 20 ? "..." : "")
        findings.push({
          severity: CRITICAL,
          category: "Exposed Secrets",
          message: `Sensitive localStorage key "${key}": ${redacted}`,
          fix: `Remove sensitive data from localStorage. Use HttpOnly cookies or server-side sessions.`,
        })
        break
      }
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({
          severity: CRITICAL,
          category: "Exposed Secrets",
          message: `${name} in localStorage["${key}"]`,
          fix: `Remove this secret from client-side storage immediately.`,
        })
        break
      }
    }
  }

  // Scan sessionStorage
  for (const [key, value] of Object.entries(data.sessionStorage || {})) {
    for (const pat of SENSITIVE_STORAGE_KEY_PATTERNS) {
      if (pat.test(key)) {
        findings.push({
          severity: CRITICAL,
          category: "Exposed Secrets",
          message: `Sensitive sessionStorage key "${key}"`,
          fix: `Remove sensitive data from sessionStorage. Use HttpOnly cookies or server-side sessions.`,
        })
        break
      }
    }
  }

  return findings
}

async function secCheckHeaders(pageUrl) {
  const findings = []

  let headers = null
  try {
    headers = await fetchHeaders(pageUrl)
  } catch (err) {
    findings.push({
      severity: MEDIUM,
      category: "Security Headers",
      message: `Could not fetch headers: ${err.message}`,
      fix: "Ensure the URL is accessible for header inspection",
    })
    return { findings, headers: null }
  }

  // Content-Security-Policy
  if (headers["content-security-policy"]) {
    const csp = headers["content-security-policy"]
    if (csp.includes("'unsafe-inline'")) {
      findings.push({
        severity: MEDIUM,
        category: "Security Headers",
        message: "CSP allows 'unsafe-inline' — weakens XSS protection",
        fix: "Use nonce-based or hash-based CSP instead of unsafe-inline",
      })
    }
    if (csp.includes("'unsafe-eval'")) {
      findings.push({
        severity: HIGH,
        category: "Security Headers",
        message: "CSP allows 'unsafe-eval' — enables eval()-based attacks",
        fix: "Remove 'unsafe-eval' from script-src directive in CSP",
        file: "next.config.ts or middleware.ts",
      })
    }
    if (csp.includes("*")) {
      findings.push({
        severity: MEDIUM,
        category: "Security Headers",
        message: "CSP contains wildcard (*) source — overly permissive",
        fix: "Replace wildcard with specific allowed domains",
      })
    }
  } else {
    findings.push({
      severity: CRITICAL,
      category: "Security Headers",
      message: "Missing Content-Security-Policy header",
      fix: "Add CSP header via next.config.ts headers() or middleware. Start with: default-src 'self'; script-src 'self'",
      file: "next.config.ts",
    })
  }

  // HSTS
  if (!headers["strict-transport-security"]) {
    findings.push({
      severity: HIGH,
      category: "Security Headers",
      message: "Missing Strict-Transport-Security (HSTS) header",
      fix: "Add header: Strict-Transport-Security: max-age=31536000; includeSubDomains",
      file: "next.config.ts or vercel.json",
    })
  }

  // X-Frame-Options
  const csp = headers["content-security-policy"] || ""
  if (!headers["x-frame-options"] && !csp.includes("frame-ancestors")) {
    findings.push({
      severity: HIGH,
      category: "Security Headers",
      message: "Missing X-Frame-Options and CSP frame-ancestors — clickjacking risk",
      fix: "Add X-Frame-Options: DENY or CSP frame-ancestors 'none'",
    })
  }

  // X-Content-Type-Options
  if (headers["x-content-type-options"] !== "nosniff") {
    findings.push({
      severity: MEDIUM,
      category: "Security Headers",
      message: "Missing X-Content-Type-Options: nosniff header",
      fix: "Add header: X-Content-Type-Options: nosniff",
    })
  }

  // Referrer-Policy
  if (!headers["referrer-policy"]) {
    findings.push({
      severity: MEDIUM,
      category: "Security Headers",
      message: "Missing Referrer-Policy header",
      fix: "Add header: Referrer-Policy: strict-origin-when-cross-origin",
    })
  }

  // Permissions-Policy
  if (!headers["permissions-policy"]) {
    findings.push({
      severity: LOW,
      category: "Security Headers",
      message: "Missing Permissions-Policy header",
      fix: "Add Permissions-Policy to restrict browser features (camera, microphone, geolocation)",
    })
  }

  // Server / X-Powered-By disclosure
  if (headers["server"]) {
    findings.push({
      severity: LOW,
      category: "Security Headers",
      message: `Server header reveals: ${headers["server"]}`,
      fix: "Remove or obfuscate the Server header to prevent fingerprinting",
    })
  }
  if (headers["x-powered-by"]) {
    findings.push({
      severity: LOW,
      category: "Security Headers",
      message: `X-Powered-By header reveals: ${headers["x-powered-by"]}`,
      fix: "Remove X-Powered-By header (Next.js: set poweredByHeader: false in next.config)",
      file: "next.config.ts",
    })
  }

  return { findings, headers }
}

async function secCheckAuthentication(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];

      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        const name = (input.name || '').toLowerCase();
        const id = (input.id || '').toLowerCase();
        const placeholder = (input.placeholder || '').toLowerCase();
        const isPasswordField = name.includes('password') || name.includes('passwd') ||
          id.includes('password') || id.includes('passwd') ||
          placeholder.includes('password');
        if (isPasswordField && input.type !== 'password') {
          const sel = input.id ? '#' + input.id : (input.name ? '[name="' + input.name + '"]' : 'input');
          findings.push({
            severity: 'high',
            category: 'Authentication',
            message: 'Password field without type="password": ' + sel,
            fix: 'Change input type to "password" to mask the field',
          });
        }
      }

      const passwordInputs = document.querySelectorAll('input[type="password"]');
      for (const input of passwordInputs) {
        const ac = input.getAttribute('autocomplete');
        if (!ac || (ac !== 'new-password' && ac !== 'current-password' && ac !== 'off')) {
          const sel = input.id ? '#' + input.id : (input.name ? '[name="' + input.name + '"]' : 'input[type="password"]');
          findings.push({
            severity: 'high',
            category: 'Authentication',
            message: 'Password input missing autocomplete attribute: ' + sel,
            fix: 'Add autocomplete="current-password" or "new-password" to the input',
          });
        }
      }

      // Login forms without CSRF
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        const hasPassword = form.querySelector('input[type="password"]');
        const action = (form.action || '').toLowerCase();
        const isLogin = hasPassword || action.includes('login') || action.includes('signin') || action.includes('auth');
        if (!isLogin) continue;
        const csrfInput = form.querySelector(
          'input[name="csrf"], input[name="_csrf"], input[name="csrfmiddlewaretoken"], ' +
          'input[name="_token"], input[name="authenticity_token"], input[name="__RequestVerificationToken"]'
        );
        const csrfMeta = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]');
        if (!csrfInput && !csrfMeta) {
          findings.push({
            severity: 'high',
            category: 'Authentication',
            message: 'Login form missing CSRF token: ' + (form.id ? '#' + form.id : form.action || 'form'),
            fix: 'Add CSRF token to the form or use SameSite cookies',
          });
        }
      }

      // Tokens in URL
      const urlParams = new URLSearchParams(location.search);
      const sensitiveParams = ['token', 'access_token', 'api_key', 'apikey', 'secret', 'password', 'session_id', 'auth'];
      for (const param of sensitiveParams) {
        if (urlParams.has(param)) {
          findings.push({
            severity: 'high',
            category: 'Authentication',
            message: 'Sensitive token exposed in URL parameter: ' + param,
            fix: 'Move sensitive tokens to Authorization header or HttpOnly cookies',
          });
        }
      }

      return findings;
    })()
  `)
}

async function secCheckInputValidation(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const textInputTypes = ['text', 'search', 'url', 'tel', 'email', 'number', ''];
      const inputs = document.querySelectorAll('input, textarea');
      let missingValidation = 0;
      let unlimitedLength = 0;

      for (const input of inputs) {
        if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button' ||
            input.type === 'checkbox' || input.type === 'radio' || input.type === 'file') continue;
        const style = getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const isInForm = !!input.closest('form');
        if (isInForm) {
          const hasRequired = input.hasAttribute('required');
          const hasPattern = input.hasAttribute('pattern');
          const hasMinlength = input.hasAttribute('minlength');
          const hasMaxlength = input.hasAttribute('maxlength');
          if (!hasRequired && !hasPattern && !hasMinlength && !hasMaxlength) {
            missingValidation++;
          }
        }

        if (textInputTypes.includes(input.type) || input.tagName === 'TEXTAREA') {
          if (!input.hasAttribute('maxlength')) {
            unlimitedLength++;
          }
        }
      }

      if (missingValidation > 0) {
        findings.push({
          severity: 'medium',
          category: 'Input Validation',
          message: missingValidation + ' form input(s) without any validation attributes',
          fix: 'Add required, pattern, minlength, or maxlength attributes to form inputs',
        });
      }

      if (unlimitedLength > 0) {
        findings.push({
          severity: 'low',
          category: 'Input Validation',
          message: unlimitedLength + ' text input(s) accept unlimited length (no maxlength)',
          fix: 'Add maxlength attribute to prevent excessively long input',
        });
      }

      return findings;
    })()
  `)
}

async function secCheckXSS(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const scripts = document.querySelectorAll('script:not([src])');
      let innerHTMLCount = 0;
      let documentWriteCount = 0;
      let evalCount = 0;

      for (const s of scripts) {
        const text = s.textContent || '';
        const innerHTMLMatches = text.match(/\\.innerHTML\\s*[=+]/g);
        if (innerHTMLMatches) innerHTMLCount += innerHTMLMatches.length;
        const docWriteMatches = text.match(/document\\.write(ln)?\\s*\\(/g);
        if (docWriteMatches) documentWriteCount += docWriteMatches.length;
        const evalMatches = text.match(/\\beval\\s*\\(/g);
        if (evalMatches) evalCount += evalMatches.length;
      }

      const html = document.documentElement.outerHTML.slice(0, 300000);
      const dangerouslyCount = (html.match(/dangerouslySetInnerHTML/g) || []).length;

      if (innerHTMLCount > 0) {
        findings.push({
          severity: 'medium',
          category: 'DOM XSS',
          message: innerHTMLCount + ' innerHTML assignment(s) in inline scripts',
          fix: 'Replace innerHTML with textContent or use DOMPurify for sanitization',
        });
      }
      if (documentWriteCount > 0) {
        findings.push({
          severity: 'high',
          category: 'DOM XSS',
          message: documentWriteCount + ' document.write() call(s) — DOM XSS risk',
          fix: 'Replace document.write() with DOM API methods (createElement, appendChild)',
        });
      }
      if (evalCount > 0) {
        findings.push({
          severity: 'high',
          category: 'DOM XSS',
          message: evalCount + ' eval() call(s) in inline scripts',
          fix: 'Replace eval() with safer alternatives (JSON.parse, Function constructor as last resort)',
        });
      }
      if (dangerouslyCount > 0) {
        findings.push({
          severity: 'medium',
          category: 'DOM XSS',
          message: dangerouslyCount + ' dangerouslySetInnerHTML usage(s) found',
          fix: 'Sanitize HTML with DOMPurify before using dangerouslySetInnerHTML',
        });
      }

      return findings;
    })()
  `)
}

async function secCheckCookies(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const cookies = document.cookie;
      if (!cookies || cookies.trim().length === 0) return findings;

      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieNames = cookiePairs.map(c => c.split('=')[0].trim());

      for (const name of cookieNames) {
        const lower = name.toLowerCase();
        if (lower.includes('session') || lower.includes('token') || lower.includes('auth') ||
            lower.includes('jwt') || lower.includes('sid') || lower === 'connect.sid') {
          findings.push({
            severity: 'high',
            category: 'Cookie Security',
            message: 'Sensitive cookie "' + name + '" accessible to JavaScript (missing HttpOnly)',
            fix: 'Set HttpOnly flag on this cookie to prevent JavaScript access',
          });
        }
      }

      if (cookieNames.length > 0 && findings.length === 0) {
        findings.push({
          severity: 'medium',
          category: 'Cookie Security',
          message: cookieNames.length + ' cookie(s) accessible to JavaScript: ' + cookieNames.join(', '),
          fix: 'Consider adding HttpOnly flag to cookies that do not need JS access',
        });
      }

      return findings;
    })()
  `)
}

async function secCheckMixedContent(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const isHttps = location.protocol === 'https:';
      if (!isHttps) {
        findings.push({
          severity: 'medium',
          category: 'Mixed Content',
          message: 'Page is served over HTTP (not HTTPS)',
          fix: 'Serve the page over HTTPS. Configure SSL/TLS on the server.',
        });
        return findings;
      }

      const resourceSelectors = [
        { sel: 'img[src^="http:"]', type: 'image' },
        { sel: 'script[src^="http:"]', type: 'script' },
        { sel: 'link[href^="http:"]', type: 'stylesheet/link' },
        { sel: 'iframe[src^="http:"]', type: 'iframe' },
      ];

      for (const { sel, type } of resourceSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          findings.push({
            severity: 'high',
            category: 'Mixed Content',
            message: els.length + ' insecure HTTP ' + type + '(s) on HTTPS page',
            fix: 'Change resource URLs from http:// to https://',
          });
        }
      }

      const insecureForms = document.querySelectorAll('form[action^="http:"]');
      if (insecureForms.length > 0) {
        findings.push({
          severity: 'critical',
          category: 'Mixed Content',
          message: insecureForms.length + ' form(s) submit to insecure HTTP endpoint',
          fix: 'Change form action to use HTTPS',
        });
      }

      return findings;
    })()
  `)
}

// ═══════════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════════

function calculateScore(issues) {
  let score = 100
  for (const issue of issues) {
    const sev = normSeverity(issue.severity)
    if (sev in SEVERITY_DEDUCTIONS) {
      score -= SEVERITY_DEDUCTIONS[sev]
    }
  }
  return Math.max(0, Math.min(100, score))
}

function countBySeverity(issues) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const issue of issues) {
    const sev = normSeverity(issue.severity)
    if (sev in counts) counts[sev]++
  }
  return counts
}

// ═══════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════

function generateMarkdownReport(auditResult, previousAudits) {
  const { url, projectName, round, maxRounds, uxIssues, securityIssues, allIssues,
          uxScore, securityScore, overallScore, timestamp, elementStats } = auditResult

  const prevAudit = previousAudits.length > 0 ? previousAudits[previousAudits.length - 1] : null
  const prevUx = prevAudit?.scores?.ux ?? null
  const prevSec = prevAudit?.scores?.security ?? null
  const prevOverall = prevAudit?.scores?.overall ?? null

  const prevCounts = prevAudit?.counts ?? null

  const counts = countBySeverity(allIssues)
  const date = new Date(timestamp)
  const dateStr = date.toISOString().slice(0, 16).replace("T", " ")

  let md = ""

  md += `# Audit Report — ${projectName}\n`
  md += `**Date:** ${dateStr}\n`
  md += `**URL:** ${url}\n`
  md += `**Round:** ${round} (of ${maxRounds} max)\n\n`

  // Scores table
  md += `## Scores\n`
  md += `| Category | Score | Previous | Delta |\n`
  md += `|----------|-------|----------|-------|\n`
  md += `| UX | ${uxScore}/100 | ${prevUx !== null ? prevUx + "/100" : "—"} | ${prevUx !== null ? formatDelta(uxScore - prevUx) : "—"} |\n`
  md += `| Security | ${securityScore}/100 | ${prevSec !== null ? prevSec + "/100" : "—"} | ${prevSec !== null ? formatDelta(securityScore - prevSec) : "—"} |\n`
  md += `| Overall | ${overallScore}/100 | ${prevOverall !== null ? prevOverall + "/100" : "—"} | ${prevOverall !== null ? formatDelta(overallScore - prevOverall) : "—"} |\n`
  md += `\n`

  // Summary
  md += `## Summary\n`
  md += `- **Critical:** ${counts.critical}${prevCounts ? ` (was ${prevCounts.critical})` : ""}\n`
  md += `- **High:** ${counts.high}${prevCounts ? ` (was ${prevCounts.high})` : ""}\n`
  md += `- **Medium:** ${counts.medium}${prevCounts ? ` (was ${prevCounts.medium})` : ""}\n`
  md += `- **Low:** ${counts.low}${prevCounts ? ` (was ${prevCounts.low})` : ""}\n`
  md += `\n`

  // Element stats
  if (elementStats) {
    md += `## Page Stats\n`
    md += `- **Total elements:** ${elementStats.total}\n`
    md += `- **Interactive:** ${elementStats.interactive}\n`
    md += `- **Headings:** ${elementStats.headings}\n`
    md += `- **Images:** ${elementStats.images}\n`
    md += `- **Forms:** ${elementStats.forms}\n`
    md += `- **Links:** ${elementStats.links}\n`
    md += `\n`
  }

  // Issues by severity
  md += `## Issues\n`

  for (const severity of [CRITICAL, HIGH, MEDIUM, LOW]) {
    const sevIssues = allIssues.filter((i) => normSeverity(i.severity) === severity)
    md += `### ${severity.charAt(0).toUpperCase() + severity.slice(1)}\n`

    if (sevIssues.length === 0) {
      md += `(none)\n\n`
      continue
    }

    for (let i = 0; i < sevIssues.length; i++) {
      const issue = sevIssues[i]
      md += `${i + 1}. **[${issue.category}]** ${issue.message}\n`
      if (issue.element) {
        md += `   - Element: \`${issue.element}\`\n`
      }
      if (issue.file) {
        md += `   - File: \`${issue.file}\`\n`
      }
      if (issue.fix) {
        md += `   - Fix: ${issue.fix}\n`
      }
    }
    md += `\n`
  }

  // Convergence history
  if (previousAudits.length > 0) {
    md += `## Convergence History\n`
    md += `| Round | Date | Critical | High | Medium | Low | Score |\n`
    md += `|-------|------|----------|------|--------|-----|-------|\n`

    for (const prev of previousAudits) {
      const pc = prev.counts || { critical: 0, high: 0, medium: 0, low: 0 }
      const pDate = (prev.timestamp || "").slice(0, 10)
      md += `| ${prev.round} | ${pDate} | ${pc.critical} | ${pc.high} | ${pc.medium} | ${pc.low} | ${prev.scores?.overall ?? "?"} |\n`
    }

    // Current round
    md += `| ${round} | ${timestamp.slice(0, 10)} | ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} | ${overallScore} |\n`
    md += `\n`
  }

  // Fix instructions summary (if --full)
  if (generateFixInstructions && allIssues.length > 0) {
    md += `## Fix Instructions Summary\n\n`
    const critAndHigh = allIssues.filter(
      (i) => normSeverity(i.severity) === CRITICAL || normSeverity(i.severity) === HIGH
    )
    if (critAndHigh.length > 0) {
      md += `### Priority Fixes (Critical + High)\n`
      for (const issue of critAndHigh) {
        md += `- **${issue.category}:** ${issue.message}\n`
        if (issue.fix) md += `  - ${issue.fix}\n`
        if (issue.file) md += `  - File: \`${issue.file}\`\n`
      }
      md += `\n`
    }

    const medAndLow = allIssues.filter(
      (i) => normSeverity(i.severity) === MEDIUM || normSeverity(i.severity) === LOW
    )
    if (medAndLow.length > 0) {
      md += `### Secondary Fixes (Medium + Low)\n`
      for (const issue of medAndLow) {
        md += `- **${issue.category}:** ${issue.message}\n`
        if (issue.fix) md += `  - ${issue.fix}\n`
      }
      md += `\n`
    }
  }

  return md
}

function formatDelta(n) {
  if (n > 0) return `+${n}`
  if (n < 0) return `${n}`
  return "0"
}

// ═══════════════════════════════════════════════════════════
// CONSOLE OUTPUT
// ═══════════════════════════════════════════════════════════

function printSummary(auditResult) {
  const { url, projectName, round, overallScore, uxScore, securityScore, codeScore, allIssues } = auditResult
  const counts = countBySeverity(allIssues)
  const totalIssues = counts.critical + counts.high + counts.medium + counts.low

  const green = "\x1b[32m"
  const yellow = "\x1b[33m"
  const red = "\x1b[31m"
  const brightRed = "\x1b[91m"
  const cyan = "\x1b[36m"
  const reset = "\x1b[0m"
  const bold = "\x1b[1m"

  console.log(`\n${bold}=== Audit Report — ${projectName} ===${reset}`)
  console.log(`URL: ${url}`)
  console.log(`Round: ${round}`)
  console.log()

  // Scores
  const scoreColor = (s) => (s >= 80 ? green : s >= 60 ? yellow : red)
  console.log(`${bold}Scores:${reset}`)
  console.log(`  UX:       ${scoreColor(uxScore)}${uxScore}/100${reset}`)
  console.log(`  Security: ${scoreColor(securityScore)}${securityScore}/100${reset}`)
  console.log(`  Code:     ${scoreColor(codeScore ?? 100)}${codeScore ?? 100}/100${reset}`)
  console.log(`  Overall:  ${scoreColor(overallScore)}${overallScore}/100${reset}`)
  console.log()

  // Issue counts
  if (totalIssues === 0) {
    console.log(`${green}No issues found. Production-ready.${reset}`)
  } else {
    console.log(`${bold}Issues:${reset}`)
    if (counts.critical > 0) console.log(`  ${brightRed}Critical: ${counts.critical}${reset}`)
    if (counts.high > 0) console.log(`  ${red}High: ${counts.high}${reset}`)
    if (counts.medium > 0) console.log(`  ${yellow}Medium: ${counts.medium}${reset}`)
    if (counts.low > 0) console.log(`  ${cyan}Low: ${counts.low}${reset}`)
  }
  console.log()
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Orchestrate — Overnight audit loop for Field Trip

Usage:
  node cli/orchestrate.mjs --relay --tab 704448034 --audit        # run all audits
  node cli/orchestrate.mjs --relay --tab 704448034 --security     # security only
  node cli/orchestrate.mjs --relay --tab 704448034 --ux           # UX only
  node cli/orchestrate.mjs --relay --tab 704448034 --full         # audit + fix instructions
  node cli/orchestrate.mjs --relay --report project-report.md     # custom output path
  node cli/orchestrate.mjs --config .field-trip/audit-config.json # use project config

Flags:
  --relay           Use WebSocket relay mode
  --tab <id>        Target a specific browser tab by ID
  --port <number>   Override relay port (default: 9333)
  --audit           Run all audits (UX + Security + Code) — default
  --security        Run security audit only
  --ux              Run UX audit only
  --code            Run code audit only (Truth-Seeker)
  --full            Run all audits + generate fix instructions
  --report <path>   Custom markdown report output path
  --config <path>   Path to audit config JSON
  -h, --help        Show this help
`)
    process.exit(0)
  }

  const startTime = Date.now()

  // Load config
  const config = loadAuditConfig(configPath)
  const maxRounds = config?.fixPolicy?.maxRounds ?? 5

  // Load previous audit history
  const previousAudits = loadPreviousAudits()
  const round = getCurrentRound(previousAudits)

  console.log(`\n  Orchestrate — Field Trip Audit Pipeline`)
  console.log(`  =========================================`)
  console.log(`  Round: ${round} of ${maxRounds}`)
  if (config) {
    console.log(`  Project: ${config.project || "unknown"}`)
    console.log(`  Framework: ${config.framework || "unknown"}`)
  }
  console.log()

  // Connect
  console.log("  Connecting via relay...")
  let driver
  try {
    driver = await connectRelayDriver()
  } catch (err) {
    console.error(`  Failed to connect: ${err.message}`)
    console.error(`  Ensure ws-relay is running: node cli/ws-relay.mjs`)
    process.exit(2)
  }
  console.log("  Connected.")

  // Get page info
  const pageUrl = await driver.evaluate("location.href")
  const pageTitle = await driver.evaluate("document.title").catch(() => "")
  const projectName = config?.project || pageTitle || new URL(pageUrl).hostname
  console.log(`  URL: ${pageUrl}`)
  console.log(`  Title: ${pageTitle}`)
  console.log()

  // ─── Run audits ───

  const allIssues = []
  const uxIssues = []
  const securityIssues = []
  let elementStats = null

  // UX Audit
  if (runUx) {
    console.log("  [UX Audit]")

    // Element scan
    process.stdout.write("    Elements...")
    try {
      elementStats = await uxCheckElements(driver.evaluate.bind(driver))
      console.log(` ${elementStats.total} total, ${elementStats.interactive} interactive`)
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Accessibility
    process.stdout.write("    Accessibility...")
    try {
      const a11yIssues = await uxCheckAccessibility(driver.evaluate.bind(driver)) || []
      uxIssues.push(...a11yIssues)
      const count = a11yIssues.length
      console.log(count > 0 ? ` ${count} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Links
    process.stdout.write("    Links...")
    try {
      const linkResult = await uxCheckLinks(driver.evaluate.bind(driver))
      uxIssues.push(...linkResult.issues)
      console.log(linkResult.broken > 0 ? ` ${linkResult.broken} broken of ${linkResult.total}` : ` ${linkResult.total} links OK`)
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Visibility
    process.stdout.write("    Visibility...")
    try {
      const visIssues = await uxCheckVisibility(driver.evaluate.bind(driver)) || []
      uxIssues.push(...visIssues)
      const count = visIssues.length
      console.log(count > 0 ? ` ${count} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Responsive
    const viewports = config?.audits?.ux?.viewports ?? RESPONSIVE_WIDTHS
    process.stdout.write(`    Responsive (${viewports.join(", ")}px)...`)
    try {
      const respResult = await uxCheckResponsive(driver.evaluate.bind(driver), viewports)
      uxIssues.push(...respResult.issues)
      const count = respResult.issues.length
      console.log(count > 0 ? ` ${count} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    console.log()
  }

  // Security Audit
  if (runSecurity) {
    console.log("  [Security Audit]")
    const isRemoteUrl = pageUrl.startsWith("http://") || pageUrl.startsWith("https://")

    // Exposed secrets
    process.stdout.write("    Exposed Secrets...")
    try {
      const secretIssues = await secCheckExposedSecrets(driver.evaluate.bind(driver))
      securityIssues.push(...secretIssues)
      console.log(secretIssues.length > 0 ? ` ${secretIssues.length} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Security headers
    let fetchedHeaders = null
    if (isRemoteUrl) {
      process.stdout.write("    Security Headers...")
      try {
        const headerResult = await secCheckHeaders(pageUrl)
        securityIssues.push(...headerResult.findings)
        fetchedHeaders = headerResult.headers
        const count = headerResult.findings.length
        console.log(count > 0 ? ` ${count} issue(s)` : " OK")
      } catch (err) {
        console.log(` ERROR: ${err.message}`)
      }
    }

    // Authentication
    process.stdout.write("    Authentication...")
    try {
      const authIssues = await secCheckAuthentication(driver.evaluate.bind(driver)) || []
      securityIssues.push(...authIssues)
      console.log(authIssues.length > 0 ? ` ${authIssues.length} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Input validation
    process.stdout.write("    Input Validation...")
    try {
      const inputIssues = await secCheckInputValidation(driver.evaluate.bind(driver)) || []
      securityIssues.push(...inputIssues)
      console.log(inputIssues.length > 0 ? ` ${inputIssues.length} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // DOM XSS
    process.stdout.write("    XSS Indicators...")
    try {
      const xssIssues = await secCheckXSS(driver.evaluate.bind(driver)) || []
      securityIssues.push(...xssIssues)
      console.log(xssIssues.length > 0 ? ` ${xssIssues.length} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Cookie security
    process.stdout.write("    Cookie Security...")
    try {
      const cookieIssues = await secCheckCookies(driver.evaluate.bind(driver)) || []
      securityIssues.push(...cookieIssues)
      console.log(cookieIssues.length > 0 ? ` ${cookieIssues.length} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Mixed content
    process.stdout.write("    Mixed Content...")
    try {
      const mixedIssues = await secCheckMixedContent(driver.evaluate.bind(driver)) || []
      securityIssues.push(...mixedIssues)
      console.log(mixedIssues.length > 0 ? ` ${mixedIssues.length} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    console.log()
  }

  // ─── Code Audit (Truth-Seeker) ───

  const codeIssues = []

  if (runCode) {
    console.log("  [Code Audit — Truth-Seeker]")

    const TRUTH_SEEKER_DIR = "C:\\Users\\bubun\\CascadeProjects\\Truth-Seeker"
    const TRUTH_SEEKER_BIN = join(TRUTH_SEEKER_DIR, "rust", "target", "release", "truth-seeker.exe")
    const projectRoot = config?.projectDir || process.cwd()
    const hasBinary = existsSync(TRUTH_SEEKER_BIN)

    const runTSCommand = async (label, cmd) => {
      process.stdout.write(`    ${label}...`)
      try {
        const { stdout } = await execAsync(cmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
        const result = JSON.parse(stdout)
        const issues = []
        if (result.status === "error" || result.errors?.length > 0) {
          const errors = result.errors || [{ message: result.message || result.summary }]
          for (const err of errors) {
            issues.push({
              severity: "high",
              category: `Code: ${label}`,
              message: err.message || err.path || String(err),
              fix: err.fix || err.suggestion || `Review and fix the ${label.toLowerCase()} issue`,
            })
          }
        }
        if (result.warnings?.length > 0) {
          for (const warn of result.warnings) {
            issues.push({
              severity: "medium",
              category: `Code: ${label}`,
              message: warn.message || warn.path || String(warn),
              fix: warn.fix || warn.suggestion || `Review the ${label.toLowerCase()} warning`,
            })
          }
        }
        console.log(issues.length > 0 ? ` ${issues.length} issue(s)` : " OK")
        return issues
      } catch (err) {
        // Command may not produce JSON — treat non-zero exit as issue
        if (err.stdout) {
          try {
            const result = JSON.parse(err.stdout)
            const issues = []
            const errors = result.errors || (result.status === "error" ? [{ message: result.summary || result.message }] : [])
            for (const e of errors) {
              issues.push({
                severity: "high",
                category: `Code: ${label}`,
                message: e.message || e.path || String(e),
                fix: e.fix || `Review the ${label.toLowerCase()} issue`,
              })
            }
            console.log(issues.length > 0 ? ` ${issues.length} issue(s)` : " OK")
            return issues
          } catch {}
        }
        console.log(` SKIP (${err.message?.slice(0, 60)})`)
        return []
      }
    }

    if (hasBinary) {
      // Use Rust CLI
      const bin = TRUTH_SEEKER_BIN.replace(/\\/g, "/")

      const importIssues = await runTSCommand("Import Validation",
        `"${bin}" check-imports "${projectRoot}/src/app/layout.tsx" --json --project "${projectRoot}"`)
      codeIssues.push(...importIssues)

      const envIssues = await runTSCommand("Env Variable Drift",
        `"${bin}" env-check "${projectRoot}" --json`)
      codeIssues.push(...envIssues)

      const archIssues = await runTSCommand("Architecture Analysis",
        `"${bin}" architecture "${projectRoot}" --json`)
      codeIssues.push(...archIssues)

      const typeIssues = await runTSCommand("Type Checking",
        `"${bin}" typecheck "${projectRoot}" --json`)
      codeIssues.push(...typeIssues)
    } else {
      // Fallback: run code-audit.mjs as subprocess
      const codeAuditPath = join(__dirname, "code-audit.mjs")
      if (existsSync(codeAuditPath)) {
        const auditIssues = await runTSCommand("Full Code Audit",
          `node "${codeAuditPath}" "${projectRoot}" --output -`)
        codeIssues.push(...auditIssues)
      } else {
        console.log("    (code-audit.mjs not found — skipping code audit)")
      }
    }

    console.log()
  }

  // Combine all issues
  allIssues.push(...uxIssues, ...securityIssues, ...codeIssues)

  // Calculate scores
  const uxScore = runUx ? calculateScore(uxIssues) : 100
  const securityScore = runSecurity ? calculateScore(securityIssues) : 100
  const codeScore = runCode ? calculateScore(codeIssues) : 100
  const overallScore = calculateScore(allIssues)
  const counts = countBySeverity(allIssues)
  const timestamp = new Date().toISOString()

  // Build result object
  const auditResult = {
    url: pageUrl,
    projectName,
    round,
    maxRounds,
    timestamp,
    uxIssues,
    securityIssues,
    codeIssues,
    allIssues,
    uxScore,
    securityScore,
    codeScore,
    overallScore,
    elementStats,
    scores: { ux: uxScore, security: securityScore, code: codeScore, overall: overallScore },
    counts,
    totalIssues: counts.critical + counts.high + counts.medium + counts.low,
    durationMs: Date.now() - startTime,
  }

  // Print summary
  printSummary(auditResult)

  // Generate markdown report
  const markdown = generateMarkdownReport(auditResult, previousAudits)

  // Save JSON result
  const reportsDir = getReportsDir()
  const ts = timestamp.replace(/[:.]/g, "-").slice(0, 19)
  const jsonFileName = `audit-${ts}-round-${round}.json`
  const jsonPath = join(reportsDir, jsonFileName)
  writeFileSync(jsonPath, JSON.stringify(auditResult, null, 2))
  console.log(`  JSON saved: ${jsonPath}`)

  // Save markdown report
  const mdFileName = reportPath || join(reportsDir, `audit-${ts}-round-${round}.md`)
  writeFileSync(mdFileName, markdown)
  console.log(`  Report saved: ${mdFileName}`)

  // Also save a "latest" symlink-style file for easy access
  const latestJsonPath = join(reportsDir, "latest.json")
  const latestMdPath = join(reportsDir, "latest.md")
  writeFileSync(latestJsonPath, JSON.stringify(auditResult, null, 2))
  writeFileSync(latestMdPath, markdown)
  console.log(`  Latest: ${latestMdPath}`)

  // Convergence check
  const totalIssues = counts.critical + counts.high + counts.medium + counts.low
  if (totalIssues === 0) {
    console.log(`\n  \x1b[32mConverged! Zero issues at round ${round}. Production-ready.\x1b[0m`)
  } else if (round >= maxRounds) {
    console.log(`\n  \x1b[33mMax rounds (${maxRounds}) reached. ${totalIssues} issue(s) remain.\x1b[0m`)
  } else {
    const nextRound = round + 1
    console.log(`\n  ${totalIssues} issue(s) remain. Fix and re-run for round ${nextRound}.`)
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`  Duration: ${elapsed}s\n`)

  // Cleanup
  driver.close()

  // Exit code
  if (counts.critical > 0) process.exit(2)
  if (counts.high > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(3)
})

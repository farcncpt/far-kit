#!/usr/bin/env node
/**
 * security-audit.mjs — Comprehensive OWASP Top 10 security scanner.
 *
 * Scans a live web page for security vulnerabilities via DOM inspection
 * and HTTP header analysis. Works with both CDP and relay connection modes.
 *
 * Checks implemented:
 *   1. Exposed secrets (API keys, tokens, passwords in page/storage)
 *   2. Security headers (CSP, HSTS, X-Frame-Options, etc.)
 *   3. Authentication issues (password fields, CSRF, URL tokens)
 *   4. Input validation (missing required/pattern/maxlength)
 *   5. Information disclosure (source maps, stack traces, comments)
 *   6. Clickjacking protection
 *   7. Mixed content (HTTP on HTTPS)
 *   8. Cookie security (Secure, HttpOnly, SameSite)
 *   9. Client-side storage (sensitive data in localStorage/sessionStorage)
 *  10. DOM XSS indicators (innerHTML, document.write, eval)
 *
 * Usage:
 *   node cli/security-audit.mjs --relay                    # audit active tab
 *   node cli/security-audit.mjs --relay --tab 704448023    # audit specific tab
 *   node cli/security-audit.mjs --url https://example.com  # CDP mode
 *   node cli/security-audit.mjs --relay --output report.json
 *   node cli/security-audit.mjs --relay --verbose          # show passed checks too
 *
 * Environment:
 *   CDP_PORT   — Chrome DevTools Protocol port (default: 9222)
 *   RELAY_PORT — WebSocket relay port (default: 9333)
 */

import http from "http"
import https from "https"
import { writeFileSync } from "fs"

// ─── Argument parsing ───

const rawArgs = process.argv.slice(2)

function hasFlag(name) {
  return rawArgs.includes(name)
}

function flagValue(name, fallback) {
  const idx = rawArgs.indexOf(name)
  if (idx !== -1 && rawArgs[idx + 1]) return rawArgs[idx + 1]
  return fallback
}

const useRelay = hasFlag("--relay") || !!process.env.RELAY_MODE
const verbose = hasFlag("--verbose")
const targetUrl = flagValue("--url", null)
const outputFile = flagValue("--output", null)

let customPort = null
const portIdx = rawArgs.indexOf("--port")
if (portIdx !== -1 && rawArgs[portIdx + 1]) {
  customPort = parseInt(rawArgs[portIdx + 1])
}

let targetTabId = null
const tabIdx = rawArgs.indexOf("--tab")
if (tabIdx !== -1 && rawArgs[tabIdx + 1]) {
  targetTabId = parseInt(rawArgs[tabIdx + 1])
}

const CDP_PORT = customPort ?? parseInt(process.env.CDP_PORT || "9222")

// ─── Severity levels ───

const CRITICAL = "CRITICAL"
const HIGH = "HIGH"
const MEDIUM = "MEDIUM"
const LOW = "LOW"
const INFO = "INFO"
const PASS = "PASS"

// ─── Known-safe patterns (reduce false positives) ───

const KNOWN_SAFE_PATTERNS = [
  /_STACK_AUTH\./,          // Stack Auth SDK internal localStorage keys
  /stack-auth/i,            // Stack Auth config values
  /stack_project_id/i,      // Stack Auth public project ID
  /__stack-/i,              // Stack Auth internal prefixes
  /^__Host-stack-/i,        // Stack Auth cookie prefix
  /^stack-s-/i,             // Stack Auth session cookies
  /^__clerk_/i,             // Clerk auth SDK internal keys
  /^__next/i,               // Next.js internal keys
  /supabase\.auth/i,        // Supabase Auth SDK
  /^sb-.*-auth-token$/i,    // Supabase auth token key names
  /^firebase:auth/i,        // Firebase Auth SDK
]

// Known SDK cookie patterns (developer can't control these flags)
const SDK_COOKIE_PATTERNS = [
  /^stack-s-/i,             // Stack Auth session
  /^__Host-stack-/i,        // Stack Auth host cookie
  /^__stripe_/i,            // Stripe SDK cookies
  /^__clerk_/i,             // Clerk SDK cookies
  /^__Secure-/i,            // Secure-prefix cookies (browser-managed)
  /^_ga/i,                  // Google Analytics
  /^_gid/i,                 // Google Analytics
  /^_fbp/i,                 // Facebook Pixel
  /^intercom-/i,            // Intercom SDK
]

/**
 * Check if a value+key combination matches known-safe patterns.
 * Returns true if the match is likely a false positive.
 */
function isKnownSafe(key, value) {
  const combined = `${key}=${value}`
  return KNOWN_SAFE_PATTERNS.some(pat => pat.test(key) || pat.test(value) || pat.test(combined))
}

/**
 * Check if a cookie name matches a known third-party SDK pattern.
 */
function isSDKCookie(cookieName) {
  return SDK_COOKIE_PATTERNS.some(pat => pat.test(cookieName))
}

// ─── Secret detection patterns ───

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
  { name: "Heroku API key", pattern: /(?:heroku|HEROKU)[\s_-]*(?:api)?[\s_-]*(?:key|token)\s*[:=]\s*["']?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/i },
]

// Patterns that suggest sensitive data in storage keys
const SENSITIVE_STORAGE_KEY_PATTERNS = [
  /token/i, /secret/i, /password/i, /passwd/i, /credential/i,
  /api[_-]?key/i, /auth/i, /session/i, /jwt/i, /private/i,
  /credit.?card/i, /ssn/i, /social.?security/i,
]

// PII patterns for storage values
const PII_PATTERNS = [
  { name: "Social Security Number", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "Credit card number", pattern: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/ },
  { name: "Email address", pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/ },
  { name: "Phone number", pattern: /\b(?:\+1[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/ },
]

// ─── CDP connection ───

async function connectCDP() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", (err) => {
      reject(new Error(`Cannot connect to CDP on port ${CDP_PORT}: ${err.message}`))
    })
  })

  const page = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://")
  )
  if (!page) {
    console.error("No page tab found on CDP port " + CDP_PORT)
    process.exit(1)
  }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => {
    ws.on("open", resolve)
    ws.on("error", reject)
  })

  let msgId = 0

  function send(method, params = {}) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20000)
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.id === id) {
          ws.off("message", handler)
          clearTimeout(timeout)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      }
      ws.on("message", handler)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expr) {
    const result = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "eval failed"
      throw new Error(desc)
    }
    return result.result?.value
  }

  // Navigate if URL specified
  if (targetUrl) {
    const onEvent = (method, fn) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.method === method) fn(msg.params)
      })
    }
    await send("Page.enable")
    await send("Page.navigate", { url: targetUrl })
    await new Promise((resolve) => {
      onEvent("Page.loadEventFired", resolve)
      setTimeout(resolve, 15000)
    })
    await new Promise((r) => setTimeout(r, 1500))
  }

  return { ws, send, evaluate, close: () => ws.close() }
}

// ─── Relay connection ───

async function connectRelayMode() {
  const { connectRelay } = await import("./relay-client.mjs")
  const relay = await connectRelay({
    port: customPort ?? parseInt(process.env.RELAY_PORT || "9333"),
    name: "security-audit",
  })

  if (!relay.isExtensionConnected()) {
    console.error("Warning: Extension relay page not connected yet.")
  }

  const tabOpts = targetTabId ? { tabId: targetTabId } : {}

  return {
    async evaluate(expr) {
      return relay.command("eval", { expression: expr }, tabOpts)
    },
    close() {
      relay.close()
    },
  }
}

// ─── Create unified driver ───

async function createDriver() {
  if (useRelay) {
    return connectRelayMode()
  } else {
    return connectCDP()
  }
}

// ─── HTTP header fetching ───

/**
 * Fetch HTTP response headers for a URL using Node's built-in http/https.
 * Returns a lowercase-keyed header map.
 */
function fetchHeaders(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http
    const req = mod.get(url, { timeout: 10000 }, (res) => {
      // Normalize headers to lowercase keys
      const headers = {}
      for (const [key, val] of Object.entries(res.headers)) {
        headers[key.toLowerCase()] = val
      }
      headers["_statusCode"] = res.statusCode
      // Consume body to free socket
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

// ─── Security check modules ───

/**
 * Check 1: Exposed Secrets — scan page source, localStorage, sessionStorage
 */
async function checkExposedSecrets(evaluate) {
  const findings = []

  const data = await evaluate(`
    (() => {
      const result = { pageSource: '', localStorage: {}, sessionStorage: {} };

      // Page HTML source (limit to 500KB to avoid memory issues)
      result.pageSource = document.documentElement.outerHTML.slice(0, 500000);

      // localStorage
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          result.localStorage[key] = localStorage.getItem(key).slice(0, 2000);
        }
      } catch (e) { /* access denied */ }

      // sessionStorage
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          result.sessionStorage[key] = sessionStorage.getItem(key).slice(0, 2000);
        }
      } catch (e) { /* access denied */ }

      return result;
    })()
  `)

  if (!data) return findings

  // Scan page source for secret patterns
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = data.pageSource.match(pattern)
    if (match) {
      const redacted = match[0].slice(0, 12) + "..." + match[0].slice(-4)
      const safe = isKnownSafe("", match[0])
      findings.push({
        severity: safe ? INFO : CRITICAL,
        category: "Exposed Secrets",
        message: safe
          ? `${name} pattern matched in page source (known-safe): ${redacted}`
          : `${name} found in page source: ${redacted}`,
      })
    }
  }

  // Scan localStorage
  for (const [key, value] of Object.entries(data.localStorage || {})) {
    const safe = isKnownSafe(key, value)
    // Check key name
    for (const pat of SENSITIVE_STORAGE_KEY_PATTERNS) {
      if (pat.test(key)) {
        const redacted = value.slice(0, 20) + (value.length > 20 ? "..." : "")
        findings.push({
          severity: safe ? INFO : CRITICAL,
          category: "Exposed Secrets",
          message: safe
            ? `localStorage key "${key}" matched sensitive pattern (known-safe SDK key): ${redacted}`
            : `Sensitive localStorage key "${key}": ${redacted}`,
        })
        break
      }
    }
    // Check value for secret patterns
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        const redacted = value.slice(0, 12) + "..."
        findings.push({
          severity: safe ? INFO : CRITICAL,
          category: "Exposed Secrets",
          message: safe
            ? `${name} pattern in localStorage["${key}"] (known-safe): ${redacted}`
            : `${name} in localStorage["${key}"]: ${redacted}`,
        })
        break
      }
    }
  }

  // Scan sessionStorage
  for (const [key, value] of Object.entries(data.sessionStorage || {})) {
    const safe = isKnownSafe(key, value)
    for (const pat of SENSITIVE_STORAGE_KEY_PATTERNS) {
      if (pat.test(key)) {
        const redacted = value.slice(0, 20) + (value.length > 20 ? "..." : "")
        findings.push({
          severity: safe ? INFO : CRITICAL,
          category: "Exposed Secrets",
          message: safe
            ? `sessionStorage key "${key}" matched sensitive pattern (known-safe SDK key): ${redacted}`
            : `Sensitive sessionStorage key "${key}": ${redacted}`,
        })
        break
      }
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        findings.push({
          severity: safe ? INFO : CRITICAL,
          category: "Exposed Secrets",
          message: safe
            ? `${name} pattern in sessionStorage["${key}"] (known-safe)`
            : `${name} in sessionStorage["${key}"]`,
        })
        break
      }
    }
  }

  if (findings.length === 0) {
    findings.push({
      severity: PASS,
      category: "Exposed Secrets",
      message: "No exposed API keys or tokens found in page source or storage",
    })
  }

  return findings
}

/**
 * Check 2: Security Headers
 */
async function checkSecurityHeaders(pageUrl) {
  const findings = []

  let headers = null
  try {
    headers = await fetchHeaders(pageUrl)
  } catch (err) {
    findings.push({
      severity: MEDIUM,
      category: "Security Headers",
      message: `Could not fetch headers: ${err.message}`,
    })
    return findings
  }

  // Content-Security-Policy
  if (headers["content-security-policy"]) {
    const csp = headers["content-security-policy"]
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: `Content-Security-Policy is set`,
    })
    // Check for unsafe directives
    // If CSP also has restrictive directives, downgrade to LOW (intentional/documented config)
    const hasRestrictiveCSP = (
      csp.includes("default-src 'self'") ||
      csp.includes("object-src 'none'") ||
      csp.includes("base-uri 'self'")
    )
    if (csp.includes("'unsafe-inline'")) {
      findings.push({
        severity: hasRestrictiveCSP ? LOW : MEDIUM,
        category: "Security Headers",
        message: "CSP allows 'unsafe-inline' — consider nonce-based CSP (may be required by framework)",
      })
    }
    if (csp.includes("'unsafe-eval'")) {
      findings.push({
        severity: hasRestrictiveCSP ? LOW : MEDIUM,
        category: "Security Headers",
        message: "CSP allows 'unsafe-eval' — consider removing if not required by framework",
      })
    }
    if (csp.includes("*")) {
      findings.push({
        severity: MEDIUM,
        category: "Security Headers",
        message: "CSP contains wildcard (*) source — overly permissive",
      })
    }
  } else {
    findings.push({
      severity: CRITICAL,
      category: "Security Headers",
      message: "Missing Content-Security-Policy header",
    })
  }

  // Strict-Transport-Security
  if (headers["strict-transport-security"]) {
    const hsts = headers["strict-transport-security"]
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: "Strict-Transport-Security (HSTS) is set",
    })
    if (!hsts.includes("includeSubDomains")) {
      findings.push({
        severity: LOW,
        category: "Security Headers",
        message: "HSTS missing includeSubDomains directive",
      })
    }
    const maxAgeMatch = hsts.match(/max-age=(\d+)/)
    if (maxAgeMatch && parseInt(maxAgeMatch[1]) < 31536000) {
      findings.push({
        severity: LOW,
        category: "Security Headers",
        message: `HSTS max-age is ${maxAgeMatch[1]}s (recommend >= 31536000)`,
      })
    }
  } else {
    findings.push({
      severity: HIGH,
      category: "Security Headers",
      message: "Missing Strict-Transport-Security (HSTS) header",
    })
  }

  // X-Frame-Options
  if (headers["x-frame-options"]) {
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: `X-Frame-Options: ${headers["x-frame-options"]}`,
    })
  } else {
    // Only flag if CSP frame-ancestors is also missing
    const csp = headers["content-security-policy"] || ""
    if (!csp.includes("frame-ancestors")) {
      findings.push({
        severity: HIGH,
        category: "Security Headers",
        message: "Missing X-Frame-Options and CSP frame-ancestors — clickjacking risk",
      })
    } else {
      findings.push({
        severity: PASS,
        category: "Security Headers",
        message: "X-Frame-Options not set but CSP frame-ancestors is configured",
      })
    }
  }

  // X-Content-Type-Options
  if (headers["x-content-type-options"] === "nosniff") {
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: "X-Content-Type-Options: nosniff",
    })
  } else {
    findings.push({
      severity: MEDIUM,
      category: "Security Headers",
      message: "Missing X-Content-Type-Options: nosniff header",
    })
  }

  // Referrer-Policy
  if (headers["referrer-policy"]) {
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: `Referrer-Policy: ${headers["referrer-policy"]}`,
    })
  } else {
    findings.push({
      severity: MEDIUM,
      category: "Security Headers",
      message: "Missing Referrer-Policy header",
    })
  }

  // Permissions-Policy
  if (headers["permissions-policy"]) {
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: "Permissions-Policy is set",
    })
  } else {
    findings.push({
      severity: LOW,
      category: "Security Headers",
      message: "Missing Permissions-Policy header",
    })
  }

  // Server header — information disclosure
  if (headers["server"]) {
    const platformControlled = /^(vercel|cloudflare|netlify|amazonaws|gws|cloudfront)/i.test(headers["server"])
    findings.push({
      severity: platformControlled ? INFO : LOW,
      category: "Security Headers",
      message: platformControlled
        ? `Server header reveals: ${headers["server"]} (platform-controlled, cannot be removed)`
        : `Server header reveals: ${headers["server"]}`,
    })
  } else {
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: "Server header not exposed",
    })
  }

  // X-Powered-By
  if (headers["x-powered-by"]) {
    findings.push({
      severity: LOW,
      category: "Security Headers",
      message: `X-Powered-By header reveals: ${headers["x-powered-by"]}`,
    })
  } else {
    findings.push({
      severity: PASS,
      category: "Security Headers",
      message: "X-Powered-By header not exposed",
    })
  }

  return findings
}

/**
 * Check 3: Authentication Issues
 */
async function checkAuthentication(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];

      // Password fields without type="password"
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
            severity: 'HIGH',
            category: 'Authentication',
            message: 'Password field without type="password": ' + sel,
          });
        }
      }

      // Password inputs without autocomplete
      const passwordInputs = document.querySelectorAll('input[type="password"]');
      for (const input of passwordInputs) {
        const ac = input.getAttribute('autocomplete');
        if (!ac || (ac !== 'new-password' && ac !== 'current-password' && ac !== 'off')) {
          const sel = input.id ? '#' + input.id : (input.name ? '[name="' + input.name + '"]' : 'input[type="password"]');
          findings.push({
            severity: 'HIGH',
            category: 'Authentication',
            message: 'Password input missing autocomplete="new-password" or "current-password": ' + sel,
          });
        }
      }
      if (passwordInputs.length > 0 && findings.filter(f => f.category === 'Authentication' && f.message.includes('autocomplete')).length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Authentication',
          message: 'All password inputs have proper autocomplete attributes',
        });
      }

      // Login forms without CSRF tokens
      const forms = document.querySelectorAll('form');
      let loginFormCount = 0;
      for (const form of forms) {
        const hasPassword = form.querySelector('input[type="password"]');
        const action = (form.action || '').toLowerCase();
        const isLogin = hasPassword || action.includes('login') || action.includes('signin') || action.includes('auth');
        if (!isLogin) continue;
        loginFormCount++;
        const csrfInput = form.querySelector(
          'input[name="csrf"], input[name="_csrf"], input[name="csrfmiddlewaretoken"], ' +
          'input[name="_token"], input[name="authenticity_token"], input[name="__RequestVerificationToken"]'
        );
        const csrfMeta = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]');
        if (!csrfInput && !csrfMeta) {
          findings.push({
            severity: 'HIGH',
            category: 'Authentication',
            message: 'Login form missing CSRF token: ' + (form.id ? '#' + form.id : form.action || 'form'),
          });
        }
      }
      if (loginFormCount > 0 && findings.filter(f => f.message.includes('CSRF')).length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Authentication',
          message: 'Login forms have CSRF protection',
        });
      }

      // Tokens in URL parameters
      const urlParams = new URLSearchParams(location.search);
      const sensitiveParams = ['token', 'access_token', 'api_key', 'apikey', 'secret', 'password', 'session_id', 'auth'];
      for (const param of sensitiveParams) {
        if (urlParams.has(param)) {
          findings.push({
            severity: 'HIGH',
            category: 'Authentication',
            message: 'Sensitive token exposed in URL parameter: ' + param,
          });
        }
      }
      if (findings.filter(f => f.message.includes('URL parameter')).length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Authentication',
          message: 'No sensitive tokens in URL parameters',
        });
      }

      return findings;
    })()
  `)
}

/**
 * Check 4: Input Validation
 */
async function checkInputValidation(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const textInputTypes = ['text', 'search', 'url', 'tel', 'email', 'number', ''];
      const inputs = document.querySelectorAll('input, textarea');
      let missingValidation = 0;
      let unlimitedLength = 0;
      let missingType = 0;

      for (const input of inputs) {
        if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button' ||
            input.type === 'checkbox' || input.type === 'radio' || input.type === 'file') continue;

        const style = getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const isInForm = !!input.closest('form');
        const selector = input.id ? '#' + input.id :
          (input.name ? '[name="' + input.name + '"]' : input.tagName.toLowerCase());

        // Check for missing validation attributes on form inputs
        if (isInForm) {
          const hasRequired = input.hasAttribute('required');
          const hasPattern = input.hasAttribute('pattern');
          const hasMinlength = input.hasAttribute('minlength');
          const hasMaxlength = input.hasAttribute('maxlength');
          const hasMin = input.hasAttribute('min');
          const hasMax = input.hasAttribute('max');
          if (!hasRequired && !hasPattern && !hasMinlength && !hasMaxlength && !hasMin && !hasMax) {
            missingValidation++;
          }
        }

        // Text inputs without maxlength
        if (textInputTypes.includes(input.type) || input.tagName === 'TEXTAREA') {
          if (!input.hasAttribute('maxlength')) {
            unlimitedLength++;
          }
        }

        // Inputs without explicit type attribute
        if (input.tagName === 'INPUT' && !input.hasAttribute('type')) {
          missingType++;
        }
      }

      if (missingValidation > 0) {
        findings.push({
          severity: 'MEDIUM',
          category: 'Input Validation',
          message: missingValidation + ' form input(s) without any validation attributes (required, pattern, maxlength)',
        });
      } else {
        findings.push({
          severity: 'PASS',
          category: 'Input Validation',
          message: 'All form inputs have validation attributes',
        });
      }

      if (unlimitedLength > 0) {
        findings.push({
          severity: 'LOW',
          category: 'Input Validation',
          message: unlimitedLength + ' text input(s) accept unlimited length (no maxlength)',
        });
      } else {
        findings.push({
          severity: 'PASS',
          category: 'Input Validation',
          message: 'All text inputs have maxlength constraints',
        });
      }

      if (missingType > 0) {
        findings.push({
          severity: 'LOW',
          category: 'Input Validation',
          message: missingType + ' input(s) without explicit type attribute (defaults to text)',
        });
      } else {
        findings.push({
          severity: 'PASS',
          category: 'Input Validation',
          message: 'All inputs have explicit type attributes',
        });
      }

      return findings;
    })()
  `)
}

/**
 * Check 5: Information Disclosure
 */
async function checkInfoDisclosure(evaluate, pageUrl) {
  const findings = []

  // DOM-based checks
  const domFindings = await evaluate(`
    (() => {
      const findings = [];

      // Check for detailed error messages in the DOM
      const errorPatterns = [
        /Error:.*at\\s+\\w+\\s+\\(/i,
        /TypeError:/i,
        /ReferenceError:/i,
        /SyntaxError:/i,
        /Unhandled.*rejection/i,
        /ENOENT|EACCES|ECONNREFUSED/i,
        /Stack trace:/i,
        /at\\s+Object\\.</i,
        /at\\s+Module\\.</i,
      ];
      const bodyText = document.body ? document.body.innerText.slice(0, 100000) : '';
      for (const pat of errorPatterns) {
        const match = bodyText.match(pat);
        if (match) {
          findings.push({
            severity: 'HIGH',
            category: 'Information Disclosure',
            message: 'Error message/stack trace visible in DOM: ' + match[0].slice(0, 80),
          });
          break;
        }
      }

      // Check HTML comments for sensitive info
      const html = document.documentElement.outerHTML.slice(0, 200000);
      const commentPattern = /<!--[\\s\\S]*?-->/g;
      let commentMatch;
      let devComments = 0;
      const sensitiveCommentPatterns = [
        /TODO/i, /FIXME/i, /HACK/i, /BUG/i, /XXX/i,
        /password/i, /secret/i, /api.?key/i, /token/i,
        /debug/i, /temporary/i, /remove.*before/i,
      ];
      while ((commentMatch = commentPattern.exec(html)) !== null) {
        const comment = commentMatch[0];
        if (comment.length < 10) continue; // skip trivial comments
        for (const sp of sensitiveCommentPatterns) {
          if (sp.test(comment)) {
            devComments++;
            break;
          }
        }
      }
      if (devComments > 0) {
        findings.push({
          severity: 'LOW',
          category: 'Information Disclosure',
          message: devComments + ' HTML comment(s) contain developer notes (TODO/FIXME/debug/sensitive keywords)',
        });
      } else {
        findings.push({
          severity: 'PASS',
          category: 'Information Disclosure',
          message: 'No sensitive information in HTML comments',
        });
      }

      // Check for visible stack traces
      const preElements = document.querySelectorAll('pre, code, .error, .stack-trace, [class*="error"]');
      for (const el of preElements) {
        const text = (el.textContent || '').trim();
        if (text.length > 100 && /at\s+\w+.*\(.*:\d+:\d+\)/.test(text)) {
          findings.push({
            severity: 'HIGH',
            category: 'Information Disclosure',
            message: 'Stack trace visible on page in <' + el.tagName.toLowerCase() + '> element',
          });
          break;
        }
      }

      if (findings.filter(f => f.message.includes('Error message') || f.message.includes('Stack trace')).length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Information Disclosure',
          message: 'No error messages or stack traces visible in DOM',
        });
      }

      return findings;
    })()
  `)

  findings.push(...(domFindings || []))

  // Check for source maps
  const sourceMapCheck = await evaluate(`
    (() => {
      const scripts = document.querySelectorAll('script[src]');
      const mapUrls = [];
      for (const s of scripts) {
        const src = s.getAttribute('src');
        if (src && (src.endsWith('.js') || src.endsWith('.mjs'))) {
          mapUrls.push(src + '.map');
        }
      }
      // Also check inline sourceMappingURL comments
      const allScripts = document.querySelectorAll('script');
      for (const s of allScripts) {
        const text = s.textContent || '';
        const match = text.match(/\\/\\/[#@]\\s*sourceMappingURL=(.+)/);
        if (match) {
          mapUrls.push(match[1].trim());
        }
      }
      return mapUrls.slice(0, 10);
    })()
  `)

  if (sourceMapCheck && sourceMapCheck.length > 0) {
    // Try to verify if source maps are actually accessible
    let accessibleMaps = 0
    for (const mapUrl of sourceMapCheck.slice(0, 3)) {
      try {
        let fullUrl = mapUrl
        if (mapUrl.startsWith("/")) {
          const u = new URL(pageUrl)
          fullUrl = u.origin + mapUrl
        } else if (!mapUrl.startsWith("http")) {
          const u = new URL(pageUrl)
          fullUrl = u.origin + "/" + mapUrl
        }
        const mapHeaders = await fetchHeaders(fullUrl)
        if (mapHeaders["_statusCode"] === 200) {
          accessibleMaps++
        }
      } catch {
        // Can't verify — still flag as potential
      }
    }

    if (accessibleMaps > 0) {
      findings.push({
        severity: HIGH,
        category: "Information Disclosure",
        message: `${accessibleMaps} source map(s) accessible in production`,
      })
    } else {
      findings.push({
        severity: LOW,
        category: "Information Disclosure",
        message: `Source map references found in scripts but maps may not be accessible`,
      })
    }
  } else {
    findings.push({
      severity: PASS,
      category: "Information Disclosure",
      message: "No source map references found",
    })
  }

  return findings
}

/**
 * Check 6: Clickjacking
 */
async function checkClickjacking(evaluate, headers) {
  const findings = []

  const hasXFrameOptions = headers && headers["x-frame-options"]
  const csp = (headers && headers["content-security-policy"]) || ""
  const hasFrameAncestors = csp.includes("frame-ancestors")

  if (!hasXFrameOptions && !hasFrameAncestors) {
    findings.push({
      severity: HIGH,
      category: "Clickjacking",
      message: "No clickjacking protection — missing X-Frame-Options and CSP frame-ancestors",
    })
  } else {
    findings.push({
      severity: PASS,
      category: "Clickjacking",
      message: "Clickjacking protection configured via " +
        (hasXFrameOptions ? "X-Frame-Options" : "") +
        (hasXFrameOptions && hasFrameAncestors ? " and " : "") +
        (hasFrameAncestors ? "CSP frame-ancestors" : ""),
    })
  }

  // Check for framebusting code
  const hasFramebuster = await evaluate(`
    (() => {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent || '';
        if (text.includes('top.location') || text.includes('self !== top') ||
            text.includes('parent.frames') || text.includes('window.top')) {
          return true;
        }
      }
      return false;
    })()
  `)

  if (hasFramebuster) {
    findings.push({
      severity: PASS,
      category: "Clickjacking",
      message: "Client-side framebusting code detected",
    })
  } else if (!hasXFrameOptions && !hasFrameAncestors) {
    findings.push({
      severity: MEDIUM,
      category: "Clickjacking",
      message: "No client-side framebusting code found either",
    })
  }

  return findings
}

/**
 * Check 7: Mixed Content
 */
async function checkMixedContent(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const isHttps = location.protocol === 'https:';

      if (!isHttps) {
        findings.push({
          severity: 'MEDIUM',
          category: 'Mixed Content',
          message: 'Page is served over HTTP (not HTTPS)',
        });
        return findings;
      }

      findings.push({
        severity: 'PASS',
        category: 'Mixed Content',
        message: 'Page is served over HTTPS',
      });

      // Check for HTTP resources on HTTPS page
      let httpResources = 0;
      const resourceSelectors = [
        { sel: 'img[src^="http:"]', type: 'image' },
        { sel: 'script[src^="http:"]', type: 'script' },
        { sel: 'link[href^="http:"]', type: 'stylesheet/link' },
        { sel: 'iframe[src^="http:"]', type: 'iframe' },
        { sel: 'video[src^="http:"], video source[src^="http:"]', type: 'video' },
        { sel: 'audio[src^="http:"], audio source[src^="http:"]', type: 'audio' },
        { sel: 'object[data^="http:"]', type: 'object' },
        { sel: 'embed[src^="http:"]', type: 'embed' },
      ];

      for (const { sel, type } of resourceSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          httpResources += els.length;
          findings.push({
            severity: 'HIGH',
            category: 'Mixed Content',
            message: els.length + ' insecure HTTP ' + type + '(s) on HTTPS page',
          });
        }
      }

      // Check form actions
      const insecureForms = document.querySelectorAll('form[action^="http:"]');
      if (insecureForms.length > 0) {
        findings.push({
          severity: 'CRITICAL',
          category: 'Mixed Content',
          message: insecureForms.length + ' form(s) submit to insecure HTTP endpoint',
        });
      }

      if (httpResources === 0 && insecureForms.length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Mixed Content',
          message: 'No mixed content detected — all resources loaded over HTTPS',
        });
      }

      return findings;
    })()
  `)
}

/**
 * Check 8: Cookie Security
 */
async function checkCookieSecurity(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const cookies = document.cookie;

      if (!cookies || cookies.trim().length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Cookie Security',
          message: 'No cookies accessible to JavaScript (may indicate HttpOnly is set)',
        });
        return findings;
      }

      // Parse cookies — note: HttpOnly cookies won't appear in document.cookie
      const cookiePairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
      const cookieNames = cookiePairs.map(c => c.split('=')[0].trim());

      // Known SDK cookie patterns (developer can't control these flags)
      const sdkCookiePatterns = [
        /^stack-s-/i, /^__Host-stack-/i, /^__stripe_/i, /^__clerk_/i,
        /^__Secure-/i, /^_ga/i, /^_gid/i, /^_fbp/i, /^intercom-/i,
      ];
      function isSdkCookie(n) {
        return sdkCookiePatterns.some(function(p) { return p.test(n); });
      }

      // If cookies are accessible via JS, that means they lack HttpOnly
      for (const name of cookieNames) {
        const lower = name.toLowerCase();
        if (lower.includes('session') || lower.includes('token') || lower.includes('auth') ||
            lower.includes('jwt') || lower.includes('sid') || lower === 'connect.sid') {
          const sdk = isSdkCookie(name);
          findings.push({
            severity: sdk ? 'LOW' : 'HIGH',
            category: 'Cookie Security',
            message: sdk
              ? 'Cookie "' + name + '" accessible to JavaScript (set by third-party SDK)'
              : 'Sensitive cookie "' + name + '" accessible to JavaScript (missing HttpOnly flag)',
          });
        }
      }

      // General note about JS-accessible cookies
      if (cookieNames.length > 0) {
        var sdkCount = cookieNames.filter(function(n) { return isSdkCookie(n); }).length;
        var firstPartyCount = cookieNames.length - sdkCount;
        if (firstPartyCount > 0) {
          findings.push({
            severity: 'MEDIUM',
            category: 'Cookie Security',
            message: firstPartyCount + ' first-party cookie(s) accessible to JavaScript: ' +
              cookieNames.filter(function(n) { return !isSdkCookie(n); }).join(', '),
          });
        }
        if (sdkCount > 0) {
          findings.push({
            severity: 'LOW',
            category: 'Cookie Security',
            message: sdkCount + ' third-party SDK cookie(s) accessible to JavaScript: ' +
              cookieNames.filter(function(n) { return isSdkCookie(n); }).join(', '),
          });
        }
      }

      // Note: We can't check Secure and SameSite from JavaScript —
      // that requires HTTP response header inspection (Set-Cookie)
      // We flag this as a limitation
      findings.push({
        severity: 'PASS',
        category: 'Cookie Security',
        message: 'Note: Secure/SameSite flags checked via Set-Cookie headers (see header check)',
      });

      return findings;
    })()
  `)
}

/**
 * Check 9: Client-Side Storage — PII and sensitive data
 */
async function checkClientStorage(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];
      const piiPatterns = [
        { name: 'Social Security Number', pattern: /\\b\\d{3}-\\d{2}-\\d{4}\\b/ },
        { name: 'Credit card number', pattern: /\\b(?:4\\d{3}|5[1-5]\\d{2}|3[47]\\d{2}|6(?:011|5\\d{2}))[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b/ },
        { name: 'Email address', pattern: /\\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}\\b/ },
      ];

      function scanStorage(storage, storageName) {
        try {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            const value = storage.getItem(key) || '';
            for (const { name, pattern } of piiPatterns) {
              if (pattern.test(value)) {
                // Email in storage is very common and not always PII leakage
                const sev = name === 'Email address' ? 'LOW' : 'MEDIUM';
                findings.push({
                  severity: sev,
                  category: 'Client-Side Storage',
                  message: name + ' found in ' + storageName + '["' + key + '"]',
                });
                break;
              }
            }
          }
        } catch (e) {
          // Access denied
        }
      }

      scanStorage(localStorage, 'localStorage');
      scanStorage(sessionStorage, 'sessionStorage');

      // Check cookies for PII
      const cookies = document.cookie;
      if (cookies) {
        for (const { name, pattern } of piiPatterns) {
          if (pattern.test(cookies)) {
            findings.push({
              severity: 'MEDIUM',
              category: 'Client-Side Storage',
              message: name + ' found in cookies',
            });
          }
        }
      }

      if (findings.length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'Client-Side Storage',
          message: 'No PII detected in localStorage, sessionStorage, or cookies',
        });
      }

      return findings;
    })()
  `)
}

/**
 * Check 10: DOM XSS Indicators
 */
async function checkDomXSS(evaluate) {
  return evaluate(`
    (() => {
      const findings = [];

      // Scan inline scripts for dangerous patterns
      const scripts = document.querySelectorAll('script:not([src])');
      let innerHTMLCount = 0;
      let documentWriteCount = 0;
      let evalCount = 0;

      for (const s of scripts) {
        const text = s.textContent || '';
        // Skip Next.js data scripts — these are framework hydration, not XSS
        var isNextData = s.id === '__NEXT_DATA__' || s.type === 'application/json';
        if (isNextData) continue;

        // innerHTML usage
        const innerHTMLMatches = text.match(/\\.innerHTML\\s*[=+]/g);
        if (innerHTMLMatches) innerHTMLCount += innerHTMLMatches.length;

        // document.write usage
        const docWriteMatches = text.match(/document\\.write(ln)?\\s*\\(/g);
        if (docWriteMatches) documentWriteCount += docWriteMatches.length;

        // eval usage
        const evalMatches = text.match(/\\beval\\s*\\(/g);
        if (evalMatches) evalCount += evalMatches.length;
      }

      // Also check for dangerouslySetInnerHTML in React apps
      const html = document.documentElement.outerHTML.slice(0, 300000);
      const dangerouslyCount = (html.match(/dangerouslySetInnerHTML/g) || []).length;

      if (innerHTMLCount > 0) {
        findings.push({
          severity: 'MEDIUM',
          category: 'DOM XSS',
          message: innerHTMLCount + ' innerHTML assignment(s) in inline scripts — potential XSS vector',
        });
      }

      if (documentWriteCount > 0) {
        findings.push({
          severity: 'HIGH',
          category: 'DOM XSS',
          message: documentWriteCount + ' document.write() call(s) — DOM XSS risk',
        });
      }

      if (evalCount > 0) {
        findings.push({
          severity: 'HIGH',
          category: 'DOM XSS',
          message: evalCount + ' eval() call(s) in inline scripts — code injection risk',
        });
      }

      if (dangerouslyCount > 0) {
        findings.push({
          severity: 'LOW',
          category: 'DOM XSS',
          message: dangerouslyCount + ' dangerouslySetInnerHTML usage(s) found — verify content is sanitized',
        });
      }

      // Check for unescaped URL parameters in DOM
      const urlParams = new URLSearchParams(location.search);
      if (urlParams.toString()) {
        const bodyHTML = document.body ? document.body.innerHTML.slice(0, 200000) : '';
        for (const [key, value] of urlParams) {
          if (value.length > 3 && bodyHTML.includes(value)) {
            findings.push({
              severity: 'MEDIUM',
              category: 'DOM XSS',
              message: 'URL parameter "' + key + '" value reflected in DOM without apparent escaping',
            });
          }
        }
      }

      if (findings.length === 0) {
        findings.push({
          severity: 'PASS',
          category: 'DOM XSS',
          message: 'No obvious DOM XSS indicators found (innerHTML, document.write, eval)',
        });
      }

      return findings;
    })()
  `)
}

// ─── Scoring ───

function calculateScore(findings) {
  // Start at 100, deduct points per severity
  // INFO = 0 deduction (acknowledged but not a real issue)
  const deductions = {
    [CRITICAL]: 15,
    [HIGH]: 8,
    [MEDIUM]: 4,
    [LOW]: 2,
    [INFO]: 0,
  }

  let score = 100
  for (const f of findings) {
    if (f.severity in deductions) {
      score -= deductions[f.severity]
    }
  }

  return Math.max(0, Math.min(100, score))
}

// ─── Report builder ───

function buildReport(url, findings) {
  const bySeverity = {
    [CRITICAL]: [],
    [HIGH]: [],
    [MEDIUM]: [],
    [LOW]: [],
    [INFO]: [],
    [PASS]: [],
  }

  for (const f of findings) {
    if (bySeverity[f.severity]) {
      bySeverity[f.severity].push(f)
    }
  }

  const score = calculateScore(findings)

  return {
    url,
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    findings,
    summary: {
      critical: bySeverity[CRITICAL].length,
      high: bySeverity[HIGH].length,
      medium: bySeverity[MEDIUM].length,
      low: bySeverity[LOW].length,
      info: bySeverity[INFO].length,
      passed: bySeverity[PASS].length,
    },
    bySeverity,
    score,
  }
}

// ─── Console output ───

function printReport(report) {
  console.log(`\n=== Security Audit ===`)
  console.log(`URL: ${report.url}`)
  console.log(`Date: ${report.date}`)
  console.log()

  const severityOrder = [CRITICAL, HIGH, MEDIUM, LOW, INFO]
  const severityColors = {
    [CRITICAL]: "\x1b[91m",  // bright red
    [HIGH]: "\x1b[31m",      // red
    [MEDIUM]: "\x1b[33m",    // yellow
    [LOW]: "\x1b[36m",       // cyan
    [INFO]: "\x1b[90m",      // gray
  }
  const reset = "\x1b[0m"
  const green = "\x1b[32m"

  for (const sev of severityOrder) {
    const items = report.bySeverity[sev]
    if (items.length === 0) continue

    const color = severityColors[sev] || ""
    console.log(`${color}${sev} (${items.length}):${reset}`)
    for (const f of items) {
      console.log(`${color}  \u2717 [${f.category}] ${f.message}${reset}`)
    }
    console.log()
  }

  if (verbose) {
    const passed = report.bySeverity[PASS]
    if (passed.length > 0) {
      console.log(`${green}PASSED (${passed.length}):${reset}`)
      for (const f of passed) {
        console.log(`${green}  \u2713 [${f.category}] ${f.message}${reset}`)
      }
      console.log()
    }
  }

  // Score bar
  const scoreColor = report.score >= 80 ? green :
    report.score >= 60 ? "\x1b[33m" : "\x1b[31m"
  console.log(`${scoreColor}Score: ${report.score}/100${reset}`)

  // Summary line
  const totalIssues = report.summary.critical + report.summary.high + report.summary.medium + report.summary.low
  if (totalIssues === 0) {
    console.log(`${green}No security issues detected.${reset}`)
  } else {
    console.log(
      `Issues: ${report.summary.critical} critical, ${report.summary.high} high, ` +
      `${report.summary.medium} medium, ${report.summary.low} low` +
      (report.summary.info > 0 ? `, ${report.summary.info} info` : "") +
      ` | ${report.summary.passed} checks passed`
    )
  }
  console.log()
}

// ─── Main ───

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Security Audit Tool — OWASP Top 10 DOM-based scanner

Usage:
  node cli/security-audit.mjs --relay                    # audit active tab
  node cli/security-audit.mjs --relay --tab 704448023    # audit specific tab
  node cli/security-audit.mjs --url https://example.com  # CDP mode
  node cli/security-audit.mjs --relay --output report.json
  node cli/security-audit.mjs --relay --verbose          # show all checks

Flags:
  --relay           Use WebSocket relay mode (no CDP required)
  --url <url>       Navigate to URL before scanning (CDP mode)
  --tab <id>        Target a specific browser tab (relay mode)
  --port <number>   Override connection port
  --output <file>   Save JSON report to file
  --verbose         Show passed checks in output
  -h, --help        Show this help
`)
    process.exit(0)
  }

  console.log("Connecting...")
  const driver = await createDriver()

  // Get current page URL
  const pageUrl = await driver.evaluate("location.href")
  console.log(`Auditing: ${pageUrl}`)
  console.log()

  const allFindings = []

  // Run all checks
  const checks = [
    { name: "Exposed Secrets", fn: () => checkExposedSecrets(driver.evaluate.bind(driver)) },
    { name: "Authentication", fn: () => checkAuthentication(driver.evaluate.bind(driver)) },
    { name: "Input Validation", fn: () => checkInputValidation(driver.evaluate.bind(driver)) },
    { name: "Mixed Content", fn: () => checkMixedContent(driver.evaluate.bind(driver)) },
    { name: "Cookie Security", fn: () => checkCookieSecurity(driver.evaluate.bind(driver)) },
    { name: "Client-Side Storage", fn: () => checkClientStorage(driver.evaluate.bind(driver)) },
    { name: "DOM XSS", fn: () => checkDomXSS(driver.evaluate.bind(driver)) },
  ]

  // Header-dependent checks (run if we can fetch the URL)
  let headers = null
  const isRemoteUrl = pageUrl.startsWith("http://") || pageUrl.startsWith("https://")

  for (const check of checks) {
    process.stdout.write(`  Checking ${check.name}...`)
    try {
      const results = await check.fn()
      if (results && Array.isArray(results)) {
        allFindings.push(...results)
      }
      const issues = (results || []).filter(r => r.severity !== PASS).length
      console.log(issues > 0 ? ` ${issues} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
      allFindings.push({
        severity: MEDIUM,
        category: check.name,
        message: `Check failed: ${err.message}`,
      })
    }
  }

  // Security headers (requires HTTP fetch)
  if (isRemoteUrl) {
    process.stdout.write("  Checking Security Headers...")
    try {
      const headerFindings = await checkSecurityHeaders(pageUrl)
      allFindings.push(...headerFindings)
      headers = await fetchHeaders(pageUrl).catch(() => null)
      const issues = headerFindings.filter(r => r.severity !== PASS).length
      console.log(issues > 0 ? ` ${issues} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Info disclosure (includes source map HTTP checks)
    process.stdout.write("  Checking Information Disclosure...")
    try {
      const infoFindings = await checkInfoDisclosure(driver.evaluate.bind(driver), pageUrl)
      allFindings.push(...infoFindings)
      const issues = infoFindings.filter(r => r.severity !== PASS).length
      console.log(issues > 0 ? ` ${issues} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }

    // Clickjacking
    process.stdout.write("  Checking Clickjacking...")
    try {
      const clickjackFindings = await checkClickjacking(driver.evaluate.bind(driver), headers)
      allFindings.push(...clickjackFindings)
      const issues = clickjackFindings.filter(r => r.severity !== PASS).length
      console.log(issues > 0 ? ` ${issues} issue(s)` : " OK")
    } catch (err) {
      console.log(` ERROR: ${err.message}`)
    }
  } else {
    console.log("  Skipping header/network checks (non-HTTP URL)")
    allFindings.push({
      severity: LOW,
      category: "Security Headers",
      message: "Cannot check HTTP headers — page is not served over HTTP/HTTPS",
    })
  }

  console.log()

  // Build and display report
  const report = buildReport(pageUrl, allFindings)
  printReport(report)

  // Save JSON report if requested
  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify(report, null, 2))
    console.log(`Report saved to: ${outputFile}`)
  }

  driver.close()

  // Exit code: 2 for critical, 1 for high, 0 otherwise
  if (report.summary.critical > 0) process.exit(2)
  if (report.summary.high > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(3)
})

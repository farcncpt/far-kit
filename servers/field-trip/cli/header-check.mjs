#!/usr/bin/env node
/**
 * header-check.mjs — Quick HTTP security header checker.
 *
 * Fetches a URL and reports all security-relevant HTTP response headers
 * with pass/fail assessment for each. Standalone ESM module.
 *
 * Usage:
 *   node cli/header-check.mjs https://example.com
 *   node cli/header-check.mjs --relay              # checks current tab's URL
 *   node cli/header-check.mjs --relay --tab 123     # checks specific tab's URL
 *   node cli/header-check.mjs --json                # JSON output
 *
 * Environment:
 *   RELAY_PORT — WebSocket relay port (default: 9333)
 */

import http from "http"
import https from "https"

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
const jsonOutput = hasFlag("--json")

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

// Get URL from positional arg (first arg that doesn't start with --)
const positionalUrl = rawArgs.find(a => !a.startsWith("--") && a !== rawArgs[portIdx + 1] && a !== rawArgs[tabIdx + 1])

// ─── Header definitions ───

const SECURITY_HEADERS = [
  {
    name: "Content-Security-Policy",
    key: "content-security-policy",
    severity: "CRITICAL",
    description: "Prevents XSS, clickjacking, and other code injection attacks",
    check: (val) => {
      if (!val) return { pass: false, note: "Missing — no XSS protection via CSP" }
      const warnings = []
      if (val.includes("'unsafe-inline'")) warnings.push("allows unsafe-inline")
      if (val.includes("'unsafe-eval'")) warnings.push("allows unsafe-eval")
      if (/ \*[ ;]/.test(val) || val.endsWith(" *")) warnings.push("contains wildcard source")
      if (warnings.length > 0) {
        return { pass: true, note: `Set but ${warnings.join(", ")}`, warn: true }
      }
      return { pass: true, note: "Configured" }
    },
  },
  {
    name: "Strict-Transport-Security",
    key: "strict-transport-security",
    severity: "HIGH",
    description: "Forces HTTPS connections (HSTS)",
    check: (val) => {
      if (!val) return { pass: false, note: "Missing — no HSTS enforcement" }
      const maxAge = val.match(/max-age=(\d+)/)
      const age = maxAge ? parseInt(maxAge[1]) : 0
      const parts = []
      parts.push(`max-age=${age}`)
      if (val.includes("includeSubDomains")) parts.push("includeSubDomains")
      else parts.push("missing includeSubDomains")
      if (val.includes("preload")) parts.push("preload")
      if (age < 31536000) {
        return { pass: true, note: parts.join(", ") + " (recommend max-age >= 31536000)", warn: true }
      }
      return { pass: true, note: parts.join(", ") }
    },
  },
  {
    name: "X-Frame-Options",
    key: "x-frame-options",
    severity: "HIGH",
    description: "Prevents clickjacking by controlling iframe embedding",
    check: (val, allHeaders) => {
      if (!val) {
        const csp = allHeaders["content-security-policy"] || ""
        if (csp.includes("frame-ancestors")) {
          return { pass: true, note: "Not set, but CSP frame-ancestors is configured" }
        }
        return { pass: false, note: "Missing — clickjacking risk" }
      }
      const upper = val.toUpperCase()
      if (upper === "DENY" || upper === "SAMEORIGIN") {
        return { pass: true, note: val }
      }
      return { pass: true, note: val, warn: true }
    },
  },
  {
    name: "X-Content-Type-Options",
    key: "x-content-type-options",
    severity: "MEDIUM",
    description: "Prevents MIME-type sniffing attacks",
    check: (val) => {
      if (!val) return { pass: false, note: "Missing — MIME sniffing risk" }
      if (val.toLowerCase() === "nosniff") return { pass: true, note: "nosniff" }
      return { pass: true, note: val, warn: true }
    },
  },
  {
    name: "Referrer-Policy",
    key: "referrer-policy",
    severity: "MEDIUM",
    description: "Controls how much referrer information is sent with requests",
    check: (val) => {
      if (!val) return { pass: false, note: "Missing — full URL sent as referrer" }
      const safe = ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"]
      if (safe.includes(val.toLowerCase())) return { pass: true, note: val }
      return { pass: true, note: val, warn: true }
    },
  },
  {
    name: "Permissions-Policy",
    key: "permissions-policy",
    severity: "LOW",
    description: "Controls browser features (camera, microphone, geolocation, etc.)",
    check: (val) => {
      if (!val) return { pass: false, note: "Missing — browser features unrestricted" }
      return { pass: true, note: `Set (${val.length} chars)` }
    },
  },
  {
    name: "X-XSS-Protection",
    key: "x-xss-protection",
    severity: "LOW",
    description: "Legacy XSS filter (modern browsers use CSP instead)",
    check: (val) => {
      if (!val) return { pass: false, note: "Not set (legacy header, CSP is preferred)" }
      return { pass: true, note: val }
    },
  },
  {
    name: "Cross-Origin-Opener-Policy",
    key: "cross-origin-opener-policy",
    severity: "LOW",
    description: "Isolates browsing context from cross-origin documents",
    check: (val) => {
      if (!val) return { pass: false, note: "Not set" }
      return { pass: true, note: val }
    },
  },
  {
    name: "Cross-Origin-Resource-Policy",
    key: "cross-origin-resource-policy",
    severity: "LOW",
    description: "Controls which origins can load resources",
    check: (val) => {
      if (!val) return { pass: false, note: "Not set" }
      return { pass: true, note: val }
    },
  },
  {
    name: "Cross-Origin-Embedder-Policy",
    key: "cross-origin-embedder-policy",
    severity: "LOW",
    description: "Controls loading of cross-origin resources",
    check: (val) => {
      if (!val) return { pass: false, note: "Not set" }
      return { pass: true, note: val }
    },
  },
]

// Headers that leak server information
const INFO_LEAK_HEADERS = [
  { name: "Server", key: "server", description: "Reveals web server software" },
  { name: "X-Powered-By", key: "x-powered-by", description: "Reveals application framework" },
  { name: "X-AspNet-Version", key: "x-aspnet-version", description: "Reveals ASP.NET version" },
  { name: "X-AspNetMvc-Version", key: "x-aspnetmvc-version", description: "Reveals ASP.NET MVC version" },
  { name: "X-Generator", key: "x-generator", description: "Reveals site generator" },
]

// ─── HTTP fetch ───

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
      reject(new Error("Connection timeout"))
    })
  })
}

// ─── Get URL via relay ───

async function getUrlFromRelay() {
  const { connectRelay } = await import("./relay-client.mjs")
  const relay = await connectRelay({
    port: customPort ?? parseInt(process.env.RELAY_PORT || "9333"),
    name: "header-check",
  })

  const tabOpts = targetTabId ? { tabId: targetTabId } : {}

  try {
    const url = await relay.command("eval", { expression: "location.href" }, tabOpts)
    return url
  } finally {
    relay.close()
  }
}

// ─── Cookie analysis from Set-Cookie headers ───

function analyzeCookies(headers) {
  const findings = []
  const setCookie = headers["set-cookie"]
  if (!setCookie) {
    findings.push({ pass: true, note: "No Set-Cookie headers in response" })
    return findings
  }

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const cookie of cookies) {
    const name = cookie.split("=")[0].trim()
    const lower = cookie.toLowerCase()
    const issues = []

    if (!lower.includes("secure")) issues.push("missing Secure")
    if (!lower.includes("httponly")) issues.push("missing HttpOnly")
    if (!lower.includes("samesite")) issues.push("missing SameSite")

    if (issues.length > 0) {
      findings.push({
        pass: false,
        cookie: name,
        note: issues.join(", "),
      })
    } else {
      findings.push({
        pass: true,
        cookie: name,
        note: "Secure, HttpOnly, SameSite set",
      })
    }
  }

  return findings
}

// ─── Output ───

function printResults(url, headers, results, cookieResults) {
  const green = "\x1b[32m"
  const red = "\x1b[31m"
  const yellow = "\x1b[33m"
  const cyan = "\x1b[36m"
  const dim = "\x1b[2m"
  const reset = "\x1b[0m"

  console.log(`\n=== HTTP Security Headers ===`)
  console.log(`URL: ${url}`)
  console.log(`Status: ${headers["_statusCode"]}`)
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`)
  console.log()

  // Security headers
  console.log("Security Headers:")
  let passed = 0
  let failed = 0

  for (const r of results) {
    const icon = r.result.pass ? (r.result.warn ? `${yellow}\u26A0` : `${green}\u2713`) : `${red}\u2717`
    const severity = r.result.pass ? "" : ` [${r.def.severity}]`
    console.log(`  ${icon} ${r.def.name}${severity}${reset}`)
    console.log(`    ${dim}${r.result.note}${reset}`)
    if (r.result.pass) passed++
    else failed++
  }

  // Information leak headers
  console.log(`\nInformation Disclosure:`)
  for (const h of INFO_LEAK_HEADERS) {
    const val = headers[h.key]
    if (val) {
      console.log(`  ${yellow}\u26A0 ${h.name}: ${val}${reset}`)
      console.log(`    ${dim}${h.description}${reset}`)
    }
  }
  const leakCount = INFO_LEAK_HEADERS.filter(h => headers[h.key]).length
  if (leakCount === 0) {
    console.log(`  ${green}\u2713 No server information leaked${reset}`)
  }

  // Cookie analysis
  if (cookieResults.length > 0) {
    console.log(`\nCookie Security:`)
    for (const c of cookieResults) {
      if (c.cookie) {
        const icon = c.pass ? `${green}\u2713` : `${red}\u2717`
        console.log(`  ${icon} ${c.cookie}: ${c.note}${reset}`)
      } else {
        console.log(`  ${dim}${c.note}${reset}`)
      }
    }
  }

  // All raw headers (dimmed)
  console.log(`\n${dim}All Response Headers:${reset}`)
  for (const [key, val] of Object.entries(headers)) {
    if (key.startsWith("_")) continue
    console.log(`  ${dim}${key}: ${String(val).slice(0, 120)}${reset}`)
  }

  // Summary
  console.log()
  const score = Math.round((passed / (passed + failed)) * 100)
  const scoreColor = score >= 80 ? green : score >= 50 ? yellow : red
  console.log(`${scoreColor}Header Score: ${passed}/${passed + failed} (${score}%)${reset}`)
  console.log()
}

// ─── Main ───

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Header Check — HTTP security header analysis

Usage:
  node cli/header-check.mjs https://example.com
  node cli/header-check.mjs --relay              # check current tab's URL
  node cli/header-check.mjs --relay --tab 123     # check specific tab's URL
  node cli/header-check.mjs --json                # JSON output

Flags:
  --relay         Get URL from active browser tab via relay
  --tab <id>      Target a specific tab (relay mode)
  --port <num>    Override relay port
  --json          Output as JSON
  -h, --help      Show this help
`)
    process.exit(0)
  }

  // Resolve URL
  let url = positionalUrl
  if (useRelay && !url) {
    console.log("Getting URL from browser tab...")
    url = await getUrlFromRelay()
  }

  if (!url) {
    console.error("Error: Provide a URL or use --relay to get the current tab's URL")
    console.error("Usage: node cli/header-check.mjs https://example.com")
    process.exit(1)
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url
  }

  console.log(`Fetching headers: ${url}`)

  let headers
  try {
    headers = await fetchHeaders(url)
  } catch (err) {
    console.error(`Error fetching ${url}: ${err.message}`)
    process.exit(1)
  }

  // Run header checks
  const results = SECURITY_HEADERS.map((def) => ({
    def,
    result: def.check(headers[def.key], headers),
  }))

  // Cookie analysis
  const cookieResults = analyzeCookies(headers)

  if (jsonOutput) {
    const report = {
      url,
      status: headers["_statusCode"],
      date: new Date().toISOString(),
      headers: Object.fromEntries(
        Object.entries(headers).filter(([k]) => !k.startsWith("_"))
      ),
      securityHeaders: results.map((r) => ({
        name: r.def.name,
        key: r.def.key,
        severity: r.def.severity,
        present: !!headers[r.def.key],
        value: headers[r.def.key] || null,
        pass: r.result.pass,
        warn: r.result.warn || false,
        note: r.result.note,
      })),
      informationLeak: INFO_LEAK_HEADERS
        .filter((h) => headers[h.key])
        .map((h) => ({ name: h.name, value: headers[h.key] })),
      cookies: cookieResults,
      score: {
        passed: results.filter((r) => r.result.pass).length,
        total: results.length,
        percentage: Math.round(
          (results.filter((r) => r.result.pass).length / results.length) * 100
        ),
      },
    }
    console.log(JSON.stringify(report, null, 2))
  } else {
    printResults(url, headers, results, cookieResults)
  }

  // Exit code: 1 if critical/high headers missing
  const criticalMissing = results.some(
    (r) => !r.result.pass && (r.def.severity === "CRITICAL" || r.def.severity === "HIGH")
  )
  process.exit(criticalMissing ? 1 : 0)
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`)
  process.exit(2)
})

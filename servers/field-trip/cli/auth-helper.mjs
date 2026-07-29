#!/usr/bin/env node
/**
 * Auth Helper — handles login flows and 2FA challenges via CDP.
 *
 * Detects common auth pages (Google, GitHub, Microsoft, Stack Auth, etc.)
 * and walks through them with provided credentials or prompts for 2FA codes.
 *
 * Usage:
 *   node cli/auth-helper.mjs login <email> <password>     — type credentials into login form
 *   node cli/auth-helper.mjs 2fa <code>                   — enter a 2FA/MFA code
 *   node cli/auth-helper.mjs detect                        — detect if current page is an auth page
 *   node cli/auth-helper.mjs status                        — check login state (cookies, session)
 *   node cli/auth-helper.mjs wait-for-2fa                  — wait and scan until 2FA input appears
 */

import http from "http"

const PORT = parseInt(process.env.CDP_PORT || "9222")

// ─── CDP connection ───

async function connect() {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://"))
  if (!page) { console.error("No page tab found"); process.exit(1) }

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
      const timeout = setTimeout(() => reject(new Error("CDP timeout")), 15000)
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
      throw new Error(result.exceptionDetails.exception?.description || "eval failed")
    }
    return result.result?.value
  }

  return { ws, send, evaluate, page }
}

// ─── Auth detection patterns ───

const AUTH_PATTERNS = {
  google: {
    urlPatterns: ["accounts.google.com", "accounts.google.co"],
    emailSelector: 'input[type="email"]',
    passwordSelector: 'input[type="password"]',
    nextButton: '#identifierNext, button[type="submit"]',
    twoFaSelectors: ['input[name="totpPin"]', 'input[id="totpPin"]', 'input[type="tel"]'],
    name: "Google",
  },
  github: {
    urlPatterns: ["github.com/login", "github.com/sessions"],
    emailSelector: '#login_field',
    passwordSelector: '#password',
    nextButton: 'input[type="submit"], button[type="submit"]',
    twoFaSelectors: ['input[name="app_otp"]', '#app_totp', 'input[id="otp"]'],
    name: "GitHub",
  },
  microsoft: {
    urlPatterns: ["login.microsoftonline.com", "login.live.com"],
    emailSelector: 'input[type="email"], input[name="loginfmt"]',
    passwordSelector: 'input[type="password"], input[name="passwd"]',
    nextButton: 'input[type="submit"], button[type="submit"]',
    twoFaSelectors: ['input[name="otc"]', 'input[id="idTxtBx_SAOTCC_OTC"]'],
    name: "Microsoft",
  },
  stackAuth: {
    urlPatterns: ["stack-auth.com", "/handler/sign-in"],
    emailSelector: 'input[type="email"], input[name="email"]',
    passwordSelector: 'input[type="password"]',
    nextButton: 'button[type="submit"]',
    twoFaSelectors: ['input[name="code"]', 'input[type="tel"]'],
    name: "Stack Auth",
  },
  generic: {
    urlPatterns: [],
    emailSelector: 'input[type="email"], input[name="email"], input[name="username"], input[id="email"], input[id="username"]',
    passwordSelector: 'input[type="password"]',
    nextButton: 'button[type="submit"], input[type="submit"]',
    twoFaSelectors: ['input[name="code"]', 'input[name="otp"]', 'input[name="totp"]', 'input[type="tel"][maxlength="6"]', 'input[autocomplete="one-time-code"]'],
    name: "Unknown Provider",
  },
}

// ─── React-compatible typing ───

async function reactType(evaluate, selector, value) {
  return evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { success: false, error: 'not found: ' + ${JSON.stringify(selector)} };
      el.focus();
      el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, ${JSON.stringify(value)});
      } else {
        el.value = ${JSON.stringify(value)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Try React onChange
      try {
        const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps'));
        if (propsKey) {
          const props = el[propsKey];
          if (props?.value !== ${JSON.stringify(value)} && typeof props.onChange === 'function') {
            props.onChange({ target: el, currentTarget: el, type: 'change',
              preventDefault: () => {}, stopPropagation: () => {} });
          }
        }
      } catch(e) {}
      return { success: true, value: el.value };
    })()
  `)
}

async function clickButton(evaluate, selector) {
  return evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { success: false, error: 'not found' };
      el.click();
      return { success: true, text: el.textContent?.trim()?.slice(0, 60) };
    })()
  `)
}

// ─── Commands ───

async function detect(evaluate) {
  const url = await evaluate("location.href")
  const pageTitle = await evaluate("document.title")

  // Check URL against known auth providers
  for (const [key, pattern] of Object.entries(AUTH_PATTERNS)) {
    if (key === "generic") continue
    for (const urlPat of pattern.urlPatterns) {
      if (url.includes(urlPat)) {
        // Check which stage we're at
        const hasEmail = await evaluate(`!!document.querySelector(${JSON.stringify(pattern.emailSelector)})`)
        const hasPassword = await evaluate(`!!document.querySelector(${JSON.stringify(pattern.passwordSelector)})`)
        const has2fa = await evaluate(`
          (${JSON.stringify(pattern.twoFaSelectors)}).some(s => !!document.querySelector(s))
        `)

        const stage = has2fa ? "2FA_REQUIRED" : hasPassword ? "PASSWORD" : hasEmail ? "EMAIL" : "UNKNOWN"

        return {
          detected: true,
          provider: pattern.name,
          stage,
          url,
          title: pageTitle,
          hasEmail,
          hasPassword,
          has2fa,
        }
      }
    }
  }

  // Generic detection — look for login form elements
  const hasEmail = await evaluate(`!!document.querySelector('input[type="email"], input[name="email"], input[name="username"]')`)
  const hasPassword = await evaluate(`!!document.querySelector('input[type="password"]')`)
  const has2fa = await evaluate(`
    ['input[name="code"]', 'input[name="otp"]', 'input[name="totp"]', 'input[type="tel"][maxlength="6"]', 'input[autocomplete="one-time-code"]']
      .some(s => !!document.querySelector(s))
  `)

  if (hasEmail || hasPassword || has2fa) {
    const stage = has2fa ? "2FA_REQUIRED" : hasPassword ? "PASSWORD" : hasEmail ? "EMAIL" : "UNKNOWN"
    return { detected: true, provider: "Unknown", stage, url, title: pageTitle, hasEmail, hasPassword, has2fa }
  }

  return { detected: false, url, title: pageTitle }
}

async function login(evaluate, email, password) {
  const auth = await detect(evaluate)
  if (!auth.detected) {
    console.log("No login form detected on current page.")
    console.log(`URL: ${auth.url}`)
    console.log(`Title: ${auth.title}`)
    return
  }

  console.log(`Detected: ${auth.provider} (stage: ${auth.stage})`)

  const providerKey = Object.keys(AUTH_PATTERNS).find(k =>
    AUTH_PATTERNS[k].name === auth.provider
  ) || "generic"
  const pattern = AUTH_PATTERNS[providerKey]

  if (auth.stage === "EMAIL" || auth.stage === "PASSWORD") {
    if (auth.hasEmail && email) {
      console.log("Entering email...")
      const result = await reactType(evaluate, pattern.emailSelector, email)
      console.log(result.success ? `  Typed: ${email}` : `  Failed: ${result.error}`)

      if (!auth.hasPassword) {
        // Some providers split email/password into two steps
        console.log("Clicking next...")
        await clickButton(evaluate, pattern.nextButton)
        await new Promise(r => setTimeout(r, 3000))
      }
    }

    // Re-check for password field (may appear after email step)
    const hasPasswordNow = await evaluate(`!!document.querySelector(${JSON.stringify(pattern.passwordSelector)})`)
    if (hasPasswordNow && password) {
      console.log("Entering password...")
      const result = await reactType(evaluate, pattern.passwordSelector, password)
      console.log(result.success ? "  Password entered" : `  Failed: ${result.error}`)

      console.log("Submitting...")
      await clickButton(evaluate, pattern.nextButton)
      await new Promise(r => setTimeout(r, 3000))
    }

    // Check if 2FA is now required
    const postLogin = await detect(evaluate)
    if (postLogin.has2fa) {
      console.log("\n*** 2FA REQUIRED ***")
      console.log("Run: node cli/auth-helper.mjs 2fa <your-code>")
    } else if (postLogin.detected) {
      console.log(`Still on auth page (stage: ${postLogin.stage})`)
    } else {
      console.log("Login successful!")
    }
  } else if (auth.stage === "2FA_REQUIRED") {
    console.log("*** 2FA code needed. Run: node cli/auth-helper.mjs 2fa <code> ***")
  }
}

async function enter2fa(evaluate, code) {
  const auth = await detect(evaluate)
  if (!auth.has2fa) {
    console.log("No 2FA input detected on current page.")
    return
  }

  console.log(`Detected: ${auth.provider} — entering 2FA code...`)

  const providerKey = Object.keys(AUTH_PATTERNS).find(k =>
    AUTH_PATTERNS[k].name === auth.provider
  ) || "generic"
  const pattern = AUTH_PATTERNS[providerKey]

  // Try each 2FA selector
  for (const selector of pattern.twoFaSelectors) {
    const exists = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
    if (exists) {
      const result = await reactType(evaluate, selector, code)
      if (result.success) {
        console.log(`  Code entered into ${selector}`)

        // Look for submit button
        const submitResult = await clickButton(evaluate, pattern.nextButton)
        if (submitResult.success) {
          console.log(`  Clicked: ${submitResult.text}`)
        } else {
          // Try common 2FA submit buttons
          for (const btn of ['button[type="submit"]', '#totpNext', 'button:has-text("Verify")', 'button:has-text("Submit")']) {
            const r = await clickButton(evaluate, btn)
            if (r.success) { console.log(`  Clicked: ${r.text}`); break }
          }
        }

        await new Promise(r => setTimeout(r, 3000))
        const postAuth = await detect(evaluate)
        if (!postAuth.detected) {
          console.log("2FA successful! Logged in.")
        } else {
          console.log(`Still on auth page (stage: ${postAuth.stage})`)
        }
        return
      }
    }
  }

  console.log("Could not find 2FA input field.")
}

async function checkStatus(evaluate) {
  const result = await evaluate(`
    (() => {
      const cookies = document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
      const localStorage_keys = Object.keys(localStorage).filter(k =>
        k.includes('token') || k.includes('auth') || k.includes('session') || k.includes('user')
      );
      return {
        url: location.href,
        title: document.title,
        cookieCount: cookies.length,
        authCookies: cookies.filter(c =>
          c.includes('token') || c.includes('auth') || c.includes('session') || c.includes('sid')
        ),
        localStorageAuthKeys: localStorage_keys,
      };
    })()
  `)

  console.log(`URL: ${result.url}`)
  console.log(`Title: ${result.title}`)
  console.log(`Cookies: ${result.cookieCount} total`)
  if (result.authCookies.length) {
    console.log(`Auth cookies: ${result.authCookies.join(', ')}`)
  }
  if (result.localStorageAuthKeys.length) {
    console.log(`LocalStorage auth keys: ${result.localStorageAuthKeys.join(', ')}`)
  }
}

async function waitFor2fa(evaluate) {
  console.log("Waiting for 2FA input to appear...")
  const generic = AUTH_PATTERNS.generic
  for (let i = 0; i < 60; i++) {
    const has2fa = await evaluate(`
      ['input[name="code"]', 'input[name="otp"]', 'input[name="totp"]',
       'input[type="tel"][maxlength="6"]', 'input[autocomplete="one-time-code"]',
       'input[name="totpPin"]', 'input[name="app_otp"]', '#app_totp']
        .some(s => !!document.querySelector(s))
    `)
    if (has2fa) {
      console.log("2FA input detected!")
      const auth = await detect(evaluate)
      console.log(`Provider: ${auth.provider}`)
      console.log("Run: node cli/auth-helper.mjs 2fa <your-code>")
      return
    }
    await new Promise(r => setTimeout(r, 2000))
    if (i % 5 === 0) console.log(`  Still waiting... (${i * 2}s)`)
  }
  console.log("Timeout — no 2FA input appeared after 2 minutes.")
}

// ─── Main ───

const [,, cmd, ...args] = process.argv

if (!cmd || cmd === "help") {
  console.log(`
Auth Helper — handle login flows and 2FA via CDP

  node cli/auth-helper.mjs detect                  — detect auth page and stage
  node cli/auth-helper.mjs login <email> <password> — enter credentials
  node cli/auth-helper.mjs 2fa <code>              — enter 2FA/MFA code
  node cli/auth-helper.mjs status                  — check login state (cookies)
  node cli/auth-helper.mjs wait-for-2fa            — wait for 2FA input to appear

Environment:
  CDP_PORT=9222  (default)
  `)
  process.exit(0)
}

const { ws, evaluate } = await connect()

try {
  switch (cmd) {
    case "detect": {
      const result = await detect(evaluate)
      console.log(JSON.stringify(result, null, 2))
      break
    }
    case "login": {
      await login(evaluate, args[0], args[1])
      break
    }
    case "2fa": {
      await enter2fa(evaluate, args[0])
      break
    }
    case "status": {
      await checkStatus(evaluate)
      break
    }
    case "wait-for-2fa": {
      await waitFor2fa(evaluate)
      break
    }
    default:
      console.error(`Unknown command: ${cmd}`)
  }
} finally {
  ws.close()
}

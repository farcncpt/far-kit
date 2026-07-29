#!/usr/bin/env node
/**
 * Generate Spec — Creates a project spec template for the build loop.
 *
 * Three modes:
 *   1. From description — generates a spec template from a text description
 *   2. From site — crawls an existing site via CDP and extracts structure
 *   3. Interactive — prompts for pages and elements
 *
 * Usage:
 *   node cli/generate-spec.mjs --description "A portfolio website with home, about, projects, contact"
 *   CDP_PORT=9222 node cli/generate-spec.mjs --from-site --urls "http://localhost:3000,http://localhost:3000/about"
 *   node cli/generate-spec.mjs --interactive
 *   node cli/generate-spec.mjs --output my-spec.json --description "..."
 */

import http from "http"
import fs from "fs"
import path from "path"
import readline from "readline"

// ─── Parse flags ───

const rawArgs = process.argv.slice(2)

function getFlag(name) {
  const idx = rawArgs.indexOf(name)
  if (idx === -1) return null
  return rawArgs[idx + 1] || null
}

function hasFlag(name) {
  return rawArgs.includes(name)
}

const description = getFlag("--description")
const fromSite = hasFlag("--from-site")
const interactive = hasFlag("--interactive")
const urlsRaw = getFlag("--urls")
const outputPath = getFlag("--output") || getFlag("-o")
const CDP_PORT = parseInt(getFlag("--port") || process.env.CDP_PORT || "9222")

// ─── Usage ───

if ((!description && !fromSite && !interactive) || hasFlag("--help") || hasFlag("-h")) {
  console.log(`
Generate Spec — Create a project spec for the build loop

Usage:
  node cli/generate-spec.mjs --description "..." [--output spec.json]
  CDP_PORT=9222 node cli/generate-spec.mjs --from-site --urls "url1,url2" [--output spec.json]
  node cli/generate-spec.mjs --interactive [--output spec.json]

Modes:
  --description <text>    Generate spec from a text description of the project
  --from-site             Crawl an existing site via CDP to extract structure
  --interactive           Interactive mode: prompts for project details

Options:
  --urls <url1,url2,...>  URLs to crawl (required for --from-site)
  --output <path>         Output file path (default: stdout)
  --port <number>         CDP port for --from-site (default: 9222)

Examples:
  node cli/generate-spec.mjs --description "Portfolio with home, about, projects, contact. Dark theme."
  node cli/generate-spec.mjs --from-site --urls "http://example.com" --output spec.json
  node cli/generate-spec.mjs --interactive --output my-project.json
`)
  process.exit(0)
}

// ─── Common page patterns for description-based generation ───

const PAGE_TEMPLATES = {
  home: {
    name: "Home",
    path: "/",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Hero section", selector: "[class*='hero'], [class*='Hero'], section:first-of-type", required: true },
      { description: "Hero heading", selector: "h1, [class*='hero'] h1, [class*='Hero'] h1", required: true },
      { description: "CTA button", selector: "a[class*='btn'], a[class*='cta'], button[class*='cta'], a:has-text('Get Started'), a:has-text('Learn More')", required: true },
      { description: "Footer", selector: "footer, [class*='footer'], [role='contentinfo']", required: true },
    ],
    expectedText: [],
    expectedLinks: [],
  },
  about: {
    name: "About",
    path: "/about",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "About content", selector: "main p, [class*='about'] p, section p", required: true },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["About"],
    expectedLinks: ["/"],
  },
  contact: {
    name: "Contact",
    path: "/contact",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Contact form", selector: "form, [class*='contact'] form, [class*='Contact'] form", required: true },
      { description: "Name input", selector: "input[name='name'], input[placeholder*='name' i], input[type='text']", required: true },
      { description: "Email input", selector: "input[name='email'], input[type='email'], input[placeholder*='email' i]", required: true },
      { description: "Message textarea", selector: "textarea, textarea[name='message']", required: true },
      { description: "Submit button", selector: "button[type='submit'], input[type='submit'], button:has-text('Send'), button:has-text('Submit')", required: true },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Contact"],
    expectedLinks: ["/"],
  },
  projects: {
    name: "Projects",
    path: "/projects",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Project cards", selector: "[class*='card'], [class*='project'], article, [class*='grid'] > div", required: true },
      { description: "Project image or thumbnail", selector: "img, [class*='card'] img, picture", required: false },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Projects"],
    expectedLinks: ["/"],
  },
  portfolio: {
    name: "Portfolio",
    path: "/portfolio",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Portfolio grid", selector: "[class*='grid'], [class*='gallery'], [class*='portfolio']", required: true },
      { description: "Portfolio items", selector: "[class*='card'], article, [class*='item']", required: true },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Portfolio"],
    expectedLinks: ["/"],
  },
  services: {
    name: "Services",
    path: "/services",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Service cards or sections", selector: "[class*='card'], [class*='service'], article, section > div", required: true },
      { description: "Service description", selector: "p, [class*='service'] p", required: true },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Services"],
    expectedLinks: ["/"],
  },
  blog: {
    name: "Blog",
    path: "/blog",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Blog post list", selector: "[class*='post'], article, [class*='blog'] > div", required: true },
      { description: "Post title links", selector: "article a, [class*='post'] a h2, [class*='post'] a h3, h2 a, h3 a", required: true },
      { description: "Post date or metadata", selector: "time, [class*='date'], [class*='meta'], [datetime]", required: false },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Blog"],
    expectedLinks: ["/"],
  },
  pricing: {
    name: "Pricing",
    path: "/pricing",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Pricing cards", selector: "[class*='pricing'], [class*='plan'], [class*='card']", required: true },
      { description: "Price amount", selector: "[class*='price'], [class*='amount']", required: true },
      { description: "Plan features list", selector: "ul, [class*='features'], [class*='plan'] li", required: true },
      { description: "CTA button", selector: "a[class*='btn'], button, a:has-text('Sign Up'), a:has-text('Get Started')", required: true },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Pricing"],
    expectedLinks: ["/"],
  },
  features: {
    name: "Features",
    path: "/#features",
    expectedElements: [
      { description: "Features section", selector: "[class*='features'], [id='features'], section:has-text('Features')", required: true },
      { description: "Feature cards", selector: "[class*='feature'] [class*='card'], [class*='features'] > div > div, [class*='grid'] > div", required: true },
      { description: "Feature icons or images", selector: "svg, [class*='icon'], [class*='feature'] img", required: false },
      { description: "Feature descriptions", selector: "[class*='feature'] p, [class*='features'] p", required: true },
    ],
    expectedText: ["Features"],
    expectedLinks: [],
  },
  categories: {
    name: "Categories",
    path: "/categories",
    expectedElements: [
      { description: "Navigation bar", selector: "nav, header nav, [role='navigation']", required: true },
      { description: "Page heading", selector: "h1", required: true },
      { description: "Category list", selector: "[class*='categor'], [class*='tag'], ul li a, [class*='grid'] > div", required: true },
      { description: "Category links", selector: "a[href*='categor'], a[href*='tag'], [class*='categor'] a", required: true },
      { description: "Footer", selector: "footer, [class*='footer']", required: true },
    ],
    expectedText: ["Categories"],
    expectedLinks: ["/blog"],
  },
}

// ─── Description-based generation ───

function generateFromDescription(desc) {
  const lower = desc.toLowerCase()

  // Extract project name
  let name = "Website"
  const namePatterns = [
    /(?:a|an|the)\s+(.+?)(?:\s+(?:website|site|app|page|landing))/i,
    /^(.+?)(?:\s+(?:website|site|app|page|landing))/i,
  ]
  for (const pat of namePatterns) {
    const m = desc.match(pat)
    if (m) {
      name = m[1].trim()
      // Capitalize
      name = name.charAt(0).toUpperCase() + name.slice(1)
      break
    }
  }

  // Detect pages from description
  const detectedPages = []
  const allPageNames = Object.keys(PAGE_TEMPLATES)

  for (const pageName of allPageNames) {
    if (lower.includes(pageName)) {
      detectedPages.push(pageName)
    }
  }

  // Always include home if not explicitly mentioned but we have other pages
  if (!detectedPages.includes("home") && detectedPages.length > 0) {
    detectedPages.unshift("home")
  }

  // If nothing detected, create a basic site
  if (detectedPages.length === 0) {
    detectedPages.push("home")
  }

  // Build pages from templates
  const pages = detectedPages.map((pageName) => {
    const template = { ...PAGE_TEMPLATES[pageName] }
    template.expectedElements = template.expectedElements.map((e) => ({ ...e }))

    // Cross-link: add links to other pages
    const otherPaths = detectedPages
      .filter((p) => p !== pageName)
      .map((p) => PAGE_TEMPLATES[p].path)
      .filter((p) => !p.startsWith("/#")) // skip hash links
    template.expectedLinks = [...new Set([...template.expectedLinks, ...otherPaths])]

    // Add text references from other pages
    const otherNames = detectedPages
      .filter((p) => p !== pageName && p !== "home")
      .map((p) => PAGE_TEMPLATES[p].name)
    template.expectedText = [...new Set([...template.expectedText, ...otherNames])]

    return template
  })

  const spec = {
    name,
    baseUrl: "http://localhost:3000",
    description: desc,
    pages,
  }

  // Add design hints if mentioned
  const designHints = {}
  if (lower.includes("dark")) designHints.theme = "dark"
  if (lower.includes("light")) designHints.theme = "light"
  if (lower.includes("modern")) designHints.style = "modern"
  if (lower.includes("minimal")) designHints.style = "minimal"
  if (lower.includes("bold")) designHints.style = "bold"
  if (Object.keys(designHints).length > 0) spec.design = designHints

  return spec
}

// ─── Site-based generation (via CDP) ───

async function generateFromSite(urls) {
  const targets = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = ""
      res.on("data", (c) => (data += c))
      res.on("end", () => resolve(JSON.parse(data)))
    }).on("error", reject)
  })

  const tab = targets.find(
    (t) => t.type === "page" && !t.url.startsWith("chrome://") && !t.url.startsWith("devtools://")
  )
  if (!tab) {
    console.error("No page tab found in CDP")
    process.exit(1)
  }

  const { WebSocket } = await import("ws")
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false })
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

  async function navigate(url) {
    await send("Page.enable")
    await send("Page.navigate", { url })
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 10000)
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.method === "Page.loadEventFired") {
          ws.off("message", handler)
          clearTimeout(timeout)
          resolve()
        }
      }
      ws.on("message", handler)
    })
    await new Promise((r) => setTimeout(r, 2000))
  }

  const pages = []

  for (const url of urls) {
    console.error(`Scanning ${url}...`)
    await navigate(url)

    const pageData = await evaluate(`
      (() => {
        const u = new URL(location.href);
        const path = u.pathname;
        const title = document.title;

        // Detect major structural elements
        const elements = [];
        const checks = [
          { desc: 'Navigation bar', sel: 'nav, header nav, [role="navigation"]' },
          { desc: 'Header', sel: 'header' },
          { desc: 'Main content', sel: 'main, [role="main"]' },
          { desc: 'Footer', sel: 'footer, [role="contentinfo"]' },
          { desc: 'Hero section', sel: '[class*="hero"], [class*="Hero"]' },
          { desc: 'Sidebar', sel: 'aside, [class*="sidebar"]' },
          { desc: 'Search', sel: 'input[type="search"], [class*="search"]' },
        ];

        for (const c of checks) {
          const el = document.querySelector(c.sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            elements.push({
              description: c.desc,
              selector: c.sel,
              required: true,
              tag: el.tagName.toLowerCase(),
              childCount: el.children.length,
            });
          }
        }

        // Get all headings
        const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({
          description: h.tagName.toLowerCase() + ' heading: ' + h.textContent.trim().slice(0, 80),
          selector: h.id ? '#' + h.id : h.tagName.toLowerCase(),
          required: h.tagName === 'H1',
        }));

        // Get forms
        const forms = Array.from(document.querySelectorAll('form')).map((f, i) => ({
          description: 'Form ' + (i + 1),
          selector: f.id ? '#' + f.id : 'form:nth-of-type(' + (i + 1) + ')',
          required: false,
        }));

        // Get visible text snippets for text checks
        const bodyText = document.body.innerText || '';
        const words = bodyText.split(/\\s+/).filter(w => w.length > 4);
        const unique = [...new Set(words.slice(0, 20))].slice(0, 5);

        // Get internal links
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => {
            try { return new URL(a.href); } catch { return null; }
          })
          .filter(u => u && u.origin === location.origin)
          .map(u => u.pathname);
        const uniqueLinks = [...new Set(links)].filter(l => l !== path).slice(0, 10);

        // Derive page name from title or h1
        const h1 = document.querySelector('h1');
        const name = h1 ? h1.textContent.trim().slice(0, 50) : title.split(/[|\\-]/)[0].trim();

        return {
          name: name || 'Page',
          path,
          title,
          elements: [...elements, ...headings, ...forms],
          expectedText: unique,
          expectedLinks: uniqueLinks,
        };
      })()
    `)

    pages.push({
      name: pageData.name,
      path: pageData.path,
      expectedElements: pageData.elements,
      expectedText: pageData.expectedText,
      expectedLinks: pageData.expectedLinks,
    })
  }

  ws.close()

  // Derive base URL from first URL
  const firstUrl = new URL(urls[0])
  const baseUrl = `${firstUrl.protocol}//${firstUrl.host}`

  return {
    name: pages[0]?.name || "Website",
    baseUrl,
    pages,
  }
}

// ─── Interactive mode ───

async function generateInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve))

  console.error("\n=== Build Loop Spec Generator (Interactive) ===\n")

  const name = (await ask("Project name: ")) || "Website"
  const baseUrl = (await ask("Base URL (default: http://localhost:3000): ")) || "http://localhost:3000"

  const pages = []
  let addMore = true

  while (addMore) {
    console.error(`\n--- Page ${pages.length + 1} ---`)
    const pageName = await ask("Page name (e.g., Home, About): ")
    if (!pageName) break

    const pagePath = (await ask(`Path (default: /${pageName.toLowerCase()}): `)) || `/${pageName.toLowerCase()}`

    // Check if we have a template
    const templateKey = pageName.toLowerCase()
    if (PAGE_TEMPLATES[templateKey]) {
      const useTemplate = await ask(`Use ${templateKey} template? (Y/n): `)
      if (!useTemplate || useTemplate.toLowerCase() === "y") {
        const template = { ...PAGE_TEMPLATES[templateKey] }
        template.path = pagePath
        template.name = pageName
        template.expectedElements = template.expectedElements.map((e) => ({ ...e }))
        pages.push(template)
        const more = await ask("\nAdd another page? (Y/n): ")
        addMore = !more || more.toLowerCase() === "y"
        continue
      }
    }

    // Manual element entry
    const elements = []
    console.error("  Add expected elements (empty description to stop):")
    while (true) {
      const desc = await ask("    Description: ")
      if (!desc) break
      const sel = await ask("    CSS selector: ")
      if (!sel) break
      const req = await ask("    Required? (Y/n): ")
      elements.push({
        description: desc,
        selector: sel,
        required: !req || req.toLowerCase() === "y",
      })
    }

    const textInput = await ask("  Expected text (comma-separated, or empty): ")
    const expectedText = textInput ? textInput.split(",").map((t) => t.trim()) : []

    const linksInput = await ask("  Expected links (comma-separated paths, or empty): ")
    const expectedLinks = linksInput ? linksInput.split(",").map((l) => l.trim()) : []

    pages.push({
      name: pageName,
      path: pagePath,
      expectedElements: elements,
      expectedText,
      expectedLinks,
    })

    const more = await ask("\nAdd another page? (Y/n): ")
    addMore = !more || more.toLowerCase() === "y"
  }

  rl.close()

  return {
    name,
    baseUrl,
    pages,
  }
}

// ─── Output ───

function outputSpec(spec) {
  const json = JSON.stringify(spec, null, 2)

  if (outputPath) {
    const resolved = path.resolve(outputPath)
    fs.writeFileSync(resolved, json)
    console.error(`\nSpec written to ${resolved}`)
    console.error(`Pages: ${spec.pages.map((p) => p.name).join(", ")}`)
    console.error(`\nRun the build loop:`)
    console.error(`  CDP_PORT=9222 node cli/build-loop.mjs --spec ${outputPath} --fix-report`)
  } else {
    console.log(json)
  }
}

// ─── Main ───

async function main() {
  let spec

  if (description) {
    spec = generateFromDescription(description)
  } else if (fromSite) {
    if (!urlsRaw) {
      console.error("Error: --urls is required for --from-site mode")
      process.exit(1)
    }
    const urls = urlsRaw.split(",").map((u) => u.trim())
    spec = await generateFromSite(urls)
  } else if (interactive) {
    spec = await generateInteractive()
  }

  outputSpec(spec)
}

main().catch((e) => {
  console.error(`Error: ${e.message}`)
  process.exit(1)
})

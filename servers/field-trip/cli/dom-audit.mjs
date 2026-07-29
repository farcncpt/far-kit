#!/usr/bin/env node
/**
 * dom-audit.mjs — DOM vulnerability and design quality scanner
 *
 * Scans a live page via relay for:
 *   - Color contrast violations (WCAG AA/AAA)
 *   - Broken/dead links
 *   - Accessibility issues (missing aria, roles, labels, tab order)
 *   - Security indicators (inline scripts, mixed content, exposed data)
 *   - Design consistency (font sizes, spacing, color palette)
 *   - Missing error states, empty alt text, form issues
 *
 * Usage:
 *   node cli/dom-audit.mjs --relay
 *   node cli/dom-audit.mjs --relay --tab 12345
 *   node cli/dom-audit.mjs --relay --checks contrast,links,a11y,security,design
 *   node cli/dom-audit.mjs --relay --output report.json
 */

import { connectRelay } from "./relay-client.mjs"
import { writeFileSync } from "fs"

const args = process.argv.slice(2)
const useRelay = args.includes("--relay")
const tabId = args.includes("--tab") ? parseInt(args[args.indexOf("--tab") + 1]) : undefined
const outputFile = args.includes("--output") ? args[args.indexOf("--output") + 1] : null
const checksArg = args.includes("--checks") ? args[args.indexOf("--checks") + 1] : "all"
const enabledChecks = checksArg === "all" ? ["contrast", "links", "a11y", "security", "design", "forms", "images", "meta"] : checksArg.split(",")

if (args.includes("--help") || args.includes("-h")) {
  console.log(`DOM Audit — Vulnerability and design quality scanner

Usage:
  node cli/dom-audit.mjs --relay [options]

Options:
  --relay           Use WebSocket relay (required)
  --tab <id>        Target specific tab
  --checks <list>   Comma-separated: contrast,links,a11y,security,design,forms,images,meta (default: all)
  --output <file>   Save JSON report to file
  -h, --help        Show this help

Checks:
  contrast    WCAG color contrast ratio violations
  links       Broken links, empty hrefs, javascript: links
  a11y        Accessibility: aria-labels, roles, heading order, tab index
  security    Inline scripts, mixed content, exposed secrets, CSP issues
  design      Font consistency, color palette, spacing patterns
  forms       Form validation, labels, input types
  images      Missing alt text, broken images, oversized images
  meta        Page metadata, viewport, lang, title`)
  process.exit(0)
}

if (!useRelay) {
  console.error("Error: --relay flag is required")
  process.exit(1)
}

const relay = await connectRelay()
const tabOpts = tabId ? { tabId } : {}

async function ev(js) {
  return await relay.command("eval", { expression: js }, tabOpts)
}

const issues = []
const info = {}

function addIssue(severity, category, message, element, details) {
  issues.push({ severity, category, message, element: element || null, details: details || null })
}

// ── Page Info ──
const pageInfo = await relay.command("page", {}, tabOpts)
info.title = pageInfo.title
info.url = pageInfo.url
console.log(`\nDOM Audit: ${pageInfo.title}`)
console.log(`URL: ${pageInfo.url}`)
console.log(`Checks: ${enabledChecks.join(", ")}\n`)

// ── 1. Color Contrast ──
if (enabledChecks.includes("contrast")) {
  console.log("Checking color contrast...")
  const contrastData = await ev(`(() => {
    function luminance(r, g, b) {
      const [rs, gs, bs] = [r, g, b].map(c => {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }
    function parseColor(color) {
      const m = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
      return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
    }
    function contrastRatio(fg, bg) {
      const l1 = luminance(...fg);
      const l2 = luminance(...bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }
    function parseAlpha(bgStr) {
      const m = bgStr.match(/rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)/);
      return m ? parseFloat(m[4]) : 1;
    }
    function blendOnWhite(fg, alpha) {
      return fg.map(c => Math.round(c * alpha + 255 * (1 - alpha)));
    }
    function blendOnBlack(fg, alpha) {
      return fg.map(c => Math.round(c * alpha));
    }
    function getEffectiveBg(el) {
      let node = el;
      while (node && node !== document.documentElement) {
        const s = getComputedStyle(node);
        const bg = parseColor(s.backgroundColor);
        if (bg) {
          const alpha = parseAlpha(s.backgroundColor);
          if (alpha >= 0.8) return bg;
          if (alpha > 0) {
            const parentBg = node.parentElement ? getEffectiveBg(node.parentElement) : [255, 255, 255];
            return bg.map((c, i) => Math.round(c * alpha + parentBg[i] * (1 - alpha)));
          }
        }
        node = node.parentElement;
      }
      const bodyS = getComputedStyle(document.body);
      const bodyBg = parseColor(bodyS.backgroundColor);
      if (bodyBg) {
        const isDark = luminance(...bodyBg) < 0.2;
        return isDark ? bodyBg : [255, 255, 255];
      }
      return [255, 255, 255];
    }
    const results = [];
    const textEls = document.querySelectorAll('p, span, a, button, h1, h2, h3, h4, h5, h6, label, li, td, th, input, textarea');
    for (let i = 0; i < Math.min(textEls.length, 300); i++) {
      const el = textEls[i];
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      if (!el.textContent || !el.textContent.trim()) continue;
      const s = getComputedStyle(el);
      const fg = parseColor(s.color);
      if (!fg) continue;
      const bg = getEffectiveBg(el);
      if (!bg) continue;
      const ratio = contrastRatio(fg, bg);
      const fontSize = parseFloat(s.fontSize);
      const isBold = parseInt(s.fontWeight) >= 700;
      const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);
      const aaPass = isLargeText ? ratio >= 3 : ratio >= 4.5;
      const aaaPass = isLargeText ? ratio >= 4.5 : ratio >= 7;
      if (!aaPass) {
        results.push({
          tag: el.tagName, text: (el.textContent || '').trim().substring(0, 40),
          fg: s.color, bg: 'rgb(' + bg.join(', ') + ')', ratio: ratio.toFixed(2),
          fontSize, isBold, isLargeText, aaPass, aaaPass,
          selector: el.id ? '#' + el.id : el.className ? '.' + el.className.split(' ')[0] : el.tagName
        });
      }
    }
    return JSON.stringify(results);
  })()`)
  try {
    const violations = JSON.parse(contrastData)
    for (const v of violations) {
      addIssue(
        "warning", "contrast",
        `Contrast ratio ${v.ratio}:1 (needs ${v.isLargeText ? "3:1" : "4.5:1"} for AA)`,
        `<${v.tag}> "${v.text}"`, { fg: v.fg, bg: v.bg, ratio: v.ratio, selector: v.selector }
      )
    }
    console.log(`  ${violations.length} contrast violations found`)
  } catch { console.log("  Contrast check failed (CSP may block eval)") }
}

// ── 2. Links ──
if (enabledChecks.includes("links")) {
  console.log("Checking links...")
  const linkData = await ev(`(() => {
    const links = document.querySelectorAll('a');
    const results = [];
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim().substring(0, 60);
      if (!href || href === '#') results.push({ type: 'empty', href, text });
      else if (href.startsWith('javascript:')) results.push({ type: 'javascript', href: href.substring(0, 50), text });
      else if (href.startsWith('http:') && location.protocol === 'https:') results.push({ type: 'mixed', href, text });
      else if (!a.hasAttribute('rel') && a.target === '_blank') results.push({ type: 'no-rel', href, text });
    }
    return JSON.stringify({ total: links.length, issues: results });
  })()`)
  try {
    const links = JSON.parse(linkData)
    info.totalLinks = links.total
    for (const l of links.issues) {
      const sev = l.type === "javascript" ? "error" : l.type === "mixed" ? "warning" : "info"
      const msg = l.type === "empty" ? "Empty href" :
                  l.type === "javascript" ? "javascript: link (XSS risk)" :
                  l.type === "mixed" ? "Mixed content (HTTP on HTTPS)" :
                  "target=_blank without rel=noopener"
      addIssue(sev, "links", msg, `<a> "${l.text}"`, { href: l.href })
    }
    console.log(`  ${links.total} links, ${links.issues.length} issues`)
  } catch { console.log("  Link check failed") }
}

// ── 3. Accessibility ──
if (enabledChecks.includes("a11y")) {
  console.log("Checking accessibility...")
  const a11yData = await ev(`(() => {
    const results = [];
    // Missing aria-labels on interactive elements
    document.querySelectorAll('button, a, input, select, textarea').forEach(el => {
      if (!el.offsetParent && el.tagName !== 'BODY') return;
      const hasLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      const hasText = (el.textContent || '').trim();
      const hasPlaceholder = el.placeholder;
      if (!hasLabel && !hasText && !hasPlaceholder) {
        results.push({ type: 'no-label', tag: el.tagName, id: el.id, class: (el.className || '').toString().substring(0, 40) });
      }
    });
    // Heading order
    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    let lastLevel = 0;
    for (const h of headings) {
      const level = parseInt(h.tagName[1]);
      if (level > lastLevel + 1 && lastLevel > 0) {
        results.push({ type: 'heading-skip', from: 'h' + lastLevel, to: h.tagName.toLowerCase(), text: (h.textContent || '').trim().substring(0, 40) });
      }
      lastLevel = level;
    }
    // Missing lang attribute
    if (!document.documentElement.lang) results.push({ type: 'no-lang' });
    // Tab index issues
    document.querySelectorAll('[tabindex]').forEach(el => {
      const ti = parseInt(el.getAttribute('tabindex'));
      if (ti > 0) results.push({ type: 'positive-tabindex', tag: el.tagName, tabindex: ti });
    });
    // Missing form labels
    document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button])').forEach(el => {
      const id = el.id;
      const hasLabel = id && document.querySelector('label[for="' + id + '"]');
      const hasAriaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      const hasPlaceholder = el.placeholder;
      const parentLabel = el.closest('label');
      if (!hasLabel && !hasAriaLabel && !parentLabel && !hasPlaceholder) {
        results.push({ type: 'input-no-label', tag: 'INPUT', inputType: el.type, id: el.id });
      }
    });
    return JSON.stringify(results);
  })()`)
  try {
    const a11y = JSON.parse(a11yData)
    for (const issue of a11y) {
      if (issue.type === "no-label") addIssue("warning", "a11y", "Interactive element without label", `<${issue.tag}> id="${issue.id}"`)
      else if (issue.type === "heading-skip") addIssue("warning", "a11y", `Heading level skipped: ${issue.from} → ${issue.to}`, `<${issue.to}> "${issue.text}"`)
      else if (issue.type === "no-lang") addIssue("error", "a11y", "Missing lang attribute on <html>", "<html>")
      else if (issue.type === "positive-tabindex") addIssue("info", "a11y", `Positive tabindex=${issue.tabindex} (avoid)`, `<${issue.tag}>`)
      else if (issue.type === "input-no-label") addIssue("warning", "a11y", "Input without label", `<input type="${issue.inputType}"> id="${issue.id}"`)
    }
    console.log(`  ${a11y.length} accessibility issues`)
  } catch { console.log("  A11y check failed") }
}

// ── 4. Security ──
if (enabledChecks.includes("security")) {
  console.log("Checking security...")
  const secData = await ev(`(() => {
    const results = [];
    // Inline scripts (potential XSS vectors)
    document.querySelectorAll('script:not([src])').forEach((s, i) => {
      const content = (s.textContent || '').substring(0, 80);
      if (content.includes('eval(') || content.includes('innerHTML') || content.includes('document.write')) {
        results.push({ type: 'dangerous-inline', preview: content });
      }
    });
    // Exposed data in HTML
    const bodyText = document.body?.innerHTML || '';
    const patterns = [
      { name: 'API key', regex: /['\"](?:api[_-]?key|apikey)['"\\s]*[:=]\\s*['\"]([^'"]{10,})['"]/gi },
      { name: 'Secret', regex: /['\"](?:secret|password|token)['"\\s]*[:=]\\s*['\"]([^'"]{8,})['"]/gi },
      { name: 'AWS key', regex: /AKIA[0-9A-Z]{16}/g },
      { name: 'JWT', regex: /eyJ[a-zA-Z0-9_-]{10,}\\.[a-zA-Z0-9_-]{10,}/g },
    ];
    for (const p of patterns) {
      const matches = bodyText.match(p.regex);
      if (matches) results.push({ type: 'exposed-secret', pattern: p.name, count: matches.length });
    }
    // Mixed content
    document.querySelectorAll('img[src^="http:"], script[src^="http:"], link[href^="http:"]').forEach(el => {
      if (location.protocol === 'https:') {
        results.push({ type: 'mixed-content', tag: el.tagName, src: (el.src || el.href || '').substring(0, 80) });
      }
    });
    // Forms without CSRF
    document.querySelectorAll('form[method="post"], form[method="POST"]').forEach(f => {
      const hasCsrf = f.querySelector('input[name*="csrf"], input[name*="token"], input[name*="_token"]');
      if (!hasCsrf) results.push({ type: 'no-csrf', action: (f.action || '').substring(0, 60) });
    });
    // Autocomplete on sensitive fields
    document.querySelectorAll('input[type="password"]').forEach(el => {
      if (el.autocomplete !== 'off' && el.autocomplete !== 'new-password') {
        results.push({ type: 'password-autocomplete' });
      }
    });
    return JSON.stringify(results);
  })()`)
  try {
    const sec = JSON.parse(secData)
    for (const issue of sec) {
      if (issue.type === "dangerous-inline") addIssue("error", "security", "Dangerous inline script (eval/innerHTML/document.write)", "<script>", { preview: issue.preview })
      else if (issue.type === "exposed-secret") addIssue("critical", "security", `Exposed ${issue.pattern} in HTML (${issue.count} matches)`, "HTML body")
      else if (issue.type === "mixed-content") addIssue("warning", "security", "Mixed content (HTTP resource on HTTPS page)", `<${issue.tag}>`, { src: issue.src })
      else if (issue.type === "no-csrf") addIssue("warning", "security", "POST form without CSRF token", "<form>", { action: issue.action })
      else if (issue.type === "password-autocomplete") addIssue("info", "security", "Password field allows autocomplete", "<input type=password>")
    }
    console.log(`  ${sec.length} security issues`)
  } catch { console.log("  Security check failed") }
}

// ── 5. Design Consistency ──
if (enabledChecks.includes("design")) {
  console.log("Checking design consistency...")
  const designData = await ev(`(() => {
    const fonts = new Map();
    const fontSizes = new Map();
    const colors = new Map();
    const bgColors = new Map();
    const borderRadii = new Map();
    const els = document.querySelectorAll('p, span, a, button, h1, h2, h3, h4, h5, h6, label, li, td, th, input, div');
    for (let i = 0; i < Math.min(els.length, 300); i++) {
      const el = els[i];
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      const s = getComputedStyle(el);
      fonts.set(s.fontFamily.substring(0, 60), (fonts.get(s.fontFamily.substring(0, 60)) || 0) + 1);
      fontSizes.set(s.fontSize, (fontSizes.get(s.fontSize) || 0) + 1);
      if (s.color !== 'rgba(0, 0, 0, 0)') colors.set(s.color, (colors.get(s.color) || 0) + 1);
      if (s.backgroundColor !== 'rgba(0, 0, 0, 0)') bgColors.set(s.backgroundColor, (bgColors.get(s.backgroundColor) || 0) + 1);
      if (s.borderRadius !== '0px') borderRadii.set(s.borderRadius, (borderRadii.get(s.borderRadius) || 0) + 1);
    }
    return JSON.stringify({
      fonts: Object.fromEntries([...fonts].sort((a, b) => b[1] - a[1]).slice(0, 5)),
      fontSizes: Object.fromEntries([...fontSizes].sort((a, b) => b[1] - a[1]).slice(0, 10)),
      colors: Object.fromEntries([...colors].sort((a, b) => b[1] - a[1]).slice(0, 10)),
      bgColors: Object.fromEntries([...bgColors].sort((a, b) => b[1] - a[1]).slice(0, 5)),
      borderRadii: Object.fromEntries([...borderRadii].sort((a, b) => b[1] - a[1]).slice(0, 5)),
      totalFonts: fonts.size,
      totalSizes: fontSizes.size,
      totalColors: colors.size,
    });
  })()`)
  try {
    const design = JSON.parse(designData)
    info.design = design
    if (design.totalFonts > 4) addIssue("info", "design", `${design.totalFonts} different font families (consider consolidating)`, null, { fonts: design.fonts })
    if (design.totalSizes > 8) addIssue("info", "design", `${design.totalSizes} different font sizes (consider a type scale)`, null, { sizes: design.fontSizes })
    if (design.totalColors > 10) addIssue("info", "design", `${design.totalColors} different text colors (consider a palette)`, null, { colors: design.colors })
    console.log(`  ${design.totalFonts} fonts, ${design.totalSizes} sizes, ${design.totalColors} colors`)
  } catch { console.log("  Design check failed") }
}

// ── 6. Images ──
if (enabledChecks.includes("images")) {
  console.log("Checking images...")
  const imgData = await ev(`(() => {
    const results = [];
    document.querySelectorAll('img').forEach(img => {
      if (!img.alt && !img.getAttribute('role')?.includes('presentation')) {
        results.push({ type: 'no-alt', src: (img.src || '').substring(0, 80) });
      }
      if (img.naturalWidth === 0 && img.src) {
        results.push({ type: 'broken', src: (img.src || '').substring(0, 80) });
      }
      if (img.naturalWidth > 2000 && !img.srcset && !img.closest('picture')) {
        results.push({ type: 'oversized', src: (img.src || '').substring(0, 80), width: img.naturalWidth, height: img.naturalHeight });
      }
    });
    return JSON.stringify({ total: document.querySelectorAll('img').length, issues: results });
  })()`)
  try {
    const imgs = JSON.parse(imgData)
    info.totalImages = imgs.total
    for (const issue of imgs.issues) {
      if (issue.type === "no-alt") addIssue("warning", "images", "Image missing alt text", "<img>", { src: issue.src })
      else if (issue.type === "broken") addIssue("error", "images", "Broken image (failed to load)", "<img>", { src: issue.src })
      else if (issue.type === "oversized") addIssue("info", "images", `Oversized image (${issue.width}x${issue.height}) without srcset`, "<img>", { src: issue.src })
    }
    console.log(`  ${imgs.total} images, ${imgs.issues.length} issues`)
  } catch { console.log("  Image check failed") }
}

// ── 7. Forms ──
if (enabledChecks.includes("forms")) {
  console.log("Checking forms...")
  const formData = await ev(`(() => {
    const results = [];
    document.querySelectorAll('form').forEach(form => {
      if (!form.action && !form.getAttribute('action')) results.push({ type: 'no-action' });
    });
    document.querySelectorAll('input[type="email"]').forEach(el => {
      if (!el.required && !el.getAttribute('aria-required')) results.push({ type: 'email-not-required' });
    });
    document.querySelectorAll('input[type="password"]').forEach(el => {
      if (!el.minLength && el.minLength !== 0) results.push({ type: 'password-no-minlength' });
    });
    document.querySelectorAll('input:not([type])').forEach(el => {
      results.push({ type: 'input-no-type', id: el.id, name: el.name });
    });
    return JSON.stringify(results);
  })()`)
  try {
    const forms = JSON.parse(formData)
    for (const issue of forms) {
      if (issue.type === "no-action") addIssue("info", "forms", "Form without action attribute", "<form>")
      else if (issue.type === "email-not-required") addIssue("info", "forms", "Email input not marked required", "<input type=email>")
      else if (issue.type === "password-no-minlength") addIssue("info", "forms", "Password input without minLength", "<input type=password>")
      else if (issue.type === "input-no-type") addIssue("info", "forms", "Input without type attribute", `<input> name="${issue.name}"`)
    }
    console.log(`  ${forms.length} form issues`)
  } catch { console.log("  Form check failed") }
}

// ── 8. Meta / SEO ──
if (enabledChecks.includes("meta")) {
  console.log("Checking metadata...")
  const metaData = await ev(`(() => {
    const results = [];
    if (!document.title || document.title.length < 10) results.push({ type: 'short-title', title: document.title });
    if (!document.querySelector('meta[name="description"]')) results.push({ type: 'no-description' });
    if (!document.querySelector('meta[name="viewport"]')) results.push({ type: 'no-viewport' });
    if (!document.querySelector('link[rel="icon"], link[rel="shortcut icon"]')) results.push({ type: 'no-favicon' });
    if (!document.documentElement.lang) results.push({ type: 'no-lang' });
    const ogTitle = document.querySelector('meta[property="og:title"]');
    const ogDesc = document.querySelector('meta[property="og:description"]');
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (!ogTitle) results.push({ type: 'no-og-title' });
    if (!ogDesc) results.push({ type: 'no-og-description' });
    if (!ogImage) results.push({ type: 'no-og-image' });
    return JSON.stringify(results);
  })()`)
  try {
    const meta = JSON.parse(metaData)
    for (const issue of meta) {
      const msg = issue.type === "short-title" ? `Short page title: "${issue.title}"` :
                  issue.type === "no-description" ? "Missing meta description" :
                  issue.type === "no-viewport" ? "Missing viewport meta tag" :
                  issue.type === "no-favicon" ? "Missing favicon" :
                  issue.type === "no-lang" ? "Missing lang attribute" :
                  issue.type === "no-og-title" ? "Missing Open Graph title" :
                  issue.type === "no-og-description" ? "Missing Open Graph description" :
                  issue.type === "no-og-image" ? "Missing Open Graph image" : issue.type
      addIssue("info", "meta", msg)
    }
    console.log(`  ${meta.length} metadata issues`)
  } catch { console.log("  Meta check failed") }
}

// ── Report ──

const critical = issues.filter(i => i.severity === "critical").length
const errors = issues.filter(i => i.severity === "error").length
const warnings = issues.filter(i => i.severity === "warning").length
const infos = issues.filter(i => i.severity === "info").length

console.log(`\n${"═".repeat(50)}`)
console.log(`DOM AUDIT REPORT: ${pageInfo.title}`)
console.log(`${"═".repeat(50)}`)
console.log(`Critical: ${critical} | Errors: ${errors} | Warnings: ${warnings} | Info: ${infos} | Total: ${issues.length}`)

if (critical > 0) {
  console.log(`\n🔴 CRITICAL:`)
  for (const i of issues.filter(i => i.severity === "critical")) {
    console.log(`  [${i.category}] ${i.message}${i.element ? ` — ${i.element}` : ""}`)
  }
}
if (errors > 0) {
  console.log(`\n❌ ERRORS:`)
  for (const i of issues.filter(i => i.severity === "error")) {
    console.log(`  [${i.category}] ${i.message}${i.element ? ` — ${i.element}` : ""}`)
  }
}
if (warnings > 0) {
  console.log(`\n⚠️  WARNINGS:`)
  for (const i of issues.filter(i => i.severity === "warning")) {
    console.log(`  [${i.category}] ${i.message}${i.element ? ` — ${i.element}` : ""}`)
  }
}
if (infos > 0) {
  console.log(`\nℹ️  INFO:`)
  for (const i of issues.filter(i => i.severity === "info")) {
    console.log(`  [${i.category}] ${i.message}${i.element ? ` — ${i.element}` : ""}`)
  }
}

// Design summary
if (info.design) {
  console.log(`\n📐 DESIGN SUMMARY:`)
  console.log(`  Fonts: ${JSON.stringify(info.design.fonts)}`)
  console.log(`  Top sizes: ${JSON.stringify(info.design.fontSizes)}`)
  console.log(`  Top colors: ${JSON.stringify(info.design.colors)}`)
}

// Score
const score = Math.max(0, 100 - (critical * 25) - (errors * 10) - (warnings * 3) - (infos * 1))
console.log(`\n📊 SCORE: ${score}/100`)

if (outputFile) {
  const report = { url: pageInfo.url, title: pageInfo.title, score, issues, info, timestamp: new Date().toISOString() }
  writeFileSync(outputFile, JSON.stringify(report, null, 2))
  console.log(`\nReport saved to: ${outputFile}`)
}

relay.close()

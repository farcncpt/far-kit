#!/usr/bin/env node
/**
 * Audit a single page via relay — checks links, headings, images, aria, buttons
 * Usage: node audit-page.mjs <url> [--tab <tabId>]
 */
import { WebSocket } from "ws";

const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith("--") && a !== args[args.indexOf("--tab") + 1]) || "http://localhost:3000/";
const tabIdx = args.indexOf("--tab");
const tabId = tabIdx >= 0 ? args[tabIdx + 1] : "704448023";
const relayUrl = `ws://127.0.0.1:9333/cdp/${tabId}`;

const ws = new WebSocket(relayUrl);
await new Promise((r, e) => { ws.on("open", r); ws.on("error", e); });

let msgId = 0;
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 15000);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off("message", handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Navigate to the URL
console.log(`Navigating to: ${url}`);
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, 5000));

// Run the audit
const auditScript = `
(() => {
  const issues = [];
  const info = { url: location.href, title: document.title };

  // 1. Check all links
  const links = document.querySelectorAll('a');
  const linkData = [];
  links.forEach(a => {
    const href = a.getAttribute('href');
    const text = a.textContent.trim().substring(0, 80);
    const ariaLabel = a.getAttribute('aria-label');
    const hasIcon = a.querySelector('svg, i, img') !== null;
    const isVisible = a.offsetParent !== null || a.closest('[style*="display: none"]') === null;

    if (!href || href === '#') {
      issues.push({ severity: 'major', type: 'broken-link', detail: 'Link has no valid href', selector: a.className || text, href });
    }
    if (!text && !ariaLabel && hasIcon) {
      issues.push({ severity: 'major', type: 'a11y', detail: 'Icon link missing aria-label', selector: a.className, href });
    }
    linkData.push({ href, text: text.substring(0, 50), ariaLabel, hasIcon, isVisible });
  });

  // 2. Check heading hierarchy
  const headings = [];
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    headings.push({ level: parseInt(h.tagName[1]), text: h.textContent.trim().substring(0, 80) });
  });
  let prevLevel = 0;
  headings.forEach((h, i) => {
    if (h.level > prevLevel + 1 && prevLevel > 0) {
      issues.push({ severity: 'minor', type: 'heading-skip', detail: 'Heading level skipped from h' + prevLevel + ' to h' + h.level, text: h.text });
    }
    prevLevel = h.level;
  });
  if (headings.filter(h => h.level === 1).length > 1) {
    issues.push({ severity: 'minor', type: 'multiple-h1', detail: 'Multiple h1 elements found', count: headings.filter(h => h.level === 1).length });
  }
  if (headings.filter(h => h.level === 1).length === 0) {
    issues.push({ severity: 'major', type: 'missing-h1', detail: 'No h1 element found on page' });
  }

  // 3. Check images
  const images = [];
  document.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt');
    const src = img.getAttribute('src');
    if (alt === null || alt === '') {
      issues.push({ severity: 'major', type: 'img-alt', detail: 'Image missing alt text', src: (src || '').substring(0, 100) });
    }
    images.push({ src: (src || '').substring(0, 100), alt: (alt || '').substring(0, 50), width: img.naturalWidth, height: img.naturalHeight });
  });

  // 4. Check buttons
  const buttons = [];
  document.querySelectorAll('button, [role="button"]').forEach(btn => {
    const text = btn.textContent.trim().substring(0, 80);
    const ariaLabel = btn.getAttribute('aria-label');
    const hasIcon = btn.querySelector('svg, i') !== null;
    const disabled = btn.disabled;
    const type = btn.getAttribute('type');

    if (!text && !ariaLabel && hasIcon) {
      issues.push({ severity: 'major', type: 'a11y', detail: 'Icon button missing aria-label', selector: btn.className });
    }
    buttons.push({ text: text.substring(0, 50), ariaLabel, hasIcon, disabled, type, className: (btn.className || '').substring(0, 80) });
  });

  // 5. Check form inputs
  const inputs = [];
  document.querySelectorAll('input, select, textarea').forEach(inp => {
    const id = inp.id;
    const name = inp.name;
    const type = inp.type;
    const label = id ? document.querySelector('label[for="' + id + '"]') : null;
    const ariaLabel = inp.getAttribute('aria-label');
    const placeholder = inp.placeholder;

    if (!label && !ariaLabel && type !== 'hidden' && type !== 'submit') {
      issues.push({ severity: 'minor', type: 'input-label', detail: 'Input missing label', name, inputType: type, id });
    }
    inputs.push({ type, name, id, hasLabel: !!label, ariaLabel, placeholder });
  });

  // 6. Check for empty/placeholder content
  document.querySelectorAll('p, span, div').forEach(el => {
    const text = el.textContent.trim();
    if (text === 'Lorem ipsum' || text.startsWith('Lorem ipsum dolor')) {
      issues.push({ severity: 'major', type: 'placeholder-text', detail: 'Lorem ipsum placeholder text found', selector: el.tagName + '.' + el.className });
    }
  });

  // 7. Check nav elements
  const navs = document.querySelectorAll('nav');
  const navData = [];
  navs.forEach(nav => {
    const label = nav.getAttribute('aria-label');
    const links = nav.querySelectorAll('a');
    navData.push({ ariaLabel: label, linkCount: links.length });
    if (!label) {
      issues.push({ severity: 'minor', type: 'nav-label', detail: 'Nav element missing aria-label' });
    }
  });

  // 8. Check footer
  const footer = document.querySelector('footer');
  const footerInfo = footer ? {
    exists: true,
    links: footer.querySelectorAll('a').length,
    socialLinks: footer.querySelectorAll('a[href*="facebook"], a[href*="twitter"], a[href*="instagram"], a[href*="linkedin"], a[href*="youtube"], a[href*="x.com"]').length,
    forms: footer.querySelectorAll('form').length
  } : { exists: false };

  if (!footer) {
    issues.push({ severity: 'minor', type: 'missing-footer', detail: 'No footer element found' });
  }

  // 9. Meta tags
  const meta = {
    description: document.querySelector('meta[name="description"]')?.content,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content,
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
    viewport: document.querySelector('meta[name="viewport"]')?.content
  };

  if (!meta.description) {
    issues.push({ severity: 'minor', type: 'seo', detail: 'Missing meta description' });
  }

  return JSON.stringify({
    info,
    issues,
    stats: {
      links: linkData.length,
      headings: headings.length,
      images: images.length,
      buttons: buttons.length,
      inputs: inputs.length,
      navs: navData.length
    },
    headings,
    links: linkData.slice(0, 50),
    buttons: buttons.slice(0, 30),
    images: images.slice(0, 20),
    inputs,
    navData,
    footerInfo,
    meta
  });
})()
`;

const result = await send("Runtime.evaluate", { expression: auditScript, returnByValue: true });
const data = JSON.parse(result.result.value);

console.log(JSON.stringify(data, null, 2));

ws.close();

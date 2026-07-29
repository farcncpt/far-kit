#!/usr/bin/env node
/**
 * Full UX audit — navigates to a URL, waits, then runs comprehensive checks.
 * Uses relay bridge.
 * Usage: node cli/full-audit.mjs <url>
 */
import { WebSocket } from "ws";

const url = process.argv[2] || "http://localhost:3000/";
const tabId = process.argv[3] || "704448023";
const relayUrl = `ws://127.0.0.1:9333/cdp/${tabId}`;

const ws = new WebSocket(relayUrl);
await new Promise((r, e) => { ws.on("open", r); ws.on("error", e); });

let msgId = 0;
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 20000);
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

// Navigate using JS
console.error(`Navigating to: ${url}`);
await send("Runtime.evaluate", { expression: `window.location.href = '${url}'` });
await new Promise(r => setTimeout(r, 6000));

// Run audit
const auditScript = `
(() => {
  const issues = [];
  const info = { url: location.href, title: document.title };

  // 1. Links
  const links = [];
  document.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    const text = (a.textContent || '').trim().substring(0, 80);
    const ariaLabel = a.getAttribute('aria-label');
    const hasIcon = a.querySelector('svg, i, img') !== null;
    const rect = a.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0;

    if ((!href || href === '#') && isVisible) {
      issues.push({ severity: 'major', type: 'broken-link', detail: 'Link has no valid href', text: text || ariaLabel || '[icon]', href });
    }
    if (!text && !ariaLabel && hasIcon && isVisible) {
      issues.push({ severity: 'major', type: 'a11y-link', detail: 'Icon link missing aria-label', className: (a.className||'').substring(0,60), href });
    }
    if (isVisible) links.push({ href: (href||'').substring(0,120), text: text.substring(0,50), ariaLabel, hasIcon });
  });

  // 2. Headings
  const headings = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    headings.push({ level: parseInt(h.tagName[1]), text: (h.textContent||'').trim().substring(0,80) });
  });
  let prev = 0;
  headings.forEach(h => {
    if (h.level > prev + 1 && prev > 0)
      issues.push({ severity: 'minor', type: 'heading-skip', detail: 'h'+prev+' to h'+h.level, text: h.text });
    prev = h.level;
  });
  const h1Count = headings.filter(h => h.level === 1).length;
  if (h1Count === 0) issues.push({ severity: 'major', type: 'missing-h1', detail: 'No h1 element' });
  if (h1Count > 1) issues.push({ severity: 'minor', type: 'multiple-h1', detail: h1Count + ' h1 elements' });

  // 3. Images
  const images = [];
  document.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt');
    const src = (img.getAttribute('src')||'').substring(0,120);
    const rect = img.getBoundingClientRect();
    if ((alt === null || alt === '') && rect.width > 0) {
      issues.push({ severity: 'major', type: 'img-alt', detail: 'Image missing alt', src });
    }
    if (rect.width > 0) images.push({ src, alt: (alt||'').substring(0,50), w: Math.round(rect.width), h: Math.round(rect.height) });
  });

  // 4. Buttons
  const buttons = [];
  document.querySelectorAll('button, [role="button"]').forEach(btn => {
    const text = (btn.textContent||'').trim().substring(0,80);
    const ariaLabel = btn.getAttribute('aria-label');
    const hasIcon = btn.querySelector('svg, i') !== null;
    const rect = btn.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0;

    if (!text && !ariaLabel && hasIcon && isVisible) {
      issues.push({ severity: 'major', type: 'a11y-btn', detail: 'Icon button missing aria-label', className: (btn.className||'').substring(0,60) });
    }
    if (isVisible) buttons.push({ text: text.substring(0,50), ariaLabel, hasIcon, disabled: btn.disabled });
  });

  // 5. Inputs
  const inputs = [];
  document.querySelectorAll('input, select, textarea').forEach(inp => {
    const id = inp.id;
    const type = inp.type;
    const label = id ? document.querySelector('label[for="'+id+'"]') : null;
    const ariaLabel = inp.getAttribute('aria-label');
    const ariaLabelledBy = inp.getAttribute('aria-labelledby');
    const rect = inp.getBoundingClientRect();
    if (!label && !ariaLabel && !ariaLabelledBy && type !== 'hidden' && type !== 'submit' && rect.width > 0) {
      issues.push({ severity: 'minor', type: 'input-label', detail: 'Input missing label', inputType: type, name: inp.name, id });
    }
    if (rect.width > 0) inputs.push({ type, name: inp.name, id, hasLabel: !!(label||ariaLabel||ariaLabelledBy), placeholder: inp.placeholder });
  });

  // 6. Placeholder text
  const body = document.body.innerText || '';
  if (/lorem ipsum/i.test(body)) {
    issues.push({ severity: 'major', type: 'placeholder', detail: 'Lorem ipsum text found on page' });
  }

  // 7. Nav
  const navs = [];
  document.querySelectorAll('nav').forEach(nav => {
    const label = nav.getAttribute('aria-label');
    const linkCount = nav.querySelectorAll('a').length;
    navs.push({ ariaLabel: label, linkCount });
    if (!label) issues.push({ severity: 'minor', type: 'nav-label', detail: 'Nav missing aria-label' });
  });

  // 8. Footer
  const footer = document.querySelector('footer');
  const footerInfo = footer ? {
    exists: true,
    linkCount: footer.querySelectorAll('a').length,
    socialLinks: footer.querySelectorAll('a[href*="facebook"], a[href*="twitter"], a[href*="instagram"], a[href*="linkedin"], a[href*="youtube"], a[href*="x.com"], a[href*="tiktok"]').length,
    formCount: footer.querySelectorAll('form, input[type="email"]').length
  } : { exists: false };
  if (!footer) issues.push({ severity: 'minor', type: 'missing-footer', detail: 'No footer element' });

  // 9. Meta
  const meta = {
    description: document.querySelector('meta[name="description"]')?.content || null,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content || null,
    viewport: document.querySelector('meta[name="viewport"]')?.content || null
  };
  if (!meta.description) issues.push({ severity: 'minor', type: 'seo', detail: 'Missing meta description' });

  // 10. Contrast / color issues — check for very small text
  const smallText = [];
  document.querySelectorAll('p, span, a, li, td, th, label').forEach(el => {
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    if (size < 12 && el.textContent.trim().length > 0 && el.getBoundingClientRect().width > 0) {
      smallText.push({ text: el.textContent.trim().substring(0,40), size });
    }
  });
  if (smallText.length > 0) {
    issues.push({ severity: 'minor', type: 'small-text', detail: smallText.length + ' elements with font-size < 12px', samples: smallText.slice(0,5) });
  }

  // 11. Overflow check
  const docWidth = document.documentElement.clientWidth;
  let overflowCount = 0;
  document.querySelectorAll('*').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.right > docWidth + 5 && rect.width > 0 && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
      overflowCount++;
    }
  });
  if (overflowCount > 0) {
    issues.push({ severity: 'major', type: 'overflow', detail: overflowCount + ' elements overflow viewport width' });
  }

  return JSON.stringify({
    info, issues,
    stats: { links: links.length, headings: headings.length, images: images.length, buttons: buttons.length, inputs: inputs.length },
    headings, links: links.slice(0,60), buttons: buttons.slice(0,30), images: images.slice(0,20), inputs,
    navs, footerInfo, meta
  });
})()
`;

const result = await send("Runtime.evaluate", { expression: auditScript, returnByValue: true });

if (result.result.type === 'string') {
  const data = JSON.parse(result.result.value);
  console.log(JSON.stringify(data, null, 2));
} else {
  console.error("Unexpected result:", JSON.stringify(result, null, 2));
}

ws.close();

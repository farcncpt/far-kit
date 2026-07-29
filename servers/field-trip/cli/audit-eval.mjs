#!/usr/bin/env node
/**
 * Run audit on current page via tt.mjs eval relay.
 * Usage: node cli/audit-eval.mjs [tabId]
 */
import { WebSocket } from "ws";

const tabId = process.argv[2] || "704448023";
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

const auditScript = `
(() => {
  const issues = [];
  const info = { url: location.href, title: document.title };
  const links = [];
  document.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    const text = (a.textContent || '').trim().substring(0, 80);
    const ariaLabel = a.getAttribute('aria-label');
    const hasIcon = a.querySelector('svg, i, img') !== null;
    const rect = a.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0;
    if ((!href || href === '#') && isVisible)
      issues.push({ sev: 'major', type: 'broken-link', d: 'No valid href', text: text || ariaLabel || '[icon]', href });
    if (!text && !ariaLabel && hasIcon && isVisible)
      issues.push({ sev: 'major', type: 'a11y-link', d: 'Icon link no aria-label', cls: (a.className||'').substring(0,60) });
    if (isVisible) links.push({ href: (href||'').substring(0,120), text: text.substring(0,50), ariaLabel, hasIcon });
  });
  const headings = [];
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    headings.push({ level: parseInt(h.tagName[1]), text: (h.textContent||'').trim().substring(0,80) });
  });
  let prev = 0;
  headings.forEach(h => {
    if (h.level > prev + 1 && prev > 0)
      issues.push({ sev: 'minor', type: 'heading-skip', d: 'h'+prev+' to h'+h.level, text: h.text });
    prev = h.level;
  });
  const h1c = headings.filter(h => h.level === 1).length;
  if (h1c === 0) issues.push({ sev: 'major', type: 'no-h1', d: 'No h1' });
  if (h1c > 1) issues.push({ sev: 'minor', type: 'multi-h1', d: h1c + ' h1s' });
  const images = [];
  document.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt');
    const src = (img.getAttribute('src')||'').substring(0,120);
    const rect = img.getBoundingClientRect();
    if ((alt === null || alt === '') && rect.width > 0)
      issues.push({ sev: 'major', type: 'img-alt', d: 'No alt', src });
    if (rect.width > 0) images.push({ src, alt: (alt||'').substring(0,50), w: Math.round(rect.width), h: Math.round(rect.height) });
  });
  const buttons = [];
  document.querySelectorAll('button, [role="button"]').forEach(btn => {
    const text = (btn.textContent||'').trim().substring(0,80);
    const ariaLabel = btn.getAttribute('aria-label');
    const hasIcon = btn.querySelector('svg, i') !== null;
    const rect = btn.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0;
    if (!text && !ariaLabel && hasIcon && isVisible)
      issues.push({ sev: 'major', type: 'a11y-btn', d: 'Icon btn no aria-label', cls: (btn.className||'').substring(0,60) });
    if (isVisible) buttons.push({ text: text.substring(0,50), ariaLabel, hasIcon, disabled: btn.disabled });
  });
  const inputs = [];
  document.querySelectorAll('input, select, textarea').forEach(inp => {
    const id = inp.id; const type = inp.type;
    const label = id ? document.querySelector('label[for="'+id+'"]') : null;
    const ariaLabel = inp.getAttribute('aria-label');
    const rect = inp.getBoundingClientRect();
    if (!label && !ariaLabel && type !== 'hidden' && type !== 'submit' && rect.width > 0)
      issues.push({ sev: 'minor', type: 'input-label', d: 'No label', inputType: type, name: inp.name, id });
    if (rect.width > 0) inputs.push({ type, name: inp.name, id, hasLabel: !!(label||ariaLabel), placeholder: inp.placeholder });
  });
  const body = document.body.innerText || '';
  if (/lorem ipsum/i.test(body))
    issues.push({ sev: 'major', type: 'placeholder', d: 'Lorem ipsum found' });
  const navs = [];
  document.querySelectorAll('nav').forEach(nav => {
    const label = nav.getAttribute('aria-label');
    navs.push({ ariaLabel: label, links: nav.querySelectorAll('a').length });
    if (!label) issues.push({ sev: 'minor', type: 'nav-label', d: 'Nav no aria-label' });
  });
  const footer = document.querySelector('footer');
  const footerInfo = footer ? {
    exists: true, linkCount: footer.querySelectorAll('a').length,
    socialLinks: footer.querySelectorAll('a[href*="facebook"], a[href*="twitter"], a[href*="instagram"], a[href*="linkedin"], a[href*="youtube"], a[href*="x.com"], a[href*="tiktok"]').length,
    formCount: footer.querySelectorAll('form, input[type="email"]').length
  } : { exists: false };
  if (!footer) issues.push({ sev: 'minor', type: 'no-footer', d: 'No footer' });
  const meta = {
    desc: document.querySelector('meta[name="description"]')?.content || null,
    viewport: document.querySelector('meta[name="viewport"]')?.content || null
  };
  if (!meta.desc) issues.push({ sev: 'minor', type: 'seo', d: 'No meta description' });
  const docW = document.documentElement.clientWidth;
  let overflow = 0;
  document.querySelectorAll('section, div, img, p, h1, h2, h3').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > docW + 5 && r.width > 0) overflow++;
  });
  if (overflow > 0)
    issues.push({ sev: 'major', type: 'overflow', d: overflow + ' elements overflow' });
  return JSON.stringify({
    info, issues,
    stats: { links: links.length, headings: headings.length, images: images.length, buttons: buttons.length, inputs: inputs.length },
    headings, links: links.slice(0,60), buttons: buttons.slice(0,30), images: images.slice(0,20), inputs, navs, footerInfo, meta
  });
})()
`;

try {
  const result = await send("Runtime.evaluate", { expression: auditScript, returnByValue: true });
  if (result.result.type === 'string') {
    console.log(result.result.value);
  } else {
    console.error("Unexpected:", JSON.stringify(result.result, null, 2));
  }
} catch (e) {
  console.error("Error:", e.message);
}

ws.close();

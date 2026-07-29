#!/usr/bin/env node
/**
 * Audit a single page - navigate and wait longer.
 * Usage: node cli/audit-page2.mjs <url> [tabId]
 */
import { connectRelay } from "./relay-client.mjs";

const url = process.argv[2] || "http://localhost:3000/";
const tabId = parseInt(process.argv[3] || "704448023");

const relay = await connectRelay({ name: "audit-page2" });

async function evalJS(expr) {
  return await relay.command("eval", { expression: expr }, { tabId, timeout: 15000 });
}

try {
  // Navigate
  console.error(`Navigating tab ${tabId} to: ${url}`);
  await evalJS(`window.location.href = "${url}"`);

  // Wait longer for Next.js page load
  await new Promise(r => setTimeout(r, 8000));

  // Verify URL
  const currentUrl = await evalJS("location.href");
  const title = await evalJS("document.title");
  console.log(`PAGE: ${title} | ${currentUrl}`);

  // Check if URL matches
  if (!currentUrl.includes(url.replace('http://localhost:3000', ''))) {
    console.log("WARNING: URL mismatch! Expected:", url, "Got:", currentUrl);
  }

  // Get the main content text to distinguish pages
  const mainText = await evalJS(`(document.querySelector('main') || document.querySelector('#main-content') || document.body).innerText.substring(0, 500)`);
  console.log("CONTENT PREVIEW:", mainText);

  // Headings
  const headings = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({ level: parseInt(h.tagName[1]), text: (h.textContent||'').trim().substring(0,80) })))`);
  console.log("HEADINGS:", headings);

  // Issues
  const issues = await evalJS(`JSON.stringify((() => {
    const issues = [];
    document.querySelectorAll('a').forEach(a => {
      const r = a.getBoundingClientRect(); if (r.width === 0) return;
      const href = a.getAttribute('href');
      const text = (a.textContent||'').trim();
      const al = a.getAttribute('aria-label');
      if (!href || href === '#') issues.push({s:'major',t:'broken-link',d:text||al||'[icon]',href});
      if (!text && !al && a.querySelector('svg,i,img')) issues.push({s:'major',t:'a11y-link',d:'icon link no label'});
    });
    document.querySelectorAll('img').forEach(img => {
      if (img.getBoundingClientRect().width === 0) return;
      const alt = img.getAttribute('alt');
      if (alt === null || alt === '') issues.push({s:'major',t:'img-alt',d:(img.getAttribute('src')||'').substring(0,80)});
    });
    document.querySelectorAll('button,[role=button]').forEach(b => {
      if (b.getBoundingClientRect().width === 0) return;
      const text = (b.textContent||'').trim();
      const al = b.getAttribute('aria-label');
      if (!text && !al && b.querySelector('svg,i')) issues.push({s:'major',t:'a11y-btn',d:'icon btn no label',cls:(b.className||'').substring(0,40)});
    });
    let prev = 0;
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      const l = parseInt(h.tagName[1]);
      if (l > prev+1 && prev > 0) issues.push({s:'minor',t:'heading-skip',d:'h'+prev+' to h'+l});
      prev = l;
    });
    const h1s = document.querySelectorAll('h1').length;
    if (h1s === 0) issues.push({s:'major',t:'no-h1',d:'missing'});
    if (h1s > 1) issues.push({s:'minor',t:'multi-h1',d:h1s+' h1s'});
    if (/lorem ipsum/i.test(document.body.innerText)) issues.push({s:'major',t:'placeholder',d:'lorem ipsum'});
    document.querySelectorAll('nav').forEach(n => { if (!n.getAttribute('aria-label')) issues.push({s:'minor',t:'nav-label',d:'nav no aria-label'}); });
    if (!document.querySelector('footer')) issues.push({s:'minor',t:'no-footer',d:'missing footer'});
    document.querySelectorAll('input,select,textarea').forEach(inp => {
      const r = inp.getBoundingClientRect(); if (r.width === 0) return;
      const id = inp.id; const type = inp.type;
      const label = id ? document.querySelector('label[for='+JSON.stringify(id)+']') : null;
      const al = inp.getAttribute('aria-label');
      if (!label && !al && type !== 'hidden' && type !== 'submit')
        issues.push({s:'minor',t:'input-label',d:'input no label type='+type});
    });
    return issues;
  })())`);
  console.log("ISSUES:", issues);

  // Links
  const links = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('a')).filter(a => a.getBoundingClientRect().width > 0).map(a => ({ href: (a.getAttribute('href')||'').substring(0,120), text: (a.textContent||'').trim().substring(0,50) })).slice(0,60))`);
  console.log("LINKS:", links);

  // Images
  const images = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('img')).filter(i => i.getBoundingClientRect().width > 0).map(i => ({ src: (i.getAttribute('src')||'').substring(0,120), alt: i.getAttribute('alt') })))`);
  console.log("IMAGES:", images);

  // Buttons
  const buttons = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('button,[role=button]')).filter(b => b.getBoundingClientRect().width > 0).map(b => ({ text: (b.textContent||'').trim().substring(0,50), ariaLabel: b.getAttribute('aria-label') })).slice(0,20))`);
  console.log("BUTTONS:", buttons);

  // Inputs
  const inputs = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('input,select,textarea')).filter(i => i.getBoundingClientRect().width > 0).map(i => ({ type: i.type, placeholder: i.placeholder, hasLabel: !!(i.id && document.querySelector('label[for='+JSON.stringify(i.id)+']')) || !!i.getAttribute('aria-label') })))`);
  console.log("INPUTS:", inputs);

} catch (e) {
  console.error("Error:", e.message);
} finally {
  relay.close();
}

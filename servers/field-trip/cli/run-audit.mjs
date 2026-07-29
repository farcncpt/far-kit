#!/usr/bin/env node
/**
 * Run audit on current page using relay-client.mjs evaluate().
 * Usage: node cli/run-audit.mjs [tabId]
 */
import { connectRelay } from "./relay-client.mjs";

const tabId = parseInt(process.argv[2] || "704448023");

const relay = await connectRelay({ name: "audit" });

async function evalJS(expr) {
  return await relay.command("eval", { expression: expr }, { tabId, timeout: 15000 });
}

try {
  // Basic info
  const title = await evalJS("document.title");
  const url = await evalJS("location.href");
  console.log("PAGE:", title, "|", url);

  // Links audit
  const linksData = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('a')).filter(a => { const r = a.getBoundingClientRect(); return r.width > 0; }).map(a => ({ href: (a.getAttribute('href')||'').substring(0,120), text: (a.textContent||'').trim().substring(0,50), ariaLabel: a.getAttribute('aria-label'), hasIcon: !!a.querySelector('svg,i,img') })).slice(0,80))`);
  console.log("LINKS:", linksData);

  // Headings
  const headingsData = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({ level: parseInt(h.tagName[1]), text: (h.textContent||'').trim().substring(0,80) })))`);
  console.log("HEADINGS:", headingsData);

  // Images
  const imagesData = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('img')).filter(i => i.getBoundingClientRect().width > 0).map(i => ({ src: (i.getAttribute('src')||'').substring(0,120), alt: i.getAttribute('alt'), w: Math.round(i.getBoundingClientRect().width) })))`);
  console.log("IMAGES:", imagesData);

  // Buttons
  const buttonsData = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('button,[role=button]')).filter(b => b.getBoundingClientRect().width > 0).map(b => ({ text: (b.textContent||'').trim().substring(0,50), ariaLabel: b.getAttribute('aria-label'), hasIcon: !!b.querySelector('svg,i') })).slice(0,30))`);
  console.log("BUTTONS:", buttonsData);

  // Inputs
  const inputsData = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('input,select,textarea')).filter(i => i.getBoundingClientRect().width > 0).map(i => ({ type: i.type, name: i.name, id: i.id, hasLabel: !!(i.id && document.querySelector('label[for='+JSON.stringify(i.id)+']')) || !!i.getAttribute('aria-label'), placeholder: i.placeholder })))`);
  console.log("INPUTS:", inputsData);

  // Nav elements
  const navsData = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('nav')).map(n => ({ ariaLabel: n.getAttribute('aria-label'), links: n.querySelectorAll('a').length })))`);
  console.log("NAVS:", navsData);

  // Footer
  const footerData = await evalJS(`JSON.stringify((() => { const f = document.querySelector('footer'); if (!f) return { exists: false }; return { exists: true, links: f.querySelectorAll('a').length, social: f.querySelectorAll('a[href*=facebook],a[href*=twitter],a[href*=instagram],a[href*=linkedin],a[href*=youtube],a[href*=x.com],a[href*=tiktok]').length, forms: f.querySelectorAll('form,input[type=email]').length }; })())`);
  console.log("FOOTER:", footerData);

  // Issues
  const issuesData = await evalJS(`JSON.stringify((() => {
    const issues = [];
    document.querySelectorAll('a').forEach(a => {
      const href = a.getAttribute('href');
      const r = a.getBoundingClientRect();
      if (r.width === 0) return;
      const text = (a.textContent||'').trim();
      const al = a.getAttribute('aria-label');
      if (!href || href === '#') issues.push({s:'major',t:'broken-link',d:text||al||'[icon]',href});
      if (!text && !al && a.querySelector('svg,i,img')) issues.push({s:'major',t:'a11y-link',d:'icon link no label',cls:(a.className||'').substring(0,40)});
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
    if (!document.querySelector('footer')) issues.push({s:'minor',t:'no-footer',d:'missing'});
    if (!document.querySelector('meta[name=description]')?.content) issues.push({s:'minor',t:'seo',d:'no meta desc'});
    const dw = document.documentElement.clientWidth;
    let ov = 0;
    document.querySelectorAll('section,div,img,p,h1,h2,h3').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > dw + 5 && r.width > 0) ov++;
    });
    if (ov > 0) issues.push({s:'major',t:'overflow',d:ov+' elements overflow'});
    return issues;
  })())`);
  console.log("ISSUES:", issuesData);

  // Meta
  const metaData = await evalJS(`JSON.stringify({ desc: document.querySelector('meta[name=description]')?.content||null, ogTitle: document.querySelector('meta[property="og:title"]')?.content||null, viewport: document.querySelector('meta[name=viewport]')?.content||null })`);
  console.log("META:", metaData);

} catch (e) {
  console.error("Error:", e.message);
} finally {
  relay.close();
}

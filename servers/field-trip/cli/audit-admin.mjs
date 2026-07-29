#!/usr/bin/env node
/**
 * Audit admin pages by clicking sidebar nav links.
 * Usage: node cli/audit-admin.mjs [tabId]
 */
import { connectRelay } from "./relay-client.mjs";

const tabId = parseInt(process.argv[2] || "704448023");
const relay = await connectRelay({ name: "audit-admin" });

async function evalJS(expr) {
  return await relay.command("eval", { expression: expr }, { tabId, timeout: 15000 });
}

// First navigate to admin
await evalJS(`window.location.href = "http://localhost:3000/admin"`);
await new Promise(r => setTimeout(r, 8000));

const adminPages = [
  { name: "Products", linkText: "Products" },
  { name: "Orders", linkText: "Orders" },
  { name: "Pages", linkText: "Pages" },
  { name: "Blog", linkText: "Blog" },
  { name: "Media", linkText: "Media" },
  { name: "Forms", linkText: "Forms" },
];

for (const page of adminPages) {
  try {
    // Click the sidebar link
    console.log(`\n--- Clicking: ${page.name} ---`);
    const clicked = await evalJS(`(() => {
      const links = Array.from(document.querySelectorAll('nav a, aside a'));
      const link = links.find(a => a.textContent.trim() === "${page.linkText}" && a.getAttribute('href').startsWith('/admin/'));
      if (link) { link.click(); return link.getAttribute('href'); }
      return null;
    })()`);
    console.log("Clicked link to:", clicked);

    await new Promise(r => setTimeout(r, 4000));

    const url = await evalJS("location.href");
    const title = await evalJS("document.title");
    console.log(`PAGE: ${title} | ${url}`);

    // Content preview
    const content = await evalJS(`(document.querySelector('main') || document.body).innerText.substring(0, 400)`);
    console.log("CONTENT:", content);

    // Headings
    const headings = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({ level: parseInt(h.tagName[1]), text: (h.textContent||'').trim().substring(0,60) })))`);
    console.log("HEADINGS:", headings);

    // Buttons
    const buttons = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('main button, main [role=button]')).filter(b => b.getBoundingClientRect().width > 0).map(b => ({ text: (b.textContent||'').trim().substring(0,50), ariaLabel: b.getAttribute('aria-label'), hasIcon: !!b.querySelector('svg,i') })).slice(0,15))`);
    console.log("BUTTONS:", buttons);

    // Inputs in main content
    const inputs = await evalJS(`JSON.stringify(Array.from(document.querySelectorAll('main input, main select, main textarea')).filter(i => i.getBoundingClientRect().width > 0).map(i => ({ type: i.type, placeholder: i.placeholder, hasLabel: !!(i.id && document.querySelector('label[for='+JSON.stringify(i.id)+']')) || !!i.getAttribute('aria-label') })))`);
    console.log("INPUTS:", inputs);

    // Tables
    const tables = await evalJS(`JSON.stringify((() => { const tables = document.querySelectorAll('main table'); return Array.from(tables).map(t => ({ rows: t.querySelectorAll('tr').length, cols: t.querySelectorAll('th').length, hasCaption: !!t.querySelector('caption') })); })())`);
    console.log("TABLES:", tables);

  } catch (e) {
    console.error(`Error on ${page.name}:`, e.message);
  }
}

// Navigate back to admin for the settings check
await evalJS(`window.location.href = "http://localhost:3000/admin/settings"`);
await new Promise(r => setTimeout(r, 5000));
const settingsUrl = await evalJS("location.href");
const settingsContent = await evalJS(`(document.querySelector('main') || document.body).innerText.substring(0, 400)`);
console.log(`\n--- Settings ---`);
console.log(`PAGE: ${settingsUrl}`);
console.log("CONTENT:", settingsContent);

relay.close();

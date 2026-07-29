#!/usr/bin/env node
/**
 * Check responsive layout issues on homepage.
 */
import { connectRelay } from "./relay-client.mjs";

const tabId = parseInt(process.argv[2] || "704448023");
const relay = await connectRelay({ name: "responsive" });

async function evalJS(expr) {
  return await relay.command("eval", { expression: expr }, { tabId, timeout: 15000 });
}

// Navigate to homepage
await evalJS(`window.location.href = "http://localhost:3000/"`);
await new Promise(r => setTimeout(r, 8000));

// Check current viewport
const viewport = await evalJS(`JSON.stringify({ width: window.innerWidth, height: window.innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight })`);
console.log("VIEWPORT:", viewport);

// Check for horizontal overflow
const overflow = await evalJS(`JSON.stringify((() => {
  const vw = document.documentElement.clientWidth;
  const overflowing = [];
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > vw + 2 && r.width > 0 && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
      overflowing.push({
        tag: el.tagName,
        cls: (el.className || '').substring(0, 50),
        right: Math.round(r.right),
        width: Math.round(r.width),
        overflow: Math.round(r.right - vw)
      });
    }
  });
  return { viewportWidth: vw, count: overflowing.length, items: overflowing.slice(0, 10) };
})())`);
console.log("OVERFLOW CHECK:", overflow);

// Check text size readability
const textSizes = await evalJS(`JSON.stringify((() => {
  const small = [];
  document.querySelectorAll('p, span, a, li, label').forEach(el => {
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    const r = el.getBoundingClientRect();
    if (size < 14 && r.width > 0 && el.textContent.trim().length > 5) {
      small.push({ text: el.textContent.trim().substring(0, 40), size, tag: el.tagName });
    }
  });
  return { count: small.length, samples: small.slice(0, 10) };
})())`);
console.log("SMALL TEXT:", textSizes);

// Check touch target sizes (buttons/links < 44px)
const touchTargets = await evalJS(`JSON.stringify((() => {
  const small = [];
  document.querySelectorAll('a, button').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
      small.push({
        tag: el.tagName,
        text: (el.textContent || '').trim().substring(0, 30),
        w: Math.round(r.width),
        h: Math.round(r.height)
      });
    }
  });
  return { count: small.length, samples: small.slice(0, 15) };
})())`);
console.log("SMALL TOUCH TARGETS:", touchTargets);

// Check color contrast (approximate - text on bg)
const contrastIssues = await evalJS(`JSON.stringify((() => {
  function luminance(r, g, b) {
    const a = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function parseColor(c) {
    const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : null;
  }
  const issues = [];
  document.querySelectorAll('p, a, span, h1, h2, h3, button, li, label').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    const bg = parseColor(style.backgroundColor);
    if (fg && bg) {
      const l1 = luminance(...fg);
      const l2 = luminance(...bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 4.5 && bg[0] !== 0 && bg[1] !== 0 && bg[2] !== 0) {
        issues.push({
          text: el.textContent.trim().substring(0, 30),
          fg: style.color,
          bg: style.backgroundColor,
          ratio: ratio.toFixed(2),
          tag: el.tagName
        });
      }
    }
  });
  return { count: issues.length, samples: issues.slice(0, 10) };
})())`);
console.log("CONTRAST ISSUES:", contrastIssues);

relay.close();

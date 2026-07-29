#!/usr/bin/env node
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "signin-check" })

// Deep scan the sign-in page for form elements
const result = await relay.command("eval", {
  expression: `
    (() => {
      // Check all elements including those in shadow DOM
      const allInputs = document.querySelectorAll('input, button, a, [role="button"], form');
      const items = [];
      for (const el of allInputs) {
        const rect = el.getBoundingClientRect();
        items.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          text: (el.textContent || '').trim().slice(0, 80),
          ariaLabel: el.getAttribute('aria-label') || '',
          className: (el.className || '').toString().slice(0, 60),
          visible: rect.width > 0 && rect.height > 0,
          y: Math.round(rect.y),
        });
      }

      // Also check for Stack Auth's scope container
      const stackScope = document.querySelector('.stack-scope');
      let stackContent = null;
      if (stackScope) {
        stackContent = {
          html: stackScope.innerHTML.slice(0, 500),
          inputs: stackScope.querySelectorAll('input').length,
          buttons: stackScope.querySelectorAll('button').length,
          links: stackScope.querySelectorAll('a').length,
        };
      }

      // Check for any iframes (Stack Auth might use an iframe)
      const iframes = document.querySelectorAll('iframe');

      return {
        url: location.href,
        title: document.title,
        totalInputs: items.length,
        items: items.filter(i => i.visible),
        stackScope: stackContent,
        iframeCount: iframes.length,
        bodyText: document.body?.innerText?.slice(0, 300),
      };
    })()
  `
})

console.log("Sign-in page analysis:")
console.log(`URL: ${result.url}`)
console.log(`Body text: ${result.bodyText}\n`)

if (result.stackScope) {
  console.log("Stack Auth scope found:")
  console.log(`  Inputs: ${result.stackScope.inputs}`)
  console.log(`  Buttons: ${result.stackScope.buttons}`)
  console.log(`  Links: ${result.stackScope.links}`)
  console.log(`  HTML preview: ${result.stackScope.html.slice(0, 200)}\n`)
}

console.log(`Visible form elements (${result.items.length}):`)
for (const el of result.items) {
  const parts = [`<${el.tag}>`]
  if (el.type) parts.push(`type="${el.type}"`)
  if (el.id) parts.push(`id="${el.id}"`)
  if (el.name) parts.push(`name="${el.name}"`)
  if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`)
  if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`)
  if (el.text) parts.push(`"${el.text.slice(0, 50)}"`)
  console.log(`  ${parts.join(' ')}`)
}

relay.close()

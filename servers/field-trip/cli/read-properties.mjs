#!/usr/bin/env node
/** Read the properties panel of the selected block in Dzidzor editor */
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "read-props" })

const result = await relay.command("eval", {
  expression: `
    (() => {
      const body = document.body.innerText;
      const propIdx = body.indexOf('Properties');
      if (propIdx === -1) return { error: 'Properties panel not visible — click a block first' };

      // Get text from Properties onward
      const propsText = body.slice(propIdx, propIdx + 2000);

      // Also find all inputs/selects in the properties area
      const allInputs = document.querySelectorAll('input, select, textarea, [contenteditable="true"]');
      const propInputs = [];
      for (const inp of allInputs) {
        const rect = inp.getBoundingClientRect();
        // Properties panel is typically on the right side (x > 1000 or x > 700)
        if (rect.x < 400 || rect.width < 20) continue;
        const label = inp.getAttribute('aria-label') || inp.placeholder || inp.name || inp.id || '';
        const prevLabel = inp.previousElementSibling?.textContent?.trim() || '';
        propInputs.push({
          tag: inp.tagName.toLowerCase(),
          type: inp.type || '',
          label: label || prevLabel,
          value: (inp.value || '').slice(0, 50),
          placeholder: inp.placeholder || '',
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }

      // Find all buttons/tabs in the properties panel area
      const propButtons = [];
      const buttons = document.querySelectorAll('button, [role="tab"]');
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (rect.x < 400 || rect.width < 20) continue;
        const text = btn.textContent.trim();
        if (text && text.length < 30) {
          propButtons.push({ text, y: Math.round(rect.y) });
        }
      }

      return {
        propertiesText: propsText,
        inputs: propInputs,
        buttons: propButtons.sort((a, b) => a.y - b.y),
      };
    })()
  `
})

if (result.error) {
  console.log(result.error)
} else {
  console.log("=== PROPERTIES PANEL TEXT ===\n")
  console.log(result.propertiesText?.slice(0, 1500))

  if (result.inputs?.length) {
    console.log("\n=== PROPERTY INPUTS ===\n")
    for (const inp of result.inputs) {
      console.log(`  <${inp.tag}> type="${inp.type}" label="${inp.label}" value="${inp.value}" placeholder="${inp.placeholder}" @ x=${inp.x}`)
    }
  }

  if (result.buttons?.length) {
    console.log("\n=== PROPERTY TABS/BUTTONS ===\n")
    for (const btn of result.buttons) {
      console.log(`  "${btn.text}"`)
    }
  }
}

relay.close()

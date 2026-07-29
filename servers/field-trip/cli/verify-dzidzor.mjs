import { connectRelay, relayOnce } from './relay-client.mjs';

const TAB = 704448259;

async function evalInTab(relay, expr) {
  return new Promise((resolve, reject) => {
    const id = Date.now() + Math.random();
    relay.ws.send(JSON.stringify({
      type: 'command',
      id,
      tabId: TAB,
      action: 'eval',
      params: { expression: expr }
    }));
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        relay.ws.removeListener('message', handler);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      }
    };
    relay.ws.on('message', handler);
    setTimeout(() => { relay.ws.removeListener('message', handler); reject(new Error('timeout')); }, 10000);
  });
}

async function navAndWait(relay, url, ms = 6000) {
  await evalInTab(relay, `window.location.href = "${url}"`);
  await new Promise(r => setTimeout(r, ms));
}

async function main() {
  const relay = await connectRelay({ name: 'verify-dzidzor' });

  // Navigate to homepage
  await navAndWait(relay, '/');

  // 1. Check LinkedIn link href
  const linkedin = await evalInTab(relay, 'document.querySelector("[aria-label=\\"LinkedIn\\"]")?.href || "NOT FOUND"');
  console.log('1. LinkedIn href:', linkedin);

  // 2. Check logo link aria-label
  const logoAria = await evalInTab(relay, 'document.querySelector("header a")?.getAttribute("aria-label") || "NOT FOUND"');
  console.log('2. Logo aria-label:', logoAria);

  // 3. Check nav aria-label
  const navAria = await evalInTab(relay, 'document.querySelector("nav")?.getAttribute("aria-label") || "NOT FOUND"');
  console.log('3. Nav aria-label:', navAria);

  // 4. Check footer email input aria-label
  const emailAria = await evalInTab(relay, 'document.querySelector("input[type=email]")?.getAttribute("aria-label") || "NOT FOUND"');
  console.log('4. Email input aria-label:', emailAria);

  // 5. Check social links
  const socialTexts = await evalInTab(relay, 'JSON.stringify(Array.from(document.querySelectorAll("[aria-label=\\"Facebook\\"],[aria-label=\\"Twitter\\"],[aria-label=\\"Instagram\\"],[aria-label=\\"LinkedIn\\"],[aria-label=\\"Email\\"]")).map(a => ({label: a.getAttribute("aria-label"), text: a.textContent.trim(), href: a.href})))');
  console.log('5. Social links:', socialTexts);

  // 6. About page h1
  await navAndWait(relay, '/about');
  const aboutH1 = await evalInTab(relay, 'document.querySelector("main h1")?.textContent || "NO H1 FOUND"');
  console.log('6. About page h1:', aboutH1);

  // 7. Travel Requirements h1
  await navAndWait(relay, '/travel-requirements');
  const travelH1 = await evalInTab(relay, 'document.querySelector("main h1")?.textContent || "NO H1 FOUND"');
  console.log('7. Travel Requirements h1:', travelH1);

  // 8. Get Involved form labels
  await navAndWait(relay, '/get-involved');
  const formLabels = await evalInTab(relay, 'JSON.stringify(Array.from(document.querySelectorAll("main label")).map(l => ({text: l.textContent.trim(), htmlFor: l.getAttribute("for")})))');
  console.log('8. Form labels:', formLabels);

  const formInputs = await evalInTab(relay, 'JSON.stringify(Array.from(document.querySelectorAll("main input, main textarea")).map(i => ({type: i.type, id: i.id, ariaLabel: i.getAttribute("aria-label"), name: i.name})))');
  console.log('9. Form inputs:', formInputs);

  relay.close();
}

main().catch(e => { console.error(e); process.exit(1); });

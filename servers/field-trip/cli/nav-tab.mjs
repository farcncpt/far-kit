#!/usr/bin/env node
/**
 * Navigate a specific tab to a URL, wait, then run audit.
 * Usage: node cli/nav-tab.mjs <url> [tabId]
 */
import { connectRelay } from "./relay-client.mjs";

const url = process.argv[2] || "http://localhost:3000/";
const tabId = parseInt(process.argv[3] || "704448023");

const relay = await connectRelay({ name: "nav-tab" });

async function evalJS(expr) {
  return await relay.command("eval", { expression: expr }, { tabId, timeout: 15000 });
}

try {
  // Navigate
  console.error(`Navigating tab ${tabId} to: ${url}`);
  await evalJS(`window.location.href = "${url}"`);

  // Wait for page load
  await new Promise(r => setTimeout(r, 6000));

  // Get page info
  const title = await evalJS("document.title");
  const currentUrl = await evalJS("location.href");
  console.log("PAGE:", title, "|", currentUrl);

} catch (e) {
  console.error("Error:", e.message);
} finally {
  relay.close();
}

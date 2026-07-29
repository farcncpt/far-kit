#!/usr/bin/env node
import { connectRelay } from "./relay-client.mjs"
const relay = await connectRelay({ port: 9333, name: "sd-nav" })
const url = process.argv[2] || "https://stackdive.app"
const tabId = parseInt(process.argv[3]) || 704448034
console.log(`Navigating tab ${tabId} to ${url}...`)
await relay.command("navigate", { url }, { tabId })
await new Promise(r => setTimeout(r, 5000))
const page = await relay.command("page", {}, { tabId })
console.log(`${page.title} — ${page.url}`)
relay.close()

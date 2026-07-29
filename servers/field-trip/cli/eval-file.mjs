#!/usr/bin/env node
/**
 * eval-file.mjs — Evaluate a JS expression read from a file, via the relay.
 * Sidesteps bash→PowerShell→node quoting by never putting JS on the CLI.
 *
 * Usage: node cli/eval-file.mjs <path-to-js-file> [--tab <tabId>]
 */
import { readFileSync } from "node:fs"
import { connectRelay } from "./relay-client.mjs"

const args = process.argv.slice(2)
const file = args[0]
if (!file) {
  console.error("Usage: node cli/eval-file.mjs <file.js> [--tab <tabId>]")
  process.exit(1)
}
const tabIdx = args.indexOf("--tab")
const tabId = tabIdx !== -1 ? parseInt(args[tabIdx + 1]) : undefined

const expression = readFileSync(file, "utf8")

const relay = await connectRelay({ name: "eval-file" })
try {
  // tabId rides in command options (third arg), NOT params — params.tabId is ignored.
  const result = await relay.command("eval", { expression }, tabId ? { tabId } : {})
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 1))
} catch (err) {
  console.error("EVAL_ERROR:", err.message)
  process.exitCode = 2
} finally {
  relay.close()
}

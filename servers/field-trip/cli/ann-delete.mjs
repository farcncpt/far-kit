#!/usr/bin/env node
/**
 * ann-delete.mjs — delete one or more annotations by id.
 *
 * Usage:
 *   node cli/ann-delete.mjs --relay <id1> [<id2> ...]
 */

import { connectRelay } from "./relay-client.mjs"

const args = process.argv.slice(2)
const useRelay = args.includes("--relay")
const ids = args.filter((a) => !a.startsWith("--"))

if (!useRelay || ids.length === 0) {
  console.error("Usage: node cli/ann-delete.mjs --relay <id> [<id> ...]")
  process.exit(1)
}

const relay = await connectRelay({ port: 9333 })

try {
  for (const id of ids) {
    const result = await relay.command("annotations", { action: "delete", id })
    console.log(`✔ deleted ${id}`, result?.data ?? "")
  }
} catch (err) {
  console.error("Error:", err.message)
  process.exit(1)
} finally {
  relay.close()
}

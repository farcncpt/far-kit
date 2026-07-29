/**
 * Tool Knowledge Base
 *
 * Persistent store of tool knowledge that survives compactions and sessions.
 * Auto-populated when tools are used, queryable for discovery.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = join(__dirname, "knowledge");
const KB_FILE = join(KB_DIR, "tools.json");
const LOG_FILE = join(KB_DIR, "learning-log.jsonl");

// ── Knowledge Base CRUD ──

export function loadKB() {
  if (!existsSync(KB_DIR)) mkdirSync(KB_DIR, { recursive: true });
  if (!existsSync(KB_FILE)) return {};
  try { return JSON.parse(readFileSync(KB_FILE, "utf8")); } catch { return {}; }
}

export function saveKB(kb) {
  if (!existsSync(KB_DIR)) mkdirSync(KB_DIR, { recursive: true });
  writeFileSync(KB_FILE, JSON.stringify(kb, null, 2));
}

// ── Log a tool usage ──

export function logToolUsage(toolName, action, params, result, duration) {
  const kb = loadKB();

  if (!kb[toolName]) {
    kb[toolName] = {
      description: "",
      params: [],
      examples: [],
      category: "uncategorized",
      lastUsed: null,
      useCount: 0,
      successes: 0,
      failures: 0,
      avgDuration: 0,
      notes: [],
      learnedAt: new Date().toISOString(),
    };
  }

  const entry = kb[toolName];
  entry.useCount++;
  entry.lastUsed = new Date().toISOString();

  if (result && !result.startsWith("Error")) {
    entry.successes++;
  } else {
    entry.failures++;
  }

  if (duration) {
    entry.avgDuration = Math.round(
      (entry.avgDuration * (entry.useCount - 1) + duration) / entry.useCount
    );
  }

  // Auto-learn params from usage
  if (params && typeof params === "object") {
    for (const key of Object.keys(params)) {
      if (!entry.params.includes(key)) {
        entry.params.push(key);
      }
    }
  }

  // Store recent example (keep last 3)
  const example = { action, params, timestamp: new Date().toISOString() };
  entry.examples = [example, ...entry.examples.slice(0, 2)];

  saveKB(kb);
}

// ── Log a learning event ──

export function logLearning(event) {
  if (!existsSync(KB_DIR)) mkdirSync(KB_DIR, { recursive: true });
  const line = JSON.stringify({
    ...event,
    timestamp: new Date().toISOString(),
  }) + "\n";

  try {
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : "";
    writeFileSync(LOG_FILE, existing + line);
  } catch {
    writeFileSync(LOG_FILE, line);
  }
}

// ── Query the knowledge base ──

export function searchKB(query) {
  const kb = loadKB();
  const q = query.toLowerCase();
  const matches = [];

  for (const [name, entry] of Object.entries(kb)) {
    const score =
      (name.toLowerCase().includes(q) ? 10 : 0) +
      (entry.description?.toLowerCase().includes(q) ? 5 : 0) +
      (entry.category?.toLowerCase().includes(q) ? 3 : 0) +
      (entry.notes?.some(n => n.toLowerCase().includes(q)) ? 2 : 0) +
      (entry.params?.some(p => p.toLowerCase().includes(q)) ? 1 : 0);

    if (score > 0) {
      matches.push({ name, score, ...entry });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

// ── Get recent learnings ──

export function getRecentLearnings(count) {
  if (!existsSync(LOG_FILE)) return [];
  try {
    const lines = readFileSync(LOG_FILE, "utf8").trim().split("\n");
    return lines.slice(-count).map(l => JSON.parse(l)).reverse();
  } catch { return []; }
}

// ── Update tool description/metadata ──

export function updateTool(name, updates) {
  const kb = loadKB();
  if (!kb[name]) {
    kb[name] = {
      description: "", params: [], examples: [], category: "uncategorized",
      lastUsed: null, useCount: 0, successes: 0, failures: 0, avgDuration: 0,
      notes: [], learnedAt: new Date().toISOString(),
    };
  }
  Object.assign(kb[name], updates, { updatedAt: new Date().toISOString() });
  saveKB(kb);
  return kb[name];
}

// ── Get summary for context injection ──

export function getKBSummary() {
  const kb = loadKB();
  const tools = Object.entries(kb);
  if (tools.length === 0) return "No tools in knowledge base yet.";

  const categories = {};
  for (const [name, entry] of tools) {
    const cat = entry.category || "uncategorized";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(`${name} (${entry.useCount}x) — ${entry.description || "no description"}`);
  }

  const lines = [`Tool Knowledge Base: ${tools.length} tools\n`];
  for (const [cat, items] of Object.entries(categories).sort()) {
    lines.push(`[${cat}]`);
    for (const item of items) lines.push(`  • ${item}`);
    lines.push("");
  }

  return lines.join("\n");
}

#!/usr/bin/env node
/**
 * Agent-Com Orphan Cleanup Script
 *
 * Cleans up stale state from agents that died without proper decommission.
 * Run this at orchestrator startup and periodically during overnight operations.
 *
 * Usage:
 *   node cli/agent-com-cleanup.mjs              # Dry run (show what would be cleaned)
 *   node cli/agent-com-cleanup.mjs --execute     # Actually clean up
 *   node cli/agent-com-cleanup.mjs --full-reset  # Nuclear option: clear all agent state
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const STATE_FILE = resolve(process.env.HOME || process.env.USERPROFILE, '.agent-communication/shared-state.json');
const DRY_RUN = !process.argv.includes('--execute');
const FULL_RESET = process.argv.includes('--full-reset');

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not read state file:', STATE_FILE);
    process.exit(1);
  }
}

function saveState(state) {
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would save changes. Use --execute to apply.');
    return;
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('\nState file updated.');
}

function main() {
  const state = loadState();
  const agents = state.agents || {};
  const memory = state.memory || {};

  console.log('=== Agent-Com Orphan Cleanup ===');
  console.log(`Mode: ${FULL_RESET ? 'FULL RESET' : DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Total agents: ${Object.keys(agents).length}`);
  console.log(`Total memory entries: ${Object.keys(memory).length}`);
  console.log('');

  if (FULL_RESET) {
    console.log('FULL RESET requested — clearing all Field Trip agent state...');
    // Only clear Field Trip related state, not other projects
    let cleaned = 0;
    for (const [key, entry] of Object.entries(memory)) {
      if (['chrome-status', 'relay-status', 'tab-ownership', 'locks', 'dev-servers'].includes(key) ||
          key.startsWith('agent-registry')) {
        if (!DRY_RUN) delete memory[key];
        console.log(`  DELETE memory: ${key}`);
        cleaned++;
      }
    }
    console.log(`\nWould clean ${cleaned} memory entries.`);
    if (!DRY_RUN) saveState(state);
    return;
  }

  // Find offline agents
  const now = Date.now();
  const STALE_THRESHOLD = 10 * 60 * 1000; // 10 minutes
  const offlineAgents = new Set();

  for (const [id, agent] of Object.entries(agents)) {
    if (agent.status === 'offline' || (now - agent.last_heartbeat > STALE_THRESHOLD)) {
      offlineAgents.add(agent.name || id);
    }
  }

  console.log(`Offline/stale agents: ${offlineAgents.size}`);

  // Check tab-ownership for stale entries
  let staleTabCount = 0;
  for (const [key, entry] of Object.entries(memory)) {
    if (!key.startsWith('tab-ownership')) continue;
    const value = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
    if (typeof value === 'object' && value !== null) {
      for (const [tabId, ownership] of Object.entries(value)) {
        if (ownership && ownership.owner && offlineAgents.has(ownership.owner)) {
          console.log(`  STALE TAB: ${tabId} owned by ${ownership.owner} (offline)`);
          if (!DRY_RUN) delete value[tabId];
          staleTabCount++;
        }
      }
    }
  }

  // Check locks for stale entries
  let staleLockCount = 0;
  for (const [key, entry] of Object.entries(memory)) {
    if (!key.startsWith('locks')) continue;
    const value = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
    if (typeof value === 'object' && value !== null) {
      for (const [resource, lock] of Object.entries(value)) {
        if (lock && lock.locked && lock.by && offlineAgents.has(lock.by)) {
          console.log(`  STALE LOCK: ${resource} held by ${lock.by} (offline)`);
          if (!DRY_RUN) {
            value[resource] = { locked: false, by: null };
          }
          staleLockCount++;
        }
      }
    }
  }

  // Check agent-registry for stale entries
  let staleRegistryCount = 0;
  for (const [key, entry] of Object.entries(memory)) {
    if (!key.startsWith('agent-registry')) continue;
    const value = typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
    if (value && value.status === 'running' && offlineAgents.has(key.replace('agent-registry.', ''))) {
      console.log(`  STALE REGISTRY: ${key} shows running but agent is offline`);
      if (!DRY_RUN) {
        value.status = 'dead';
        value.cleanedAt = new Date().toISOString();
      }
      staleRegistryCount++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Stale tabs released: ${staleTabCount}`);
  console.log(`Stale locks released: ${staleLockCount}`);
  console.log(`Stale registry entries fixed: ${staleRegistryCount}`);

  if (staleTabCount + staleLockCount + staleRegistryCount === 0) {
    console.log('\nNo orphan state found. All clean.');
  } else if (!DRY_RUN) {
    saveState(state);
  }
}

main();

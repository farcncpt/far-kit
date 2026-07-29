# Global MCP Servers — Reach For These First

The following MCP servers are available globally in every Claude Code session. **Use them before CLI or shell scripts.** Token cost is lower, failure rate is lower, behavior is more predictable.

## field-trip (Browser Automation) — PRIMARY BROWSER TOOL

Browser interaction — DOM scanning, clicking, typing, evaluation, spotlight overlays, annotations.

**Tool name:** `mcp__field-trip__browser`

**Use this first.** Do NOT default to `powershell.exe ... cli/tt.mjs` — that path should only be used when the MCP tool is unavailable.

Common patterns:
```
mcp__field-trip__browser({ action: "page" })                    // current tab
mcp__field-trip__browser({ action: "scan" })                    // list elements
mcp__field-trip__browser({ action: "navigate", params: { url } })
mcp__field-trip__browser({ action: "eval", params: { expression } })
mcp__field-trip__browser({ action: "click", params: { target } })
mcp__field-trip__browser({ action: "type", params: { selector, value } })
```

Full action reference: `~/.claude/rules/common/field-trip-testing.md`.
Source: `/mnt/c/Users/bubun/CascadeProjects/joyride-web-extension/`

## plugin_vercel_vercel (Vercel Management)

Deployments, env vars, build logs, domain config, project linking.

**Tool prefix:** `mcp__plugin_vercel_vercel__*`

**Use this first for:**
- Finding/listing deployments
- Checking build status + logs
- Reading env vars
- Managing domains

**Fall back to CLI** (`npx vercel@latest ...`) for:
- `vercel link` (project linking non-interactive)
- `vercel env add` (setting new vars — CLI handles stdin better)
- `vercel deploy --prod` (forcing a fresh deploy with existing commits)

**Never use WebFetch/curl** to check a deployed page — it misses client-rendered content. Use `mcp__field-trip__browser` for runtime verification.

Full verification protocol: `~/.claude/rules/common/vercel-verification.md`.

## plugin_neon-plugin_neon (Neon Postgres)

Projects, branches, databases, SQL execution, migration prep.

**Tool prefix:** `mcp__plugin_neon-plugin_neon__*`

Common tools:
- `list_projects` / `describe_project` / `create_project`
- `run_sql` / `run_sql_transaction`
- `get_connection_string`
- `describe_table_schema` / `get_database_tables`
- `prepare_database_migration` / `complete_database_migration`

**Gotcha:** MCP auth is tied to a specific Neon account/org. If a project lives in an inaccessible org (e.g., Vercel-provisioned DBs in Vercel's Neon workspace), fall back to direct SQL via `@neondatabase/serverless` + `DATABASE_URL`:

```
node -e "
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);
  sql\`SELECT * FROM users LIMIT 1\`.then(console.log);
"
```

## plugin_stripe_stripe (Stripe)

Payments, subscriptions, webhooks, customer management.

**Tool prefix:** `mcp__plugin_stripe_stripe__*`

Use for programmatic Stripe operations. CLI (`stripe`) is fine for listen/tail during local dev.

## agent-com (Agent Communication)

Inter-agent coordination — channels, shared memory, locks, messaging, artifacts.

**Tool prefix:** `mcp__agent-com__*`

Use for:
- Multi-agent orchestration and state coordination
- Tracked job assignments across sessions
- Shared memory for chrome-status, tab-ownership, locks

Common tools:
- `register_agent` / `unregister_agent` / `list_agents`
- `publish_to_channel` / `read_channel_messages`
- `write_memory` / `read_memory`
- `create_job` / `claim_job` / `complete_job`
- `share_artifact`

Source: `/mnt/c/Users/bubun/CascadeProjects/Truth-Seeker/agent-communication-mcp/`

## ai-project-planner (Persistent Project Planning)

Todos, decisions, documents, ideas, events, jobs, finance tracking — for work that **spans sessions** and must survive compaction.

**Tool prefix:** `mcp__ai-project-planner__*`

**Use this instead of TaskCreate/TaskUpdate** for anything multi-session. Planner todos persist; session tasks don't.

Common tools:
- `list_projects` / `set_active_project` / `get_active_project`
- `create_todo` / `toggle_todo` / `update_todo` / `list_todos`
- `create_document` / `list_documents`
- `create_decision` / `list_decisions`
- `create_agent_job` / `update_job_status`
- `global_search`

Source: `/mnt/c/Users/bubun/CascadeProjects/ai-project-planner/`
Platform: `https://faridea.dev`

## blofin (Cryptocurrency Trading)

**Tool prefix:** `mcp__blofin__*`

Only use when explicitly working on trading tasks. Never touch owner-placed orders without explicit instruction.

Source: `/mnt/c/Users/bubun/CascadeProjects/Crypto-chess-docker/`

---

## Tool-Selection Decision Tree

When you need to do X, ask in order:

1. **Is there an MCP tool for X?** → Use it.
2. **Is there a CLI for X that respects non-interactive flags?** → Use it.
3. **Do I need an ad-hoc shell script?** → Write a minimal one, not a full CLI wrapper.

If you find yourself writing `powershell.exe -NoProfile -Command "..."` to do something that an MCP tool already supports, stop and use the MCP tool.

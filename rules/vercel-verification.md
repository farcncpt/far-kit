# Vercel Deployment Verification Protocol

## The Rule

**You have not shipped until you have loaded the deployed URL and checked a concrete DOM marker that proves your change is live.**

A green `git push`, a passing local build, and Vercel saying "Ready" all look successful but don't prove the change landed. Only a live-page check against a specific marker proves it.

## Mandatory Verification Chain

Every time you push a change that's meant to be visible on a live Vercel deployment, run this chain in order:

### 1. Find the deployment

Use `mcp__plugin_vercel_vercel__*` tools to identify the latest deployment for the target project. Do not guess URLs — query the API.

```
// List deployments for the project, sort by createdAt desc, pick [0]
mcp__plugin_vercel_vercel__list_deployments({ projectId })
```

### 2. Wait for Ready state

Poll the deployment status until it reaches `READY` or `ERROR`. Use the Monitor tool or a short ScheduleWakeup — do NOT use `sleep` in Bash for periods over 2 seconds.

If state is `BUILDING` or `QUEUED`, wait and re-check.
If state is `ERROR`, fetch build logs via Vercel MCP, diagnose, fix, push, start over.

### 3. Load the production URL with field-trip

```
mcp__field-trip__browser({ action: "navigate", params: { url: "https://<prod>" } })
```

Then verify. Don't use `WebFetch` — it only returns pre-hydration SSR HTML and misses client-rendered content. Always use the MCP browser for anything that client-renders.

### 4. Assert a specific DOM marker

Pick a marker that proves the change is present. Examples:
- New headline text: `document.querySelector('h1')?.innerText === 'AI training for hands-on learners'`
- New button count: `document.querySelectorAll('button').length >= 12`
- New API route: `mcp__field-trip__browser` navigate to `/api/<route>` and eval `document.body.innerText`
- New element class: `document.querySelector('[data-variant]')?.dataset.variant === 'compact'`

Run the assertion via `mcp__field-trip__browser({ action: "eval", params: { expression: "..." } })`.

### 5. If the marker is absent

The deployment is live but your change didn't make it. Common causes:
- CDN cache — wait 30s then re-check
- Wrong deployment alias — production vs preview
- Build silently skipped your file — check Vercel build logs for warnings
- Env var missing — check function logs for runtime errors
- Import error — check typecheck locally

Never report success when the marker is absent. Report the gap, diagnose, fix, push again.

## Vercel MCP Tool Reference

Priority order for Vercel operations:

| Need | Tool |
|------|------|
| List/find deployments | `mcp__plugin_vercel_vercel__*` |
| Read env vars | `mcp__plugin_vercel_vercel__*` or `vercel env ls` CLI |
| Check build logs | Vercel MCP |
| Anything else | Vercel MCP before CLI |

Fall back to the Vercel CLI (`npx vercel@latest ...`) only when MCP tools don't cover the capability (e.g., `vercel link` for project linking, `vercel env add` for new vars).

## Anti-patterns (do not do these)

- ❌ Claiming success because `git push` succeeded
- ❌ Claiming success because local `pnpm build` passed
- ❌ Using `WebFetch` instead of `mcp__field-trip__browser` to check deployed pages
- ❌ Using `curl` to check a page and trusting the raw HTML
- ❌ Skipping the wait-for-ready step because "it usually builds in 30s"
- ❌ `sleep 60` in Bash to wait for a build — use Monitor or ScheduleWakeup

## One-call summary

Before every "✅ deployed" claim in chat, mentally ask:
> Have I opened the production URL in `mcp__field-trip__browser` and confirmed a specific marker proves the change is live?

If no: you have not shipped. Do the check first.

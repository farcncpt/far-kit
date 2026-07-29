---
name: Production Testing & Runtime Verification Gate
description: Runtime verification protocol for shipping features. Beyond type checks and unit tests — actually run the feature end-to-end in a browser, confirm user-visible behavior, and gate "done" on observed results. Prevents silent passes that mask real bugs.
when_to_use: shipping features, e2e testing, runtime verification, runtime gate, integration tests, visual verification, feature done criteria, "is this working", pre-merge checks, regression testing
---

# Production Testing & Runtime Verification Gate

**Core rule:** TypeScript and unit tests verify code correctness, not *feature correctness*. A feature is not "done" until the user-visible behavior is observed in a running system. No shortcuts.

## The Three Layers

```
┌──────────────────────────────────┐
│ 3. Runtime Verification (MUST)   │  Run it. See it. Confirm it works.
├──────────────────────────────────┤
│ 2. Integration Tests (SHOULD)    │  API → DB → response assertions.
├──────────────────────────────────┤
│ 1. Unit Tests (REQUIRED 80%+)    │  Pure functions, utilities, reducers.
└──────────────────────────────────┘
```

All three layers run before "done". If layer 3 fails, fix it before calling the task complete — even if layer 1 and 2 pass.

## Layer 1 — Unit Tests (80% coverage)

- Pure functions, reducers, validators, type guards
- Run on every commit via pre-commit hook or CI
- Vitest / Jest / whatever the project uses
- One assertion per concept — don't batch

## Layer 2 — Integration Tests

- API endpoints tested with real DB (ephemeral, not mocks for DB — mocks hide migration drift)
- Auth flows end-to-end
- Rate limiting actually fires
- Webhook signature verification
- For Neon: use branching for ephemeral test DBs

## Layer 3 — Runtime Verification (The Gate)

**Mandatory before declaring any UI feature done.** Steps:

### Step 1: Confirm the code is actually running

- Dev server is up (`curl` or `mcp__field-trip__browser page`)
- The commit you think you're testing is the commit that's serving
- HMR picked up your edit (WSL /mnt/c may need `CHOKIDAR_USEPOLLING=true`)
- **Verify the DOM reflects your change** — className, inline style, new element, etc. 

### Step 2: Exercise the golden path

- Click the button/link the user would click
- Scan or read DOM to see actual new state
- Compare observed state vs expected state
- Screenshot the result (via `field-trip-scanner` or Playwright)

### Step 3: Exercise one edge case

- Empty state
- Error state  
- Disallowed input
- Non-golden user flow that touches the same code

### Step 4: Regression check

- Click one unrelated feature touching adjacent code
- Confirm you haven't broken it

### Step 5: Test in the real deployment

- For Vercel: preview URL, not localhost
- Actually open the preview URL in a real browser tab (or use field-trip on it)

## Anti-Pattern: "Tests pass" ≠ "Feature works"

**Forbidden claims without runtime verification:**
- "The build passes so it works."
- "Typecheck is green so the fix is in."
- "Based on the code, it should work now."
- "The unit tests cover this."

These are all about code correctness. Feature correctness requires observation. If you write any of these phrases without having actually driven the feature in a browser, **stop and go run it**.

## Runtime Verification Checklist

- [ ] Confirmed dev server / preview is actually serving the target commit
- [ ] Observed new DOM reflects code change (className, attrs, new element)
- [ ] Drove golden path, saw expected end state
- [ ] Drove one edge case, saw expected end state
- [ ] Ran one unrelated feature, confirmed no regression
- [ ] Screenshot or DOM evidence captured (for handoff)

## Browser Verification Tools

Prefer these, in order:

1. **`mcp__field-trip__browser`** — Fast, relay-based, multi-tab, works with any running Chrome. See `field-trip-relay` skill.
2. **Playwright** — For reproducible CI tests, visual diffs, trace files. Use when you need artifacts.
3. **`field-trip-scanner`** — For full-page audits including accessibility, security, visual regression.

For rapid inner loop: `mcp__field-trip__browser` with scan/click/eval.
For CI: Playwright with trace files on failure.

## HMR Traps (WSL-specific)

Vite on WSL mounting /mnt/c from Windows does NOT get inotify file events. Symptoms:
- You edit a file, save it, browser doesn't update
- You verify the file on disk has the change, but DOM still shows old state
- No "hmr update" line in vite's stdout

**Fix:** Run vite with `CHOKIDAR_USEPOLLING=true` or add `server.watch: { usePolling: true }` to vite config. Or work inside WSL's native filesystem (~ or /home).

## When a Feature Silently Fails

If runtime behavior doesn't match code, check in order:
1. Is the new code actually loaded? (bundle cache, HMR miss, wrong dev server)
2. Is there a second copy of the module being loaded? (common with monorepos)
3. Is a previous tab holding stale state? (reload, incognito)
4. Is a middleware/interceptor changing the response?
5. Is the browser caching despite Cache-Control?

## Test Artifacts

Every runtime verification should produce at minimum:
- One DOM snapshot showing the final state
- One screenshot (if UI change)
- The exact sequence of user actions needed to repro

Store via `mcp__agent-com__share_artifact` so handoff to the next agent / developer is lossless.

## Integration with CI

Pre-merge gate:
```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e
```

Runtime verification doesn't replace CI — it adds a human/agent-observed check that CI can't do. CI ensures the code compiles and unit tests pass; runtime verification ensures the feature actually works.

## Related skills
- `browser-qa` — Broader visual testing / click walkthrough patterns
- `click-path-audit` — Systematic click-path debugging for regression finding
- `field-trip-relay` — MCP browser tool reference
- `visual-verification` — Screenshot-based visual diff verification
- `production-security` — Security gate (complementary to this testing gate)

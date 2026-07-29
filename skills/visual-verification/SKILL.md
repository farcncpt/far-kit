---
name: Visual Verification — Screenshots, Diffs, and Playwright
description: Screenshot-based visual verification of UI changes — Field Trip for fast local verification, Playwright for reproducible artifacts and visual regression diffs, pixel-diff tooling for regressions. The "did the UI actually change" layer of runtime verification.
when_to_use: screenshot, visual regression, visual diff, Playwright, visual verification, UI proof, pixel diff, before/after screenshots, evidence for handoff, visual test, ensure UI change visible
---

# Visual Verification — Screenshots, Diffs, Playwright

Verifying UI changes requires **visual evidence**, not just DOM assertions. A DOM scan can show `classList` changed but miss a z-index bug, a z-0 container, or an opacity-0 parent. Screenshots catch what DOM queries miss.

## Tool Ladder

| Goal | Tool | Why |
|------|------|-----|
| Fast inner loop — "did my edit take?" | `mcp__field-trip__browser` eval + screenshot | 1-2s per action, works on current Chrome |
| "Is this button actually clickable?" | `field-trip-scanner` interaction audit | Detects obscured elements, hit-testing |
| Reproducible CI artifact | Playwright + trace | Stored trace file, time travel |
| Visual regression | Playwright snapshot testing | Pixel diff vs committed baseline |
| Accessibility audit | `field-trip-scanner` WCAG mode | Color contrast, ARIA, keyboard nav |

## Fast Path — Field Trip MCP

For rapid "prove it works" checks during development:

```
mcp__field-trip__browser({
  action: "eval",
  params: {
    tabId: 704450533,
    expression: "document.querySelector('.target').getBoundingClientRect()"
  }
})
```

For a screenshot of an element:
```
# Use field-trip-scanner skill for the screenshot command — it's one of the sub-skills
# Or via relay CLI fallback: ft screenshot -s "#target" -c "caption"
```

Scan with image output is in `field-trip-scanner`. See that skill for full command set.

## Playwright — When You Need Artifacts

Use Playwright when you need:
- **Reproducible tests** that CI can run
- **Trace files** for debugging failures (time-travel UI)
- **Visual regression** via committed snapshots
- **Cross-browser testing** (chromium, firefox, webkit)
- **Mobile viewport testing**

### Install

```bash
pnpm add -D @playwright/test
pnpx playwright install chromium
```

### Minimal Test Structure

```ts
// tests/e2e/opex-library-open.spec.ts
import { test, expect } from '@playwright/test'

test('opens library entry and renders canvas', async ({ page }) => {
  await page.goto('http://localhost:5173')
  await page.click('text=Open project library')
  await page.click('[data-test="library-card-escalations"] button:has-text("Open")')
  await expect(page.locator('.designer')).toBeVisible()
  await expect(page.locator('[data-testid^="rf__node"]')).toHaveCount(6)
})
```

### playwright.config.ts Essentials

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',       // time-travel debugger for failed tests
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
  },
  expect: {
    toHaveScreenshot: { maxDiffPixels: 100 },
  },
})
```

### Visual Regression Snapshots

```ts
test('library page visual', async ({ page }) => {
  await page.goto('/')
  await page.click('text=Open project library')
  await expect(page).toHaveScreenshot('library-page.png')
})
```

First run creates the baseline. Subsequent runs fail if pixels differ. Commit baselines to git. Use `--update-snapshots` to regenerate after intentional UI changes.

## Screenshot Best Practices

### Wait for the UI to settle
```ts
await page.waitForLoadState('networkidle')
await page.waitForSelector('.designer:not([aria-busy="true"])')
```

Without this, screenshots capture mid-transition states and cause flakiness.

### Hide or stabilize dynamic content
```ts
// Mask timestamps, animations, cursors
await expect(page).toHaveScreenshot({ mask: [page.locator('.timestamp')] })

// Disable animations via CSS injection
await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' })
```

### Element screenshots over full-page
Full-page screenshots break when anything shifts. Element screenshots are surgical:
```ts
await expect(page.locator('.card')).toHaveScreenshot('card.png')
```

## Visual Proof for Handoff

Every feature ship / bug fix should produce:

1. **Before/after screenshot pair** in the PR description
2. **Annotated** — circle the changed area, callout key differences
3. **Stored in agent-com artifacts** for cross-session access:
   ```
   mcp__agent-com__share_artifact({
     name: "opex-canvas-fix-before-after",
     path: "/tmp/opex-canvas-fix.png",
     tags: ["opex", "visual-proof", "canvas"]
   })
   ```

## Catching "Looks Right But Broken" Bugs

Runtime bugs that pass DOM checks:
- **z-index issues** — element exists but hidden behind modal
- **opacity: 0** or `visibility: hidden` on a parent
- **clip-path** or `overflow: hidden` clipping content
- **pointer-events: none** — element visible but not clickable
- **Tailwind class not emitted** — class applied but no matching CSS rule

Detect via:
```ts
// Hit test + bounding box + computed style
const box = await page.locator('.target').boundingBox()
const visible = await page.locator('.target').isVisible()
const clickable = await page.locator('.target').isEnabled()
```

For complete visual truth, take a screenshot and eyeball it. DOM queries lie; pixels don't.

## Debugging Flaky Visual Tests

1. **Open the trace file** — `pnpx playwright show-trace test-results/.../trace.zip`
2. **Time travel** through every action to see what the page looked like
3. **Check for animations** — add the global animation disable
4. **Check for viewport differences** — CI may run at different DPR
5. **Check fonts** — fall back to system fonts in tests for stability

## CI Integration

```yaml
- run: pnpx playwright install --with-deps chromium
- run: pnpm test:e2e
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: playwright-trace
    path: test-results/
```

Failed tests upload trace artifacts for post-mortem. Don't try to debug in CI logs — download the trace and open it.

## Don't Do These

- Screenshot full viewport and commit as baseline — one font tweak = all tests red
- Take screenshots inside flaky selectors (e.g. right after a network request) — wait first
- Compare screenshots pixel-perfect across OS — use `maxDiffPixels` or `maxDiffPixelRatio`
- Skip snapshot review — always diff the baseline change in PRs

## Related skills
- `field-trip-scanner` — Comprehensive audit tool with screenshots
- `field-trip-relay` — Fast screenshot access via relay
- `production-testing` — Runtime verification gate (this fits inside it)
- `browser-qa` — Broader visual QA patterns
- `click-path-audit` — Systematic visual verification of click paths

---
name: Field Trip Security & Accessibility Scanner
description: Production-grade scanning suite — OWASP security audit, penetration testing, WCAG accessibility, design consistency. False-positive-reduced with SDK allowlists, ancestor background walking, and auth-aware scoring.
when_to_use: security audit, OWASP scan, penetration test, WCAG contrast, accessibility scan, SEO check, client report, broken links, inline scripts, CSP analysis, XSS detection, auth bypass, injection patterns, site audit
source: joyride-web-extension/src/skills/field-trip-scanner.json v2.0.0
---

# Field Trip Security & Accessibility Scanner

Three production-grade scanners — security, penetration test, DOM audit — wired into the Field Trip MCP. Each is tuned to minimize false positives via SDK allowlists, ancestor background walking, and auth-aware scoring so reports are actionable instead of noisy.

Call them via `mcp__field-trip__tools`:

```
mcp__field-trip__tools({ action: "security", params: { tabId } })
mcp__field-trip__tools({ action: "pentest",  params: { tabId, project? } })
mcp__field-trip__tools({ action: "dom_audit", params: { tabId, checks? } })
```

## Scanner 1 — Security (`security-audit.mjs`)

OWASP-style security audit of the current page.

### Checks
- Exposed secrets (21 patterns + SDK allowlist)
- Authentication issues
- Input validation
- Mixed content
- Cookie security (SDK cookie detection)
- Client-side storage inspection
- DOM XSS indicators (Next.js hydration aware)
- Security headers (CSP quality analysis)
- Information disclosure
- Clickjacking protection

### False positive reductions
These are quality-of-life tunings that drop noise without missing real issues:

- **Stack Auth / Clerk / Firebase localStorage keys** → `INFO` severity (known-safe framework storage)
- **Heroku UUID pattern** narrowed to require the `heroku` keyword nearby
- **Next.js `__NEXT_DATA__` scripts** skipped in innerHTML scan
- **`dangerouslySetInnerHTML`** downgraded to `LOW` when sanitization is detected
- **Platform server headers** (Vercel/Cloudflare) → `INFO`
- **SDK cookies** (`__stripe`, Stack Auth) → `LOW`

## Scanner 2 — Pentest (`pentest-audit.mjs`)

Runtime penetration-test style checks with auth awareness.

### Checks
- XSS indicators (Next.js bundle aware)
- CSRF validation
- **Auth bypass analysis** (auth-aware scoring)
- SQL injection patterns (Next.js bundle aware)
- File upload validation
- Session/cookie security (SDK aware)
- Directory traversal
- Information leakage
- Security headers
- Auth config (Truth-Seeker integration)

### Truth-Seeker integration
Adds static env-var verification via a Rust binary:

- **Flag:** `--project <path>`
- **Checks:** Missing auth secrets (`AUTH_SECRET`, `STRIPE_WEBHOOK_SECRET`, etc.)
- **Binary:** `Truth-Seeker/rust/target/release/truth-seeker.exe env-check`

### Auth-aware scoring
When the user is authenticated (session cookie or token detected), findings about admin routes and internal API endpoints are downgraded to `INFO` — they're expected to be reachable for signed-in users, not a vulnerability.

**Detection:** Checks cookies and localStorage for `session` / `token` / `auth` patterns.

## Scanner 3 — DOM Audit (`dom-audit.mjs`)

Accessibility, design, and site-health audit.

### Checks
- **WCAG color contrast** (ancestor background walking — see below)
- Broken / dead links
- Accessibility (missing aria, roles, labels, heading order)
- Security (inline scripts, mixed content, exposed data)
- Design consistency (font / size / color palette analysis)
- Form validation (missing types, required, maxlength)
- Image issues (broken src, missing alt)
- Metadata (title, description, OG tags)

### Contrast algorithm (why it's better than most)
Most contrast scanners produce false positives because they read the element's own background color — which is often `transparent` on the actual text element. This scanner walks up the DOM ancestor chain to find the actual visible background color.

**Handles:**
- Transparent backgrounds
- `rgba` with alpha blending
- Inherited backgrounds
- Dark/light theme detection

**Eliminates:** False positives from elements inheriting parent backgrounds.

## Scoring Formula

```
score = 100 - (critical*15) - (high*8) - (medium*4) - (low*2) - (info*0)
```

### Severity levels
`critical` · `high` · `medium` · `low` · `info`

**`info`** is the key level for platform-controlled or known-safe items — it's recorded in the report but deducts zero points.

## Planned — Client Report Generator

Not yet built but mapped out:

- Unified `site-audit.mjs` combining all 3 scanners
- HTML / PDF branded report generation
- Fix suggestion engine per finding
- Multi-page auto-crawl from sitemap / nav
- Before/after comparison mode
- API endpoint for programmatic auditing

## Related skills
- `field-trip-relay` — the MCP tool that dispatches the scanners
- `agent-orchestration` — tier 4 browser agents that invoke these scanners safely

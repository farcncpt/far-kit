---
name: Production Security Checklist
description: Ship-readiness security checklist — secrets management, input validation, auth, rate limiting, CSRF/XSS/SQLi/SSRF defense, PII handling, dependency audit. Gates on every production deploy. Operational-grade, not documentation theater.
when_to_use: shipping to production, security review, OWASP, pre-deploy audit, secrets, auth, rate limiting, PII, CSRF, XSS, SQL injection, SSRF, security checklist, ship-readiness, production-grade
---

# Production Security Checklist

**Rule:** Every deploy to production runs this checklist. No exceptions. If you can't answer "yes" to every item, do not ship.

## 1. Secrets

- [ ] **No secrets in the repo** — grep for `sk_`, `api_key`, `password`, `secret`, `token`, `Bearer ` in tracked files
- [ ] **`.env.example` is checked in; `.env.local` is in `.gitignore`**
- [ ] **All required secrets validated at startup** — crash loud, not silent, on missing env var
- [ ] **Rotate any secret that was ever committed** — git history is permanent, a `git rm` does not unrotate
- [ ] **Production secrets never echo to logs** — scrub in logger middleware, Sentry beforeSend, etc.
- [ ] **Service account / API keys are scoped minimum** — no root API keys for a single-purpose integration
- [ ] **Use Vercel/Cloud secret manager where possible** — not hand-pasted env vars

## 2. Input Validation

- [ ] **Every API route validates input with a schema** — Zod, valibot, io-ts, not hand-rolled
- [ ] **Return structured errors** — don't leak Zod path in prod, but log full detail server-side
- [ ] **Validate at boundaries** — user input, external API responses, file uploads, webhook payloads
- [ ] **Never trust client-computed values** — pricing, ownership, IDs must be re-checked server-side

## 3. Authentication

- [ ] **Session tokens are httpOnly + Secure + SameSite=Lax or Strict**
- [ ] **Passwords hashed with argon2id or bcrypt (cost ≥ 10)** — never MD5/SHA1/plain
- [ ] **Password reset tokens expire ≤ 1h** and are single-use
- [ ] **Rate limit failed login attempts** — protect both username and IP
- [ ] **Email verification required** before any privileged action (if email-based signup)
- [ ] **Signup has bot protection** — Turnstile, hCaptcha, BotID, or similar
- [ ] **MFA available for high-value accounts** even if not required
- [ ] **Session expiry is enforced server-side** — don't trust client clocks

## 4. Authorization (IDOR Defense)

- [ ] **Every record read/write checks ownership** — `WHERE id=$1 AND user_id=$2`, never just `WHERE id=$1`
- [ ] **Enrollment/membership checks before viewing "enrolled" resources** (courses, lessons, workspaces)
- [ ] **Row-level security (RLS) enabled** when using Postgres/Neon — belt and suspenders
- [ ] **Admin endpoints require separate role check** — not just auth
- [ ] **No "accept any UUID" endpoints** — always validate against caller's scope

## 5. Rate Limiting

- [ ] **All unauthenticated endpoints rate limited by IP**
- [ ] **All authenticated endpoints rate limited by user_id + IP**
- [ ] **AI endpoints tiered by plan** — free/basic/pro have different budgets
- [ ] **Expensive endpoints (image gen, long-running queries) have stricter limits**
- [ ] **Rate-limit storage is distributed** — Upstash Redis, not in-memory (won't work across serverless instances)
- [ ] **Returns 429 with `Retry-After` header**, not 500

## 6. XSS / CSRF / Clickjacking

- [ ] **Content-Security-Policy header set** — restrict script sources
- [ ] **HTML user content sanitized** — DOMPurify or framework default; never use `dangerouslySetInnerHTML` on user input
- [ ] **CSRF tokens on state-changing form submissions** — or SameSite=Strict cookies
- [ ] **X-Frame-Options: DENY** (or frame-ancestors CSP directive)
- [ ] **Referrer-Policy: strict-origin-when-cross-origin**

## 7. Injection

- [ ] **All DB queries parameterized** — never string-concat user input
- [ ] **Use an ORM or query builder** (Drizzle, Prisma, Kysely) not raw strings
- [ ] **Shell commands avoid user input** — or use safe exec with arg array, never shell=true
- [ ] **Template rendering escapes by default** — no unescaped user content in HTML/JSON/SQL/shell

## 8. SSRF / URL Handling

- [ ] **User-supplied URLs blocked from private networks** — 127.0.0.1, 169.254.*, 10.*, 192.168.*, metadata services
- [ ] **DNS rebinding defense** — resolve then validate, don't trust hostname
- [ ] **Redirect allowlist on OAuth/auth flows** — no open redirects
- [ ] **File uploads validate content-type AND magic bytes** — not just extension

## 9. PII / Data Protection

- [ ] **PII scrubbed from Sentry/logs** — emails, IPs, SSNs, addresses
- [ ] **Privacy Policy lists every subprocessor** — CCPA + GDPR require this
- [ ] **DB fields for sensitive data are encrypted at rest** — access tokens, SSN-like IDs
- [ ] **GitHub OAuth tokens encrypted at rest** — not just env-var-protected
- [ ] **User deletion actually deletes** — hard delete or soft delete + 30-day purge
- [ ] **Export endpoint provides user data download** — GDPR requirement for EU users

## 10. Dependencies

- [ ] **`pnpm audit` / `npm audit` clean** on production deps (dev deps less critical)
- [ ] **No unmaintained packages** — check last publish date, open issues
- [ ] **Lockfile committed** — `pnpm-lock.yaml` / `package-lock.json`
- [ ] **Dependabot/Renovate enabled** on the repo
- [ ] **Supply chain risk reviewed** — postinstall scripts audited, typosquat check

## 11. Deployment Surface

- [ ] **Preview deploys are not publicly discoverable** — password-protected or noindex
- [ ] **Staging data is NOT production data** — or properly anonymized
- [ ] **Backup strategy defined and tested** — untested backups don't exist
- [ ] **Rollback path documented** — how to revert in <5 min
- [ ] **Health/status endpoint exposed** — for monitoring
- [ ] **Feature flags available for risky launches** — kill switch without redeploy

## 12. Compliance Adjacent

- [ ] **Terms of Service updated** for subscription/billing (ARL if CA-touching)
- [ ] **Privacy Policy includes GDPR + CCPA language**
- [ ] **Cookie banner if tracking EU users**
- [ ] **Support email responds** — billing@, privacy@, legal@

## Pre-Deploy Command Sequence

```
pnpm typecheck
pnpm lint
pnpm test
pnpm audit --prod
# Grep for secrets
grep -r "sk_live\|api_key\|BEGIN.*PRIVATE KEY" --include="*.ts" --include="*.js" --include="*.json"
# Check .env not tracked
git ls-files | grep -E "\.env$|\.env\.local"
```

All green = proceed. Any red = stop.

## Incident Response

If a secret leaks:
1. **Rotate immediately** — don't wait to investigate
2. **Revoke old token** at the provider
3. **Check access logs** for unauthorized use
4. **Disclose to affected users** if their data was exposed
5. **Post-mortem** with root cause and prevention

## Related skills
- `production-testing` — Runtime verification gate, complementary to this security gate
- `design-principles` — Core design principles including "validate at boundaries"
- `autonomous-dev-workflow` — How security gates fit into the self-driving dev loop

# Testing Requirements

## Runtime Verification Protocol (MANDATORY)

**Never claim a feature works without loading it in a running environment.**

Unit tests passing + build passing + push succeeded is NOT the same as "it works". Before reporting success on any user-visible change, do one of:

1. **For deployed changes (Vercel/etc)**: follow `vercel-verification.md` — open the production URL via `mcp__field-trip__browser` and assert a concrete DOM marker proves your change is live.
2. **For local changes**: open the running dev server in `mcp__field-trip__browser` and assert the same.
3. **For API-only changes**: hit the endpoint (via `mcp__field-trip__browser` navigate or `fetch` in eval) and verify the response shape + status.
4. **If none of the above is possible**: explicitly state "I have not verified this in a running environment" in your final response. Never imply success.

## Minimum Test Coverage: 80%

Test Types (ALL required):
1. **Unit Tests** - Individual functions, utilities, components
2. **Integration Tests** - API endpoints, database operations
3. **E2E Tests** - Critical user flows (framework chosen per language)

## Test-Driven Development

MANDATORY workflow:
1. Write test first (RED)
2. Run test - it should FAIL
3. Write minimal implementation (GREEN)
4. Run test - it should PASS
5. Refactor (IMPROVE)
6. Verify coverage (80%+)

## Troubleshooting Test Failures

1. Use **tdd-guide** agent
2. Check test isolation
3. Verify mocks are correct
4. Fix implementation, not tests (unless tests are wrong)

## Agent Support

- **tdd-guide** - Use PROACTIVELY for new features, enforces write-tests-first

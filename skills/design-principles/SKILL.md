---
name: Design Principles for Production-Grade Code
description: Core design principles that scale a codebase without breaking it — immutability, validation at boundaries, small files, no premature abstraction, DB-driven content, assemble-on-demand architecture. Opinions codified to prevent rework.
when_to_use: architectural decision, design review, refactor, new feature design, premature abstraction, file organization, DB-driven, content vs runtime, state management, reducer pattern, why am I rewriting this, platform design
---

# Design Principles for Production-Grade Code

These are the principles that make a codebase **extendable without breaking**, **testable without mocks everywhere**, and **handoff-able without tribal knowledge**. Codified here so we stop re-deciding.

## 1. Immutability (MANDATORY)

Never mutate; always return new. This eliminates whole classes of bugs: stale references, hidden side effects, hard-to-test code.

```ts
// ❌ Wrong — mutates
function addItem(cart, item) {
  cart.items.push(item)
  return cart
}

// ✓ Right — new object
function addItem(cart, item) {
  return { ...cart, items: [...cart.items, item] }
}
```

Applies to: state stores, reducers, API payloads, function arguments. Exceptions: tight inner loops where profiling proves mutation is needed.

## 2. Validate at Boundaries

Trust internal code. Validate at the edges.

**Boundaries:**
- User input (forms, query params, URL segments)
- External API responses
- File uploads
- Webhook payloads
- Database results (when the shape could drift from the type)

**Not boundaries:**
- Function calls within the same module
- State store reads
- Internal type-safe operations

Over-validation internally adds noise without safety. Under-validation at edges lets bad data poison the system.

## 3. Many Small Files > Few Large Files

- **Sweet spot:** 200–400 lines per file
- **Hard cap:** 800 lines — refactor if larger
- **High cohesion per file:** one concept, one thing that changes for one reason
- **Organize by feature, not by type:** `features/auth/*` beats `controllers/ / services/ / models/`

Why: small files load faster into agent context, easier to review, easier to delete when obsolete.

## 4. No Premature Abstraction

Three similar lines is not a reason to make a helper. Five similar files is. If you're extracting a "generic utility" you used in one place, stop.

**Forbidden:**
- Helper functions called once, defined far from the caller
- "Configurable" APIs with parameters nobody uses
- Base classes with one subclass
- `any` or `unknown` "for flexibility"
- Feature flags for features that are already enabled everywhere

**Allowed:**
- Inline the 3 similar lines, they're clearer
- Extract on the 5th duplication, not the 2nd

## 5. No Error Handling for Scenarios That Can't Happen

Trust internal function guarantees. Don't null-check a value from a constructor you just called. Don't wrap a pure function in try/catch.

**Do wrap:**
- External API calls
- File I/O
- User input parsing
- Anything that crosses a process boundary

**Don't wrap:**
- Pure functions you own
- Array operations on arrays you just built
- Values returned by type-guaranteed functions

## 6. Write Code For the Reader, Not the Compiler

Well-named identifiers are documentation. Comments are for *why*, not *what*.

**Good comment:**
```ts
// Fall back to user's timezone when booking in a past local time —
// prevents "you booked at 3am" edge case from daylight saving.
const effectiveZone = pastLocalTime ? user.zone : booking.zone
```

**Bad comment:**
```ts
// Loop over items
for (const item of items) { ... }
```

If removing the comment wouldn't confuse a future reader, don't write it.

## 7. Default State Flows Down, Events Flow Up

- Parents own state
- Children render state + emit events
- No two-way data binding unless the primitive requires it (form inputs)
- Zustand / Redux stores are fine — but one store per domain, not one god store

## 8. DB-Driven Content vs Code-Driven Runtime

The principle that rewrote StackDive: **content belongs in the DB, runtime logic belongs in code**.

- **Runtime:** reducers, renderers, UI components, validation — in code, versioned with git
- **Content:** lessons, prompts, scenarios, prices, feature flags — in DB, editable without redeploy
- **Boundary:** a clean interface where code reads content (not both)

Benefits:
- Content updates don't need code deploys
- Agents can auto-update content when source material changes
- Non-developers can edit content
- One code deploy serves many content variants

Applies to: LMS lessons, AI tool simulators, pricing pages, documentation tours, form schemas.

## 9. Import Once, Assemble on Demand

Don't duplicate the same record 10 times for 10 scenarios. Import once into a normalized table and compose what's needed:

- **Skills library** → assembled into **courses** per learner
- **Blueprint registry** → composed into **processes** per workspace  
- **Tool registry** → wired into **agents** per team

When a user sees a "course", it's a live assembly, not a stored copy. When the library updates, every assembly reflects the new version on next view.

## 10. Observation-First Debugging

Before fixing a bug, confirm you understand:
1. **What the user did** (exact click path)
2. **What they saw** (DOM snapshot, screenshot)
3. **What the code did** (logs, state at that moment)
4. **What the expected behavior is** (written down, so you don't moving-target yourself)

Never fix a bug you haven't observed. "It might be X, let me patch X" is how regressions happen.

## 11. One Feature Flag, Not Fifty

Feature flags are a loan you pay interest on. Every flag = a test matrix explosion + dead branches + stale UX.

- Use for canary rollouts (days, not months)
- Remove when fully rolled out or fully rolled back
- Never use to "keep both paths alive just in case"

## 12. Prefer Battle-Tested Libraries Over Hand-Rolled

Before writing your own:
1. Search npm / registries
2. Check GitHub for adapters
3. Look at what the ecosystem uses

Hand-rolling a JWT lib, a rate limiter, a caching layer, a validation DSL, a date-time parser — almost always a mistake unless you have a specific performance constraint existing libs can't meet.

## 13. Test the Public Contract, Not the Implementation

Tests that break when you refactor internals are a liability. Tests should lock in **what the thing does for the caller**, not how it does it.

Good test: "calling `createUser({email, name})` returns a user with an id and creates one row in users."
Bad test: "calling `createUser` invokes `hashPassword` which invokes `argon2id.hash`."

## 14. Choose Readability Over Cleverness

Clever code is a loan you pay when you come back to read it. If a junior dev would struggle to read it, rewrite it as boring code.

## Related skills
- `coding-standards` — Mechanical rules (formatting, naming)
- `production-security` — Security gates (complementary)
- `production-testing` — Runtime verification gates (complementary)
- `autonomous-dev-workflow` — How these principles drive the self-driving dev loop

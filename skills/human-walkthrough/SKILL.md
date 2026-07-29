---
name: human-walkthrough
description: Human-centric E2E walkthrough methodology. Use when walking through an app as a real user, evaluating UX/flow quality or design craft, or doing experience-level E2E testing via the field-trip relay or any browser/computer-use harness. Enforces strict human-fidelity interaction, a pre-flight attention briefing, walk-type-dependent perception (pixels-first for judgment, DOM-first for regression), usability + craft/desirability watch-lists, effort accounting, and flow-map friction findings.
---

# Human Walkthrough — Human-Centric E2E

Everything else in the toolkit verifies that an app *functions* (DOM markers, a11y scans,
relay evals). This skill verifies that a person can actually *get through it* — without
confusion, extra steps, or loops. It is a methodology layer: it composes `field-trip-relay`
and the agent-tools; it does not replace them.

The two failure modes this skill exists to kill:

1. **Agent-vision testing** — the agent "walks" the app via querySelector and deep URLs,
   so it never experiences the confusion a human would. Result: "works perfectly" reports
   for flows that lose real users.
2. **Retroactive judgment** — the agent walks first, then gets asked "was the button
   placement intuitive?" and has to re-walk (or worse, guess). Attention must be set
   BEFORE the walk. One primed pass costs a fraction of walk + re-walk.

---

## Phase 0 — Pre-Flight Briefing (never skip, never browser-first)

Write the briefing down (in your response or a scratch note) BEFORE any browser action.
This is the frame-of-mind contract: what you decide to watch for here is what you will
actually notice during the walk.

**Briefing template:**

1. **Persona** — pick an archetype, then localize it to this app's real audience.
   Archetypes: first-time visitor with zero context · returning customer ·
   task-driven admin/owner · impatient mobile user · link-holder (arrived via a
   shared/pasted link) · screen-reader user.
   Localized example (BYB): "choir organizer whose director texted her a /s/ link."
2. **Goal** — one sentence. The thing the persona actually wants, in their words.
3. **Entry point** — where this persona would *really* land. Home for browsers; the
   pasted link for link-holders; the login page for admins. Never "the page under test."
4. **Watch-list** — the specific evaluation targets for THIS walk (see standing list
   below, plus anything the user asked for). Write each as a question you will answer.
5. **Click budget** — before walking, estimate the minimum plausible interactions
   (clicks + fields + scrolls) from entry to goal. You will compare against actuals.
6. **Success criteria** — how you'll know the persona succeeded (and what "abandoned"
   looks like).

**If invoked interactively and the user gave no watch-list:** ask ONE short question
before starting — "anything specific you want judged on this walk?" Asking before costs
one question; asking after costs a full re-walk.

**Standing watch-list A — usability (always on, every walk):**

- **Orientation contract (the four arrival questions)** — on every screen, within the
  5-second window: (1) Where am I — in the app AND in time relative to now? Flag any
  default view anchored to the data's latest row instead of the persona's now
  ("most recent" impersonating "current" is a severe finding). (2) What is this
  showing me, and is it current — does stale content announce its staleness?
  (3) What am I here to do, and is that the most prominent thing — and when the
  intent can't be fulfilled, does the screen say so honestly and offer the repair?
  (4) Where do I go next and how do I get back — are there silent redirects that
  skip a hierarchy level, or questions the system knows have no valid answer?
- **Intent-shaped vs schema-shaped** — does this surface serve an arrival intent
  (a situation with a time anchor and a job), or is it a viewer for a database
  table? Navigation named after entities, every-entity-gets-a-page structure, and
  detail views with no index are the tells.
- **Element belonging & redundancy** — does every element justify itself against this
  screen's primary intent? Each duplicate path to a task must serve a distinct arrival
  context (device, input mode, expertise, in-flow moment) under the SAME name. Two
  simultaneously visible nav systems, one destination under two names, or a mobile
  pattern rendering on desktop (responsive alternates must REPLACE, not add) are
  findings.
- **Chrome fit (one reference frame)** — content area must equal viewport minus chrome
  in one shared calculation: no content clipped/overflowing under fixed headers
  (100vh-under-header bug), no dead gulf between a viewport-pinned sidebar and
  separately-centered content, scroll owned by the content region when chrome is
  fixed. Check at the persona's viewport AND once at a wide viewport.
- **Scroll surfaces** — count the scrollbars visible per screen and name each one's
  owner. More than one scrollbar per axis for overlapping content = finding (usually a
  sizing bug wearing an `overflow: auto` bandage — cite the chrome-fit law). On dark
  themes, check scrollbar theming: a bright-white OS scrollbar mid-screen is a
  TRUST-EROSION finding (it's typically the highest-contrast element on the page).
  Run the scroll-trap test: wheel over each region — does the page stop moving because
  a nested area swallowed the event?
- **Location logic** — is each control where the persona's eyes go next? Does the layout
  match the reading order of the task?
- **State-timing** — do controls appear/enable at the moment they become relevant?
  A button that is visible but disabled with no explanation, or an action that only
  appears after an unrelated step, is a finding. The position of a control relative to
  *when* it becomes usable must make sense.
- **Proportionate effort** — count every click, field, and scroll, but judge against the
  task's weight, not raw minimization: unexplained effort is friction; ceremonial effort
  (a review step before payment, confirmation before deletion, paced onboarding) is
  craft. Scrolling a marketing page is not a cost. Flag effort the design cannot
  justify — not effort per se.
- **Flow-map integrity** — no loops (screen A → B → A with no progress), no dead ends,
  no orphan pages, back button behaves.
- **The 5-second question, by genre** — task screens must answer "what do I do next?"
  within ~5 seconds (Krug); brand/marketing surfaces must answer "what is this, and do
  I trust it?" in the same window. Ask the right one.
- **Copy comprehension** — would the persona understand each label/heading/error with
  zero product context? Quote confusing copy verbatim in findings.
- **Error recovery** — when the persona does the wrong thing, does the app say what
  happened and how to fix it? (Nielsen: visibility of status, recognition over recall.)

**Standing watch-list B — craft/desirability (always on for judgment walks):**

- **First impression** — on each template's first capture, before reading anything in
  detail: the three things noticed first; the product in one sentence; one feeling word
  (premium / friendly / clinical / cluttered / cheap). If the first-noticed elements
  aren't the most important ones for the persona, that's a hierarchy finding.
- **Visual hierarchy (squint test)** — from the screenshot, the three most visually
  dominant elements (size × weight × contrast × position) vs the three most important
  things for the task. Mismatch = finding.
- **System consistency** — run the Tier-1 sweeps (type ramp, spacing base unit, color
  count + semantic consistency): does this look designed by one hand?
- **Trust signals / craft-breakers** — default favicon, placeholder text, stretched or
  low-res images, mixed icon sets, browser-default controls inside custom UI, FOUC or
  layout shift on load, gray-toast success states. Individually trivial; collectively
  the difference between product and prototype.
- **Motion** — do state changes transition at all (instant DOM swaps feel cheap)? Are
  durations in a consistent band? Does motion explain where things came from and went?
  Where the harness can't judge it, log "motion unevaluated" — silence never reads as
  "fine."
- **Emotional arc** — name the persona's expected state at each step (curious →
  confident → committed → rewarded) and check the screen supports it. Two mandatory
  checkpoints: the highest-stakes step must feel *safe*, and the success state must
  feel like a peak — success states always get their own screenshot judgment.
- **Density/whitespace by genre** — one clear focal point per viewport? Dashboards earn
  density; marketing and onboarding must breathe.
- **Empty/loading/error states as designed moments** — deliberately visit them (fresh
  account, forced error): designed with guidance and tone, or blank divs and default
  spinners? These states are where design intent dies first.
- **Brand voice** — collect all microcopy encountered during the walk; at the end ask:
  could every sentence have been written by the same character? Flag register breaks
  and unbranded library defaults ("An error occurred. Please try again.").

If a design brief exists for the product (see the `design-intent` skill), it is the
ground truth for list B: judge against the brief's feel-words and anti-adjectives, not
against generic taste.

---

## Phase 1 — Human-Fidelity Rules (STRICT)

These are hard rules during a walkthrough. Breaking one invalidates the walk.

- **Perceive like a human — via the perception ladder (see below).** Structured
  perception (DOM geometry + semantics) is the default sense; screenshots are the
  arbiter, escalated to only on specific triggers. Read the screen top-to-bottom like
  first-time eyes before deciding anything, whichever tier you're perceiving with.
- **Act only on what is visible.** Click by visible text/role. Type into fields you
  found by looking. If you can't see it, you can't use it.
- **No teleporting.** No navigating to deep URLs unless the persona plausibly holds
  that link (a link-holder persona pasting `/s/gateway-choir` is legitimate; jumping
  to `/checkout?step=3` is not).
- **Eval is read-only.** `eval`/DOM tools are for observation and assertion
  (textContent, counts, computed styles) — never for setting state, dispatching
  synthetic events to skip UI, or mutating the page.
- **Mechanical exception (relay reality):** driving a React input via native setter /
  `__reactProps` onChange is permitted ONLY on the exact field a human would use, with
  the exact value they would type. It emulates keystrokes, not teleportation. (Use this
  because `tt-type.mjs` is unreliable — see field-trip-relay skill.)
- **If you're stuck, the persona is stuck.** Being unable to find the next step IS a
  finding (usually a BLOCKER) — not a reason to cheat past it. Log it, then and only
  then you may consult code/DOM to *describe* what the user couldn't find, and resume
  from where a human who finally found it would be.
- **One persona, one journey, per walk.** Don't blend goals mid-walk. Run a second
  briefing + walk for a second persona.

### The Perception Ladder (perception is walk-type-dependent)

Screenshots are heavy; DOM perception is cheap but constitutionally blind to how a
screen *feels* — and **you cannot doubt what you never perceived**: an escalate-on-doubt
rule can never fire for aesthetic failures a DOM walk never sensed. So the primary
sense depends on the walk type (see Model Calibration):

**Judgment walks: pixels-first at impression points.** Impressions form from
screenshots, never from DOM. Capture at: first arrival on each distinct page template;
each meaningful state of a template (empty, filled, error, and success — success states
always get a dedicated capture); imagery/compositional and DOM-blind regions
(canvas/WebGL, photos); the flow's highest-stakes step. Between impression points,
structured tools handle step mechanics (`visual_diff` for "did it respond") — but any
*aesthetic* claim in the report must trace to pixels.

**Regression re-walks and mechanical sweeps: structured-first.** These verify against
an existing rubric rather than form impressions — DOM geometry + semantics (`scan`,
`a11y_tree`, `describe_region`, rects + computed styles via read-only eval) carry the
walk; screenshots only to arbitrate a suspected regression or evidence a finding. This
is where the volume lives, so this is where the token savings live.

**The measurement layer (all walk types).** Structured tools quantify what pixels
suspect, and run cheap standing sweeps that need no screenshots at all: distinct font
families/sizes/weights per screen (>2 families or ~6 unrelated sizes = ad-hoc type);
spacing values vs a base unit (4/8px multiples); count of distinct active colors and
semantic consistency (destructive is always the same red); image `naturalWidth` vs
rendered size (stretched/low-res); computed `transition`/`animation` durations. Apply
the **would-a-human-see-it filters** to everything DOM-derived: in the viewport?
unoccluded (`clickable_check`)? large and contrasty enough to notice? Anything failing
a filter is INVISIBLE, exactly as the persona experiences it — unfiltered DOM
perception cheats, because the DOM sees things eyes don't.

**Capture discipline (all walk types).** Batch: captures throttle at ~2/sec and one
viewport shot can be cropped for several elements — take one and mine it; never capture
per-element in a loop. Keep every per-template capture: the end-of-walk coherence
review needs them side by side. Evidence for a finding is as many captures as the
finding needs (before/after, multi-state) — rationing evidence on a BLOCKER
false-economizes the report.

If perception at any tier cannot determine whether the page communicated its state,
log the ambiguity: it is often a finding about the page (weak affordance, missing
status feedback), not just a tooling gap. Where the harness cannot judge something
(easing quality, scroll feel), write "unevaluated" explicitly.

---

## Phase 2 — The Walk (field-trip relay playbook)

Concrete verbs for the relay (`mcp__field-trip__browser`, or CLI fallback per the
field-trip-relay skill). For other harnesses (computer use, Playwright), swap the verbs;
the loop is identical.

1. `arrive` → perceive per the ladder for this walk type (judgment walk: screenshot
   and run the first-impression protocol from watch-list B; regression: structured
   perception) → read it as first-time eyes.
2. Per step, in order:
   a. Where would my eyes go? (say it — justified by Tier 1 geometry: position, size,
      reading order, passing the would-a-human-see-it filters)
   b. What would I click, and why do I believe that's the affordance? (say it)
   c. `visual_snapshot`, then click by visible text/target. Increment the click counter.
   d. `visual_diff` — did the page respond in a way the persona would notice and
      understand? Escalate to a screenshot only on a Tier 2 trigger (doubt,
      DOM-blind region, visual watch-list item).
   e. Log any hesitation: if it took you more than one look to choose, that's a
      **moment of doubt** — record it verbatim ("two buttons both might mean X").
3. **Build the flow map as you go:** every control → its destination/effect. Loops,
   orphans, and back-button traps fall out of the map, not out of memory.
4. **Instruments after judgment, not instead of it.** `quick_scan`, `a11y_issues`,
   `layout_audit`, contrast checks run AFTER you've formed the human impression — to
   confirm or quantify it, never to substitute for looking.
5. Mobile matters when the persona is mobile: set the viewport first, and keep it.
6. **End-of-walk coherence review (judgment walks only):** place the per-template
   captures side by side — button styles, corner radii, shadow language, header
   treatments, spacing scale: is this one product, or several stitched together? Then
   run the brand-voice review over the microcopy collected during the walk.

Relay operational notes (inherit all rules from the field-trip-relay skill): relay mode
only, max 2 retries then stop and document, never kill Chrome, check tab ownership,
use `textContent` not `innerText` in evals. **Pixel captures need an active tab — run
judgment walks (pixels-first) in your own `new_window`** so activating tabs for capture
never steals the user's or another agent's screen; DOM-first regression walks are fine
in a background `new_tab`.

---

## Phase 3 — Report

One structured report per walk. Findings without evidence don't count.

- **Journey summary:** persona · goal · outcome (succeeded / succeeded-with-friction /
  abandoned-at-X) · actual interactions vs click budget.
- **Effort accounting:** "Goal reachable in N interactions; took M." Attribute each
  delta as *unjustified* (friction) or *ceremonial* (deliberate weight — a review step
  before payment, confirmation before deletion, paced disclosure). The count is an
  instrument, not a verdict: the goal is proportionate effort, not compression.
- **Friction log,** severity-ranked, each with evidence (screenshot reference, quoted
  copy, flow-map excerpt):
  - **BLOCKER** — persona abandons or cannot complete the goal without cheating.
  - **FRICTION** — unjustified effort, a loop, a moment of doubt; recoverable but
    costly.
  - **TRUST-EROSION** — the flow completes but the persona's confidence is damaged:
    incoherent, cheap-looking, off-brand, "I don't want to enter my card here." Sits at
    FRICTION level — desirability failures change behavior *outside* the walk (bounce,
    no return visit, no referral, lower willingness to pay).
  - **POLISH** — noticed; wouldn't change behavior.
- **Flow map** with loops, dead ends, and state-timing surprises flagged.
- **Moments of doubt,** verbatim, even the ones that resolved.
- **Watch-list answers:** every question written in the Phase 0 briefing gets an
  explicit answer. No silent drops — an unanswered watch-list item is a gap in the
  walk, and the report must say so.

**Gating:** BLOCKER findings join the ship gates (build green + tsc baseline +
deploy-verify + experience pass) — do not report a flow as shippable with an open
BLOCKER. FRICTION and POLISH are advisory backlog.

---

## Model Calibration (judge expensive, re-verify cheap)

This skill is unusually model-sensitive. The mechanical work (relay verbs, diffs,
click counting, flow-map building) runs fine on any tier. The judgment work — holding
a persona without drifting into agent-brain, noticing confusion no tool flags,
severity calibration — scales steeply with model capability, and weak models fail it
as **false confidence**: a clean report from a model that stopped noticing looks
identical to a clean app. Route work accordingly:

- **Judgment walks** — the first walk of any journey, or any walk after a redesign —
  run on the top available tier (Fable/Opus). Never delegate first judgment of a flow
  to a smaller model. A judgment walk is rare per flow; its report becomes a rubric.
- **Regression re-walks** — Haiku/Sonnet. Not asked to notice anything new: diff
  reality against the prior judgment report (does the flagged loop still exist? is
  the path still N clicks? was the flagged copy fixed?). Binary checks against an
  existing rubric are reliable at any tier.
- **Mechanical sweeps** — site-wide button→destination crawls, batch instrument runs,
  click-count measurement of known paths — cheap tiers produce the raw material; one
  top-tier synthesis pass judges it.

**Empirical evidence (Gateway Choir A/B, 2026-07-03).** The same spec-complete work
order (7 walkthrough findings + these skills) ran on Opus and Sonnet against identical
checkouts. **Discipline transferred almost perfectly**: both reproduced-before-fixing,
found the same UTC-boundary root cause, proved a build failure pre-existed via
stash-and-rebuild-main, made the same explicit ultrawide decision, and reported
unverifiable UI honestly. Sonnet even out-executed Opus once (cleanly fixed a widget
Opus deferred as "prop churn"). **The tiers separated on exactly two things:** (1)
reasoning past the visible artifact — Sonnet read `md:hidden` in the markup and ruled
"nothing to fix / deploy drift," missing that the unlayered `.m-tabbar{display:grid}`
beats layered utilities in the Tailwind v4 cascade (Opus caught it); (2) going to
ground truth unprompted — Opus queried the live DB and found a symptom was hand-typed
data, Sonnet stopped at a plausible code-level guess. Both Sonnet misses were
**false negatives written in the same confident evidentiary tone as its correct
findings** — confirming the false-confidence tax. Routing implication: cheap tiers +
skills for the bulk of build/fix work, but "nothing to fix" / "not reproducible"
claims from a cheaper tier are precisely the ones a top-tier pass must adjudicate.

The **Haiku leg** completed the gradient: it reported "COMPLETE — all findings
addressed" with per-finding ✅s while its BLOCKER fix sat in a junk directory
(shell-escaped path `src/app/\(app\)/...`; the real route unchanged), it inverted
date-parsing semantics to "reproduce" a bug that wasn't there, ruled two reproducible
findings "already correct" (DERIVED negatives, both false), and asserted the build
failure was pre-existing without running the stash-test the other tiers ran.
Confidence was inversely correlated with correctness across the three tiers, and the
new failure layer was **execution**: the agent could not see that its own write
landed in the wrong place, because it verified intention, not outcome. Corollary:
below the judgment/regression split there is a floor — a tier that cannot verify its
own actions cannot hold ANY walk role, including mechanical sweeps, without an
outcome oracle in the loop.

**Guardrails:**
- Every report states its **model tier and walk type** (judgment vs regression vs
  sweep). "No findings" from a regression re-walk is weaker evidence than "no
  findings" from a judgment walk — never let the two read the same.
- If a smaller model finds itself running a judgment walk anyway: **escalate, don't
  resolve.** Follow the procedure hyper-literally, log every ambiguity verbatim as a
  moment of doubt instead of settling it with taste, and flag the report's doubt log
  for top-tier review before any gate decision.
- A ship gate (BLOCKER check) may only be cleared by a judgment walk or by a
  regression re-walk whose rubric came from one.

---

## Scope note

Part 1 (fidelity rules) and Phases 0/3 are harness-agnostic — they apply unchanged to
any browser automation or computer-use tooling. Phase 2 is the field-trip relay
binding; port the verbs when the harness changes.

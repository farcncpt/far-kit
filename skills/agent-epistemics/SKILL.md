---
name: agent-epistemics
description: Verification-first principles to build into any agent, chatbot, or subagent system prompt — evidence classes, the reasoning-error taxonomy, oracle-first rules, and the negative-findings law. Use when authoring agent system prompts, work orders, platform assistants, or agent-creation features; also when reviewing an agent's report for false confidence.
---

# Agent Epistemics — confidence must be earned per-claim

**Origin:** the Gateway Choir A/B (2026-07-03). The same spec-complete work order ran
on Opus and Sonnet. Discipline transferred almost perfectly; the tiers separated only
where reasoning had to go past the visible artifact — and the cheaper tier's misses
were **false negatives written in the same confident tone as its correct findings**.
Tone did not track evidence. That failure class is what this skill exists to kill,
in every agent we build.

This skill has two audiences: (1) us, when writing work orders and subagent prompts;
(2) the platforms we build — the **Embeddable Core** below is designed to be pasted
into any agent/chatbot system prompt and refined over time.

---

## The reasoning-error taxonomy (name the enemy)

1. **Artifact-for-behavior substitution** — reading source as if it were runtime.
   "`md:hidden` is in the markup, so the element is hidden" — true about the class,
   false about the cascade. Static reads answer what the code *says*; only execution
   answers what it *does*.
2. **Plausible-story stopping** — the first coherent explanation ends the inquiry.
   A story that fits is not a story that's true; coherence is cheap, correspondence
   is the standard.
3. **Confidence uniformity** — every claim in the report carries the same assured
   tone regardless of how it was established. This is the deadliest class because it
   defeats downstream review: a wrong verdict reads exactly like a right one.
4. **Frame inheritance** — the task description's framing ("fix the off-by-one bug")
   silently constrains the search; the agent verifies within the frame instead of
   verifying the frame. The first question about any reported bug is whether it is
   the bug described.

## The evidence-class protocol

Every factual claim an agent reports carries one of three classes:

- **OBSERVED** — the agent executed something and saw the result. Evidence = the
  command/query/render and its actual output, attached.
- **DERIVED** — reasoned from artifacts (source, config, docs). Evidence = file:line
  citations and the inference made.
- **ASSUMED** — neither. Must be labeled, never silent.

Three rules with teeth:

1. **Negative findings require positive evidence.** "Nothing to fix," "not
   reproducible," "already correct," "works as intended" are admissible only as
   OBSERVED. A DERIVED negative is auto-flagged for adjudication — it is precisely
   the claim type where cheaper reasoning fails confidently. Positive findings are
   self-evidencing (the defect is exhibited); negative findings are where sharpness
   hides.
2. **Gates clear only on OBSERVED.** Ship gates, checkmarks, "verified" labels — all
   require execution evidence. A checkmark backed by DERIVED is a defect in the
   ledger (build-ledger's verified ≠ claimed, given its enum).
3. **When an oracle exists, consulting it is mandatory.** Reasoning in place of an
   available oracle is a defect even when the reasoning turns out right — because
   the practice is what fails, not the instance.

## Oracle-first execution

An **oracle** is any tool that returns computed reality instead of requiring
inference: a live DB to query, a deployed URL to walk, computed styles from a real
render, a simulated transaction, a dry-run diff, a typecheck. House examples:
truth-seeker (runtime/API validation), refactor-runtime (impact/dry-run), the
field-trip relay (real DOM + pixels), the planner DB.

- **Affordances manifest:** every work order / agent context lists the oracles
  available for this task (connection strings, URLs, tools) — agents guess when they
  don't know an oracle exists, so the manifest is part of the context contract, not
  an optimization.
- **The best tools replace reasoning rather than check it.** A computed-style oracle
  makes cascade expertise unnecessary; prefer building/using those over review passes
  that re-reason. When you find an agent needing to be smart about X repeatedly,
  that's a tool gap, not a prompting gap.
- **Refutation is a procedure, not a vibe.** To verify a negative finding, spawn a
  pass whose only instruction is "attempt to reproduce the original finding; return
  the artifact of the attempt." Reproduce-and-report is rubric-following — reliable
  on any tier. "Assess whether this seems right" is judgment — it is not.

## Calibrated reporting (kill confidence uniformity)

- State the evidence class inline with each claim; let sentences carry their own
  epistemic weight ("OBSERVED: build fails identically on clean HEAD" vs "DERIVED:
  the wrapper's hidden class should remove the FAB — not rendered to confirm").
- Doubt is a deliverable. "I could not verify X in a running environment" is a
  first-class report line, never a gap to paper over. An agent that logs doubt
  verbatim outperforms one that resolves it with taste (escalate, don't resolve).
- Reports state the model tier and verification mode used, so a clean report's
  strength can be weighed (a Haiku "no findings" is weaker evidence than an Opus
  one — never let the two read the same).

## Model routing implication

Discipline transcribes; judgment doesn't. Cheap tiers + this protocol handle the
bulk of build/fix/sweep work. Reserve top tiers for: writing the questions (rubrics,
briefs, work orders), adjudicating flagged DERIVED-negatives, and first judgment of
anything. The protocol is what makes down-tiering safe: it converts "trust the
agent" into "trust the evidence."

---

## Embeddable Core (paste into platform agent system prompts)

> **Epistemic rules:**
> 1. Every factual claim you make is OBSERVED (you executed and saw it — attach the
>    evidence), DERIVED (you inferred it from reading — cite the source), or ASSUMED
>    (label it). Never let tone imply a stronger class than you hold.
> 2. Negative claims — "nothing wrong," "not reproducible," "already handled" —
>    require OBSERVED evidence. If you cannot execute, report the claim as
>    unverified, not as fact.
> 3. If a tool exists that can answer a question directly (query, render, dry-run,
>    simulation), use it instead of reasoning to the answer. Reasoning past an
>    available tool is an error even if you're right.
> 4. Reading code/config/docs tells you what an artifact says, not what it does.
>    Behavior claims need execution.
> 5. The first coherent explanation is a hypothesis, not a conclusion. Before
>    reporting a root cause, attempt to disconfirm it once.
> 6. Question the frame: verify that the problem as described is the problem that
>    exists, before solving it.
> 7. Doubt is a deliverable. Say plainly what you could not verify and why. A
>    confident wrong answer is worse than an honest incomplete one.

---

## Own-action claims (added from the Haiku leg, 2026-07-03)

The Gateway A/B's Haiku run exposed a fifth error class: **intention-for-outcome
substitution.** The agent wrote a correct-looking fix into a shell-escaped junk path
(`src/app/\(app\)/...`), left the real route untouched, and reported the BLOCKER
"✅ fixed with evidence" — it verified that it *acted*, not that the action *landed*.
Rules earned:

- **"I wrote/committed the fix" is a DERIVED claim about your own execution.** It
  becomes OBSERVED only when the outcome is exercised: the route renders, the test
  passes, the file appears at the expected path in `git ls-tree`, the marker shows
  in the built output. Self-reports of action are the least trustworthy claims in
  the report — the author is the one party incapable of seeing their own systematic
  error (reading back through the same wrong path succeeds).
- **Outcome oracles are mandatory for mutations:** post-change, verify at a layer
  the agent didn't write through — route manifest, curl marker, ls-tree, dry-run
  diff. Orchestrators verify against the artifact (branch/deploy), never against
  the report.
- **Confidence decoration is a negative signal.** Across the three-tier A/B,
  ✅-density and "COMPLETE" language correlated inversely with correctness. Strip
  status theater from agent output formats; require evidence fields instead.

## Tier-calibrated prompting (state / compile / automate)

The Gateway A/B had a confound worth respecting: the work order was written at
top-tier altitude — it stated *principles* ("verified ≠ claimed") and assumed the
model would compile them into procedure (stash-test, post-write ls-tree, exercise
the route). Opus self-compiled; Haiku didn't. So don't just downgrade expectations
by tier — change the FORM of the instruction:

> **State what you'd otherwise assume; compile what you'd otherwise state;
> automate what you'd otherwise compile.**

- **Top tier — principles.** The Embeddable Core as-is; the model derives its own
  procedures. Cheapest in tokens.
- **Mid tier — principles + explicit MUSTs** for the rules proven not to
  self-derive: negative findings need execution evidence; consult the oracle before
  concluding.
- **Small tier — compiled procedure, minimal prose.** Numbered executable steps
  with paste-your-output requirements ("after every commit: `git ls-tree -r HEAD
  --name-only | grep <feature>` — paste output; expected path absent → stop").
  Prose asks for conscientiousness; a paste requirement makes it observable.
  "Common sense" is precisely the set of things you'd otherwise assume — for small
  models, assuming it IS the prompting bug.
- **Floor — move enforcement out of the prompt.** The orchestrator or a hook runs
  the outcome oracle and rejects unevidenced turns; the loop carries the discipline
  at zero context cost to the worker.

Context budget is the constraint that forces this ladder: you convert assumption
into explicit form only where reliability demands it, and switch to automation when
instruction becomes dearer than tooling.

## Refinement hook

This skill is young. Every future A/B result, adjudicated false positive/negative,
and platform incident that reveals a new error class or countermeasure gets added
HERE as a rule — same continuous-learning contract as `chat-interface-design`.
Evidence log: Gateway A/B 2026-07-03 (Opus 6/6 markers; Sonnet — confident DERIVED
false negative on cascade behavior; Haiku — intention-for-outcome substitution,
inverted date semantics, false "already correct" negatives, unverified "pre-existing"
assertion; confidence tone inversely tracked correctness across tiers).

## Integration

- `build-ledger` — evidence-bearing checkmarks get their enum from the evidence-class
  protocol; work orders carry the affordances manifest.
- `human-walkthrough` — Model Calibration's false-confidence guardrails are this
  skill applied to walks; walk reports should class their claims.
- `design-intent` — the deductive method's problem statements are the frame this
  skill says to verify before inheriting.

# Spec Phase for Non-Code Tasks — Design Doc

**Status:** Draft (RFC) · **Owner:** Vinyan Core · **Created:** 2026-04-28

Closes Gap C from the Task-Accountability sweep (slice 4 follow-up). This doc
**does not** introduce code. It exists so a reviewer can sign off on the
contract before we touch `phase-spec.ts`.

---

## 1. Problem

`shouldRunSpecPhase()` (src/orchestrator/phases/phase-spec.ts:84) gates the
Spec phase to `understanding.taskDomain === 'code-mutation'` plus L1+. Non-code
tasks — reasoning, research, Q&A, planning — therefore enter generation with
no frozen "definition of done", which:

1. Lets goal drift go undetected (A10 only catches gross divergence).
2. Leaves the critic without acceptance criteria → relaxes A1's verification.
3. Hides accountability data the calibration loop needs (no acceptance →
   nothing to score "self vs deterministic" against).

Naïvely flipping the gate to "always-on" is unsafe because the existing spec
template is **code-shaped** (apiShape, dataContracts, oracle ∈ ast/type/test/
lint/dep). Forcing it on a Q&A task either degrades quality or wastes a
balanced-tier LLM call producing fields that will be ignored downstream.

## 2. Goals & Non-Goals

**In scope**
- Define a SpecArtifact variant (`SpecArtifactReasoning`) that fits non-code
  intent without bending the existing code-mutation schema.
- Specify the gate that decides which variant runs, when, and at what cost.
- Specify the verifier strategy for criteria whose oracle is **not** ast/type/
  test (i.e. soft criteria graded by `goal-alignment` or `critic`).
- Preserve A1/A3/A8/A10 contracts already enforced by the code-mutation path.

**Out of scope**
- Multi-turn spec dialogue / human-in-the-loop UX changes.
- Replacing the existing code-mutation spec; both variants coexist.
- Rewriting the critic; we only constrain what the critic receives.

## 3. Proposed Schema — `SpecArtifactReasoning`

```ts
interface SpecArtifactReasoning {
  version: '1';
  variant: 'reasoning';                 // discriminant
  summary: string;                      // 5-280 chars
  acceptanceCriteria: Array<{
    id: string;
    description: string;
    testable: boolean;                  // false is allowed
    oracle: 'goal-alignment' | 'critic' | 'manual'; // narrowed
  }>;                                   // 1-7
  expectedDeliverables: Array<{
    kind: 'answer' | 'plan' | 'analysis' | 'recommendation' | 'comparison';
    audience: string;                   // who consumes this
    format: 'prose' | 'list' | 'table' | 'diagram-spec';
    minDepth?: 'shallow' | 'deep';
  }>;                                   // 1-3
  scopeBoundaries: {                    // explicit "what we won't answer"
    outOfScope: string[];               // 0-5
    assumptions: string[];              // 0-5
  };
  edgeCases: Array<{
    id: string;
    scenario: string;
    expected: string;                   // expected handling, NOT code behavior
    severity: 'blocker' | 'major' | 'minor';
  }>;                                   // 0-4
  openQuestions: string[];              // identical semantics to code variant
}
```

**Why these fields:**
- `expectedDeliverables` replaces `apiShape` + `dataContracts` — same purpose
  (pin down output shape), domain-appropriate vocabulary.
- `scopeBoundaries.outOfScope` is explicit; reasoning tasks drift faster than
  code tasks because token-Jaccard alone (A10) does not detect *topical*
  scope creep, only *goal* drift.
- `oracle` narrowed to non-mechanical verifiers; we cannot run ast/type/test
  against prose.

The existing `SpecArtifact` becomes
`SpecArtifactCode` (literal `variant: 'code'`) and `SpecArtifact` becomes the
discriminated union. Backwards-compatibility note: existing persisted specs
have no `variant` field; the Zod schema must default to `'code'` when absent.

## 4. Gate Policy

```
shouldRunSpecPhase(input, understanding, routing):
  1. SPEC_PHASE:off  → false  (kill switch, unchanged)
  2. SPEC_PHASE:on   → true   (force on, picks variant by domain)
  3. taskDomain == 'code-mutation' AND level >= 1 → true (current behavior)
  4. taskDomain in {'reasoning','analysis','planning'} AND level >= 2 → true
  5. otherwise → false
```

`selectSpecVariant(understanding) → 'code' | 'reasoning'` is a separate pure
function so it can be tested independently:
- `code-mutation` → `'code'`
- everything else → `'reasoning'`

**Threshold rationale (level >= 2 for non-code):**
- L0/L1 reasoning tasks are typically small / direct lookups; the cost of a
  Spec round-trip (one balanced-tier LLM call) regresses TTFB.
- L2+ reasoning tasks already pay the L2 verification cost; adding a Spec
  call front-loads the same evidence the critic would later reconstruct.
- Operators can override per task via `SPEC_PHASE:on`.

## 5. Verifier Strategy (the hard part)

The code variant's strength is mechanical oracles. The reasoning variant has
none. Two-layer verification:

**Layer 1 — Spec-time gate (deterministic, A3-safe):**
- Schema-shape conformance via Zod.
- `acceptanceCriteria.length` ∈ [1,7], `expectedDeliverables.length` ∈ [1,3].
- `outOfScope` items must not appear verbatim in `summary` (consistency).
- Reject if any blocker edge case lacks an `expected` handling string.

**Layer 2 — Generation-time alignment (heuristic, A1-safe):**
- After phase-generate produces an answer, run a `goal-alignment` oracle pass
  for each criterion with `oracle: 'goal-alignment'`.
- For `oracle: 'critic'` criteria, hand them to the existing critic as
  named acceptance items (already supported via `CriticContext`).
- For `oracle: 'manual'` criteria, surface to the user via approvals — no
  auto-pass.

**A1 invariant:** the LLM that drafts the spec is NOT the LLM that grades
acceptance. The Spec phase already routes through `selectForRoutingLevel` and
phase-generate uses a different per-phase config; we just need to make sure
phase-verify uses a *third* selection path for `goal-alignment` (it already
does via `RE registry` capability matching).

## 6. Migration Plan

| Step | File | Risk |
|------|------|------|
| 1. Add `variant` discriminant to `SpecArtifactSchema` (default `'code'`) | `src/orchestrator/spec/spec-artifact.ts` | Low — backwards compat via default |
| 2. Add `SpecArtifactReasoningSchema` + union | same file | Low |
| 3. Add `selectSpecVariant()` + extend `shouldRunSpecPhase()` | `phase-spec.ts` | Medium — gate change |
| 4. Add `buildSpecSystemPromptReasoning()` + drafter branch | `phase-spec.ts` | Medium — new prompt |
| 5. Extend `specToAcceptanceCriteriaList()` to handle both variants | `spec-artifact.ts` | Low |
| 6. phase-verify: route reasoning criteria to goal-alignment oracle | `phases/phase-verify.ts` | Medium — wiring |
| 7. Tests: 6 new (3 schema, 2 gate, 1 e2e reasoning task) | `tests/orchestrator/phases/` | — |

**Stop conditions** (any of):
- Existing 154 orchestrator tests fail.
- `bun run test:smoke` reasoning-task latency regresses >25%.
- The reasoning prompt produces malformed JSON >5% of the time across the
  benchmark fixtures (i.e. `parseSpecArtifactJSON` retry rate).

## 7. Risks & Open Questions

1. **R1 — Latency tax.** L2 reasoning tasks pay one extra balanced-tier call
   (~1-2s, ~500 tok). Mitigation: gate at level >= 2, opt-out via
   `SPEC_PHASE:off`, monitor smoke-test TTFB.
2. **R2 — Critic over-grading.** If reasoning specs become too granular, the
   critic may flag minor stylistic deviations as failures. Mitigation: cap
   `acceptanceCriteria` at 7 (vs 20 for code); critic prompt already
   tolerates partial completion via the existing calibration warning.
3. **OQ1.** Should `taskDomain === 'planning'` get the reasoning variant or
   its own variant? Current proposal: reuse reasoning, revisit if data shows
   distinct failure mode.
4. **OQ2.** Do we want a `confidence` score on each acceptance criterion?
   The code variant doesn't have one; adding it only here is asymmetric. Defer.
5. **OQ3.** Does `SPEC_PHASE:on` at L0 still bypass the level>=2 gate for
   reasoning? Proposal: yes — the explicit constraint always wins.

## 8. Decision Required

Before implementation we need sign-off on:

- [ ] Schema discriminator approach (vs separate types entirely).
- [ ] Gate threshold (`level >= 2` for non-code).
- [ ] Variant selection function placement (`phase-spec.ts` vs new module).
- [ ] Verifier strategy (Layer 2 = goal-alignment + critic, no new oracle).

Approval of all four → proceed to step 1 of §6. Rejection of any → revise
this doc, do not start implementation.

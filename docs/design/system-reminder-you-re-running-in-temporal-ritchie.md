# Plan — Vinyan Intent Resolver: deterministic-first, verified, cacheable

## Context

Today `resolveIntent()` (src/orchestrator/intent-resolver.ts) is a one-shot LLM call gated by a coarse "skip if code-mutation OR targetFiles" guard; the rule-based mapper (`fallbackStrategy()`) only fires when the LLM throws. Consequences observed in code:

- Intent can drift from Vinyan's A3/A5 axioms — the LLM's strategy is adopted verbatim even when STU's deterministic signals (`taskDomain` × `taskIntent` × `toolRequirement`) disagree. There is no tier-weighted merge.
- `classifyDirectTool()` (tools/direct-tool-resolver.ts) runs only *after* the LLM picked `direct-tool`, so a deterministic-tool candidate never informs (or short-circuits) the LLM.
- Identical goals re-invoke the LLM every task — `understandingFingerprint` already exists on SemanticTaskUnderstanding but is not used as a cache key here.
- `agentic-workflow` unconditionally rewrites `input.goal` with the LLM's `workflowPrompt` regardless of confidence, and the original goal is lost for downstream tracing.
- There is no path for "I cannot classify this" — low-confidence / contradictory classifications fall through as `full-pipeline`, which burns tokens instead of asking the user.

The change makes resolution **deterministic-first, LLM-advisory, tier-merged, cached, and honest about uncertainty** — matching the concept axioms (A3 deterministic governance, A5 tiered trust) while keeping LLM enrichment useful where rules are blind.

## Shape of the change

```
prepareExecution()
  TaskInput ─► enrichUnderstanding() (unchanged)
                │
                ▼
          SemanticTaskUnderstanding
                │
                ▼
    ┌──────────── resolveIntent(input, understanding, deps) ────────────┐
    │ [A] cache.get(understandingFingerprint)      hit→return            │
    │ [B] deterministic candidate                                        │
    │      classifyDirectTool(goal)                                      │
    │      mapUnderstandingToStrategy(understanding)    (tier 0.8)       │
    │ [C] LLM advisory  — SKIPPED when det.confidence≥0.85 && !ambiguous │
    │      prompt carries [B] as grounding                               │
    │ [D] verify+merge  ─ agree      → type:'known'                      │
    │                   ─ LLM adds   → type:'known' (rule floor kept)    │
    │                   ─ disagree   → A5 tier wins, type:'contradictory'│
    │                   ─ low-conf   → type:'uncertain' + clarification  │
    │ [E] cache.set(fingerprint, resolution)  + bus.emit('intent:*')     │
    └────────────────────────┬───────────────────────────────────────────┘
                             ▼
                       IntentResolution+   (type, clarificationRequest?, originalGoal?)
                             │
                             ▼
                     executeTask() dispatch
          ┌──────────────────┼──────────────────┬──────────────────┐
          │ conversational   │ direct-tool      │ agentic-workflow │ full-pipeline
          │  (unchanged)     │  det. first      │  conditional     │  (unchanged)
          │                  │  LLM fallback    │  rewrite gated   │
          │                  │  empty-output    │  by confidence;  │
          │                  │  fall-through    │  originalGoal    │
          │                  │  (exists)        │  preserved       │
          └─────────┬────────┴────────┬─────────┴──────────────────┘
                    │                 │
                    │ type ∈ {uncertain, contradictory}
                    ▼                 ▼
             TaskResult{status:'uncertain', answer: clarificationRequest,
                         escalationReason, trace.approach:'intent-clarify'}
             bus: 'intent:contradiction' | 'intent:uncertain'
```

## Files touched

### 1. `src/orchestrator/types.ts` — extend `IntentResolution` (~+10 LOC)

```ts
export interface IntentResolution {
  strategy: ExecutionStrategy;
  refinedGoal: string;
  directToolCall?: { tool: string; parameters: Record<string, unknown> };
  workflowPrompt?: string;
  confidence: number;
  reasoning: string;
  /** NEW — epistemic state mirroring VerifiedClaim taxonomy (A5 tiered trust). */
  type: 'known' | 'uncertain' | 'contradictory';
  /** NEW — populated when type ∈ {uncertain, contradictory}; surfaced to user. */
  clarificationRequest?: string;
  /** NEW — preserved for agentic-workflow rewrites; enables tracing/rollback. */
  originalGoal?: string;
  /** NEW — observability: what the deterministic layer proposed before LLM. */
  deterministicCandidate?: {
    strategy: ExecutionStrategy;
    confidence: number;
    source: 'classifyDirectTool' | 'mapUnderstandingToStrategy' | 'composed';
  };
}
```

No existing consumer reads new fields, so callers remain compatible. Tests currently construct `IntentResolution` via `resolveIntent` (not direct literal), with one exception in `core-loop.ts:285` fallback — update that literal to set `type:'known'` (or `'uncertain'` if confidence low).

### 2. `src/orchestrator/intent-resolver.ts` — the substantive rewrite (~+150 LOC, -40)

Keep the existing zod schema, timeout helper, and hallucinated-tool normalizer. Add:

- **`mapUnderstandingToStrategy(understanding) → { strategy, confidence, ambiguous }`**
  Promote `fallbackStrategy()` from "LLM-failure fallback" to primary deterministic mapper. Source: STU's `taskDomain × taskIntent × toolRequirement`. Tier reliability 0.8 (heuristic). Mark `ambiguous=true` when:
    - `taskDomain==='general-reasoning' && taskIntent==='execute'` without clear `toolRequirement` signal, or
    - historical profile `isRecurring` flag conflicts with current verb, or
    - `resolvedEntities` is empty but goal contains file-looking tokens (heuristic: `/\.\w{1,6}\b/`).

- **`composeDeterministicCandidate(input, understanding) → IntentResolution | null`**
  - Call `classifyDirectTool(input.goal)`. If confidence ≥ 0.85 and `mapUnderstandingToStrategy` agrees (or is `none/tool-needed` consistent), return a full `IntentResolution` with `directToolCall` resolved via `resolveCommand()` for current platform; source='composed', confidence=min(both).
  - Else return the `mapUnderstandingToStrategy` candidate as an `IntentResolution` skeleton (no `directToolCall`, no `workflowPrompt`), confidence=0.8 for unambiguous, 0.55 for ambiguous.
  - Special-case: conversational greetings (`taskDomain==='conversational'`) → confidence 0.95 (greetings are unambiguous).

- **Module-level cache** — `const intentCache = new LRUCache<string, IntentResolution>({ max: 256 })`. Use `understanding.understandingFingerprint` as key. Mirrors `UnderstandingEngine.cache` pattern (src/orchestrator/understanding/understanding-engine.ts:409). Skip cache when `input.constraints` includes a no-cache marker (defensive for tests).

- **New `resolveIntent(input, understanding, deps)` pipeline** — signature change: add `understanding: SemanticTaskUnderstanding` parameter.

  ```
  [A] if (cache.has(fp)) → emit cache_hit, return cached
  [B] deterministic = composeDeterministicCandidate(input, understanding)
      if (deterministic.confidence >= 0.85 && !ambiguous && deps.registry)
          ⇒ SKIP LLM. result = { ...deterministic, type:'known' }
      else if (!deps.registry)  ⇒ result = { ...deterministic, type:'known' }
      else:
  [C] llmRaw = LLM call with grounding prompt:
        "Deterministic layer (tier 0.8) proposed: <strategy>. Override only if
         you have strong evidence. If you disagree, say why in `reasoning`."
  [D] merge(deterministic, llmRaw):
        - if llmRaw.strategy === deterministic.strategy: type='known',
          confidence = max(det, llm), merge directToolCall/workflowPrompt from llm
        - if llm proposes direct-tool/workflowPrompt that deterministic couldn't
          express (e.g. rule had 'full-pipeline' but llm has detailed workflowPrompt):
          type='known', confidence = min(det+0.05, 0.95), strategy keeps rule floor
          unless rule was 'full-pipeline' and llm='agentic-workflow' (allowed upgrade)
        - if strategies disagree AND neither matches A5 tier order:
          type='contradictory'. A5: deterministic (tier 0.8) wins over LLM (tier 0.4).
          clarificationRequest = "Vinyan is uncertain: rules say <X> but semantic
          analysis suggests <Y>. Did you mean to: (a)… (b)…?"
        - if llm.confidence < 0.5 OR llmRaw strategy is the A3-unsafe "unknown":
          type='uncertain', clarificationRequest built from ambiguity hints.
  [E] cache.set(fp, result); emit 'intent:resolved' + (type-specific event)
      return result
  ```

  Grounding prompt addition (augment INTENT_SYSTEM_PROMPT): include STU summary
  (`taskDomain`, `taskIntent`, `toolRequirement`, `actionVerb`, `resolvedEntities[0..3]`, `historicalProfile?.isRecurring`) so the LLM doesn't re-derive what's already known. The prompt carries a line: "If the rule-based candidate is already correct, repeat it — do not fabricate complexity."

- **Remove** `fallbackStrategy()` export path from its sole call-site in core-loop.ts error branch (collapse: the deterministic pipeline never throws — it always has a candidate, so no fallback branch is needed). Keep `fallbackStrategy()` as an internal helper used by `mapUnderstandingToStrategy`.

### 3. `src/orchestrator/core-loop.ts` — dispatch + wiring (~+50 LOC, -30)

- In `prepareExecution()`:
  - Drop the `needsIntentResolution` guard (deterministic pipeline is free — always run it). LLM gating now lives inside `resolveIntent` step [C]. IR1/IR2 from task-routing-spec still hold because the LLM call is gated by `deterministic.confidence ≥ 0.85`, which code-mutation/targetFiles tasks trivially clear via the STU rule mapping.
  - Pass `understanding` to `resolveIntent(input, understanding, { registry, availableTools, bus })`.
  - Remove the try/catch that built a fallback `IntentResolution` literal — `resolveIntent` now always returns one.

- In `executeTask()` dispatch (after `prep`):
  - **New branch first** — if `intentResolution.type === 'uncertain' || 'contradictory'`: build a TaskResult with
    - `status: 'uncertain'`
    - `answer: intentResolution.clarificationRequest`
    - `escalationReason: <type>: <reasoning>`
    - trace with `approach: 'intent-clarify'`, `outcome: 'uncertain'`
    - emit `intent:contradiction` or `intent:uncertain`, then `task:complete`.
  - **direct-tool** branch: unchanged — deterministic resolver + executeDirectTool + empty-output fall-through already covers "goal-alignment check" (line 666).
  - **agentic-workflow** branch — gate the rewrite:
    ```ts
    if (intentResolution.strategy === 'agentic-workflow' && intentResolution.workflowPrompt
        && intentResolution.confidence >= 0.7) {
      const originalGoal = input.goal;
      input = { ...input, goal: intentResolution.workflowPrompt };
      intentResolution.originalGoal = originalGoal;  // preserved for tracing
    }
    ```
    Below the confidence threshold, keep the original goal (the agent will plan from the raw user text rather than an LLM paraphrase that may drift).
  - **conversational**: unchanged. The completion gate referenced in the diagram already exists via `buildConversationalResult` returning the full LLM answer.

### 4. `src/core/bus.ts` — event schema (~+4 LOC)

Extend `'intent:resolved'` payload and add two sibling events so UIs can react:

```ts
'intent:resolved': { taskId; strategy; confidence; reasoning;
                     type: 'known'|'uncertain'|'contradictory';
                     deterministicCandidate?: { strategy; confidence } };
'intent:contradiction': { taskId; ruleStrategy; llmStrategy; ruleConfidence; llmConfidence };
'intent:uncertain': { taskId; reason; clarificationRequest };
'intent:cache_hit': { taskId; fingerprint };
```

Update the single consumer `src/bus/cli-progress-listener.ts:38` to render the new `type` tag ("[intent] known:direct-tool (det 0.9)").

### 5. `tests/orchestrator/intent-resolver.test.ts` — add coverage (~+120 LOC)

Preserve existing cases; update the ones that call `resolveIntent(input, deps)` to the new `(input, understanding, deps)` signature — build `understanding` via `enrichUnderstanding(input, { workspace: '.' })` from `understanding/task-understanding.ts` (already used in core-loop).

New cases:
1. Deterministic short-circuit — greeting ("สวัสดี") with no LLM provider registered still returns `strategy:'conversational'`, `type:'known'`, confidence ≥ 0.9, LLM never called (spy on `provider.generate`).
2. Deterministic short-circuit — `open -a "Google Chrome"` pattern gets `directToolCall` from `resolveCommand`, LLM skipped.
3. Cache hit — two consecutive calls with identical `understandingFingerprint` → provider called once; second emits `intent:cache_hit`.
4. Disagreement → contradictory — rule says `full-pipeline`, LLM says `direct-tool`: final `type:'contradictory'`, `strategy` follows A5 (rule), `clarificationRequest` non-empty, bus emits `intent:contradiction`.
5. LLM low confidence — LLM returns `confidence:0.3`: final `type:'uncertain'`, `strategy` reverts to deterministic, `clarificationRequest` mentions ambiguity aspects from STU.
6. Agreement + LLM enrichment — rule proposes `agentic-workflow`, LLM adds `workflowPrompt`: `type:'known'`, prompt survives, `originalGoal` preserved on the resolution object.
7. `originalGoal` gate — `confidence:0.6` agentic-workflow should NOT rewrite `input.goal` in the core-loop dispatch (covered by a small integration test in `core-loop-integration.test.ts`).

## Critical files — quick reference

| File | Role | Lines to edit |
|---|---|---|
| src/orchestrator/types.ts | IntentResolution extension | 125-137 |
| src/orchestrator/intent-resolver.ts | Pipeline rewrite | whole file |
| src/orchestrator/core-loop.ts | Dispatch + agentic gate + uncertain branch | 256-298, 706-736 |
| src/orchestrator/tools/direct-tool-resolver.ts | Reused unchanged (`classifyDirectTool`, `resolveCommand`) | — |
| src/orchestrator/understanding/task-understanding.ts | Reused unchanged (`enrichUnderstanding`, `understandingFingerprint`) | — |
| src/core/bus.ts | Event schema | 253 |
| src/bus/cli-progress-listener.ts | Render `type` | 38 |
| tests/orchestrator/intent-resolver.test.ts | Tests | whole file |

## Verification

Run end-to-end before opening PR:

1. `bun test tests/orchestrator/intent-resolver.test.ts` — all new + existing pass.
2. `bun test tests/orchestrator/core-loop-integration.test.ts` — regression guard; especially the direct-tool and conversational short-circuit cases.
3. `bun test tests/orchestrator/task-domain-classifier.test.ts` (if present under different name) — STU rule mapper still deterministic.
4. Manual: `bun src/cli/run.ts "สวัสดี"` — observe no LLM token usage for intent (deterministic hit), `[intent] known:conversational`.
5. Manual: `bun src/cli/run.ts "เปิดแอพ Safari"` — observe `intent:cache_hit` on second run; tool executes without second LLM call.
6. Manual ambiguous: `bun src/cli/run.ts "จัดการระบบให้หน่อย"` — observe `status: UNCERTAIN` summary with clarification question; no pipeline burn.
7. `bun run typecheck` and `bun run lint` clean.

## Non-goals (intentionally deferred)

- Persisting `intentCache` across processes (current UnderstandingEngine cache is also in-memory).
- Teaching the LLM prompt new tool names — tool list stays identical.
- Changing `fallbackStrategy` call-sites outside the resolver (internal-only after this change).
- Adjusting `TaskResult.status` enum — `'uncertain'` already exists (types.ts:341).

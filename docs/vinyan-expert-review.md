# Vinyan ENS — Expert Panel Review Findings

> **Review Date:** 2026-04-01 | **Phase Reviewed:** 0-4 (implemented) + 5 (design)
> **Methodology:** 5 specialized AI agents analyzed the full TDD, concept, architecture, ECP spec, gap analysis, and source code independently, then findings were synthesized.
> **Cross-references:** [vinyan-tdd.md](vinyan-tdd.md) §15 (Q10-Q22), [vinyan-gap-analysis.md](vinyan-gap-analysis.md) §10.6, [vinyan-ecp-spec.md](vinyan-ecp-spec.md) Appendix D

---

## 1. Panel Composition

| # | Role | Focus Area | Key Docs Reviewed |
|---|------|------------|-------------------|
| 1 | **Systems Architect** | Architecture coupling, scalability, Core Loop design | TDD §1/§5/§6/§15/§16, architecture §2/§3 |
| 2 | **Protocol / Distributed Systems Expert** | ECP design, multi-instance coordination, consensus | ECP spec full, concept §2, TDD §2/§3/§20-§23 |
| 3 | **AI/ML Systems Expert** | Self-Model, Evolution Engine, LLM integration | TDD §12/§12B/§16/§17, concept §3/§9, gap-analysis |
| 4 | **Security & Reliability Expert** | Trust model, failure modes, circuit breakers | TDD §5/§7/§8/§12C, concept §5/§10, src/guardrails/ |
| 5 | **Pragmatic Engineer** | Over-engineering, competitive gaps, ROI | gap-analysis full, TDD §1/§13/§14/§15, CLAUDE.md |

---

## 2. Consensus Findings (4-5 out of 5 Experts Agree)

### 2.1 Core Loop is a God Function (5/5)

`executeTask()` in `src/orchestrator/core-loop.ts` (lines 151-767) is a 616-line function handling ~20 concerns: routing level escalation, retry loops, skill matching, perception assembly, self-model prediction, worker selection, task decomposition, worker dispatch, tool execution partitioning, oracle verification, quality scoring, critic evaluation, test generation, trace recording, self-model calibration, shadow execution, artifact commit, and working memory updates. It contains 31 `bus?.emit()` calls.

**Impact:** Cannot be partially restarted. Crash between verification and commit = entire task restarts. No transactional boundary for crash safety. Violates Single Responsibility.

**Recommendation:** Extract to explicit state machine with persistent checkpoints (→ TDD §15 Q11).

### 2.2 Working Memory is Ephemeral (4/5)

`WorkingMemoryState` in `src/orchestrator/working-memory.ts` is constructed fresh per `executeTask()` call and lives only in process memory. If the Orchestrator crashes mid-task, all accumulated failure evidence (failed approaches, active hypotheses, uncertainties) is lost. A restarted task will rediscover the same failures.

**Impact:** Retry loops lose their primary differentiator. Tasks waste compute rediscovering known-bad approaches.

**Recommendation:** Add `serialize()`/`deserialize()` to WorkingMemory, persist to SQLite checkpoint table (→ TDD §15 Q11).

### 2.3 API Keys Forwarded to Worker Subprocesses (4/5)

`buildWorkerEnv()` in `src/orchestrator/worker/worker-pool.ts` (lines 318-331) forwards `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, and `OPENROUTER_API_KEY` to worker child processes via `PROVIDER_ENV_KEYS` (lines 313-316). A compromised worker subprocess gains all API credentials.

**Impact:** Violates A6 spirit ("Workers propose; Orchestrator disposes"). Attack surface extends to LLM provider accounts.

**Recommendation:** Orchestrator-hosted LLM proxy. Workers request completions via stdout JSON; Orchestrator intercepts, validates, and proxies (→ TDD §15 Q12).

### 2.4 Evolution Engine Groups by Exact String (4/5)

`groupByApproach()` in `src/sleep-cycle/sleep-cycle.ts` (lines 467-479) uses `trace.approach` as an exact string key. Since approach strings are LLM-generated free text (e.g., "Fixed by updating the import path" vs "Fixed by correcting the module alias"), semantically identical approaches never merge. Pattern mining frequency analysis is meaningless.

**Impact:** The single biggest flaw in the Evolution Engine. Learning signal is destroyed by string fragmentation. The system cannot learn from its most common successes/failures.

**Recommendation:** Semantic approach clustering using token-based Jaccard similarity before pattern extraction (→ TDD §15 Q13).

### 2.5 Zero Production Users = Zero Validation (4/5)

1,339 tests pass internally, but there are zero external benchmarks (SWE-bench), zero real users, and adoption friction rated "Very High" in the project's own gap analysis. Tests run in non-A6-compliant in-process worker mode (`WARNING: In-process worker mode is not A6-compliant` appears in test output).

**Impact:** The system has not proven it delivers value outside its own test suite.

**Recommendation:** (1) Ship as Claude Code hooks package for quick adoption, (2) Run against SWE-bench-lite and publish results (→ TDD §15 Q17, Q18).

---

## 3. Debate Areas (Experts Disagreed)

### 3.1 ECP vs MCP: NIH or Justified?

| Position | Expert(s) | Argument |
|----------|-----------|----------|
| **Justified** | Protocol, AI/ML, Architect | Schema-required epistemic fields, bidirectional negotiation (`ecp/deliberate`), trust tier as protocol concept — MCP can't enforce these |
| **Premature** | Pragmatic | "Protocol standards achieve adoption through users, not completeness. Ship as a library first." |
| **Nuanced** | Protocol | "Separation is justified but docs oversell it. MCP's `content` array CAN carry structured JSON. The real argument is **enforcement**, not capability." |

**Resolution direction:** ECP is technically justified, but should launch as a JSON library SDK (Level 0 conformance) before formalizing as a protocol standard. The documentation should lead with "schema enforcement" as the primary argument, not "MCP can't carry these fields."

### 3.2 Seven Axioms: All Necessary?

| Position | Expert(s) | Argument |
|----------|-----------|----------|
| **All 7 needed** | Architect, Security | "Traceable through codebase, serve as structural contracts in code comments" |
| **Reduce to 4** | Pragmatic | "A4 = implementation of A1, A5 = policy within A1, A6 = A3 applied to workers. Keep A1, A2, A3, A7." |

**Resolution direction:** Keep 7 internally (useful for code review and traceability). Externally communicate 3-4 core principles for adoption messaging.

### 3.3 A3 (Deterministic Governance): Honest or Aspirational?

| Expert | Assessment |
|--------|-----------|
| Architect | "A3 holds for routing/verify/commit. Does NOT hold for planning." |
| AI/ML | "Critic has veto power at L2+ — LLM IS in the governance path." |
| Security | "Structurally enforced where it matters (commit gate), but boundary is thinner than docs suggest." |

**Consensus reframe:** *"All governance decisions that gate state mutations are grounded in deterministic or heuristic evidence. LLM signals are inputs, never sole deciders."* The TDD should acknowledge this nuance explicitly rather than claiming A3 applies to the full pipeline.

### 3.4 Phase 5 (Multi-Instance): Should We Proceed?

| Position | Expert(s) | Argument |
|----------|-----------|----------|
| **Proceed (with fixes)** | Protocol, Architect | "Advisory peer mesh is correct topology, but fix stale-fact reinjection and clock skew" |
| **Defer indefinitely** | Pragmatic | "Qualitatively different problem. Requires different team. Not until external validation of Phase 0-4." |
| **Proceed selectively** | Security | "Network security design is incomplete — no replay protection, no key rotation, TOFU vulnerability" |

---

## 4. Domain Findings

### 4.1 Architecture

| ID | Finding | Severity | File(s) | Axiom Impact |
|----|---------|----------|---------|-------------|
| AR-1 | Synchronous EventBus blocks L0's 100ms budget. 31 emit calls in core loop, all synchronous. Telemetry handlers (trace, audit) do I/O in hot path. | HIGH | `src/core/bus.ts:174-189` | A3 (latency) |
| AR-2 | Single-writer World Graph bottleneck with parallel subtasks (maxParallelSubtasks: 4). SQLite WAL serializes writes under contention. | HIGH | `src/world-graph/` | A4 |
| AR-3 | No crash recovery / checkpoint in core loop (see §2.1 above). | HIGH | `src/orchestrator/core-loop.ts` | A3, A6 |
| AR-4 | Perception at L3 risks context window explosion. No token budget for perception step — only total task budget. A widely-imported utility change (blast radius 30+) assembles massive context. | MEDIUM | `src/orchestrator/perception-assembler.ts` | — |
| AR-5 | A7 feedback loop may not converge. Self-Model learns "this task type succeeds at L2" without controlling for confound that L2 simply has more compute. Biases toward higher routing levels. | MEDIUM | `src/orchestrator/self-model.ts` | A7 |

### 4.2 Protocol (ECP)

| ID | Finding | Severity | Location | Status |
|----|---------|----------|----------|--------|
| PR-1 | **Spec-implementation gap:** Spec says JSON-RPC 2.0 (ECP spec §3.1), but `src/oracle/runner.ts` uses raw JSON — no `jsonrpc`, `method`, `id` fields. Third-party implementations from spec would be incompatible. | CRITICAL | ECP spec §3.1, `src/oracle/runner.ts` | → ECP Appendix D |
| PR-2 | **Confidence conflation:** Single `confidence: number` encodes both engine certainty AND tier reliability. Compiler `1.0` ("deterministic") is qualitatively different from LLM `0.6` ("60% sure"). | HIGH | ECP spec §4.2 | → ECP Appendix D |
| PR-3 | **`falsifiable_by` no formal grammar:** Declared as `string[]` with no structured format. No parser, no interop guarantee. Ecosystem fragmentation risk. | HIGH | ECP spec §4.5, TDD §2 | → ECP Appendix D |
| PR-4 | Clock skew unaddressed in Phase 5 network transport. TTL checking (`now - timestamp > ttl_ms`) is sensitive to clock difference between instances. | MEDIUM | Concept §2.4 | |
| PR-5 | Deliberation protocol lacks response message type. Engine requests budget but spec doesn't define how it learns what was granted. | MEDIUM | ECP spec §7.3 | → ECP Appendix D |
| PR-6 | No streaming/progress for long-running engines (10-60s at L2/L3). Can't distinguish "still processing" from "stuck." | MEDIUM | ECP spec §5.1 | |

### 4.3 AI/ML

| ID | Finding | Severity | File(s) | Axiom Impact |
|----|---------|----------|---------|-------------|
| ML-1 | **Critic fails open** (`approved: true` on error) in `failOpenResult()`. A2 violation — "I don't know" converted to "yes." | HIGH | `src/orchestrator/critic/llm-critic-impl.ts:192-201` | A2 |
| ML-2 | Task signature too brittle. `computeTaskSignature()` uses first word + extension + blast bucket. "Fix auth middleware" and "Fix session bug" = same signature. | MEDIUM | `src/orchestrator/self-model.ts:303-308` | A7 |
| ML-3 | No embedding or semantic similarity anywhere. System compares approaches, signatures, and skills using exact string operations. | MEDIUM | Multiple | A7 |
| ML-4 | QualityScore weights static (`0.6*arch + 0.4*efficiency`). Never calibrated against actual outcomes. | MEDIUM | TDD §12 | A7 |
| ML-5 | Approach blacklist is string-matching on free-form text. LLM can regenerate same approach with different wording. | MEDIUM | `src/orchestrator/core-loop.ts:457-459` | — |
| ML-6 | Self-Model ignores perception features. Predicts from historical averages only, not from per-task signals (type errors, coverage, blast radius). | MEDIUM | `src/orchestrator/self-model.ts` | A7 |

### 4.4 Security

| ID | Finding | Severity | File(s) | Status |
|----|---------|----------|---------|--------|
| SC-1 | **API keys forwarded to workers** (see §2.3 above). | HIGH | `src/orchestrator/worker/worker-pool.ts:313-331` | → TDD Q12 |
| SC-2 | **Shadow runner no isolation.** `cp -r` + `sh -c` as same OS user. No network restriction, no cgroup, no cap-drop. | HIGH | `src/orchestrator/shadow/shadow-runner.ts` | |
| SC-3 | Auth token comparison not timing-safe. `provided === token` at line 42. | MEDIUM | `src/security/auth.ts:42` | Tier 1 fix |
| SC-4 | `sanitizeForPrompt` uses `.replace()` not `.replaceAll()`. Only first occurrence redacted. | MEDIUM | `src/guardrails/index.ts:37` | Tier 1 fix |
| SC-5 | Guardrail regex evasion: multi-encoding chains not handled, base64 pattern false-positive prone. | MEDIUM | `src/guardrails/prompt-injection.ts` | |
| SC-6 | Ed25519 private key stored as plaintext JSON (`~/.vinyan/instance-key.json`). | LOW | `src/security/instance-identity.ts` | Phase 5 |
| SC-7 | No message replay protection for Phase 5 cross-instance signing. | MEDIUM | `src/security/instance-identity.ts` | Phase 5 |

### 4.5 Pragmatic

| ID | Finding | Severity | Recommendation |
|----|---------|----------|---------------|
| PG-1 | Tests run in non-A6-compliant in-process worker mode. System claims A6 but doesn't enforce it in tests. | HIGH | Test with subprocess isolation as default |
| PG-2 | Phase 5 is a complete rewrite, not an increment. Different problem space (distributed systems), different team skillset. | HIGH | Defer until Phase 0-4 production validated |
| PG-3 | Adoption friction "Very High" in own gap analysis. | HIGH | Ship Claude Code hooks package (lowest friction) |
| PG-4 | AGI readiness section (gap-analysis §10) is scope creep. | MEDIUM | Remove from active roadmap |
| PG-5 | 148 source files, 17 directories, 5 DB stores — optimized for 10-person team but likely 1-3 people. | MEDIUM | Consolidate DB stores, merge related modules |
| PG-6 | Evolution Engine 100-trace data gate = chicken-and-egg problem. Need users to get traces, need features to get users. | MEDIUM | Hooks package provides trace collection path |

---

## 5. Priority Recommendations

### Tier 1 — Fix Now (quick wins, high impact)

| # | Recommendation | Impact | Effort | File(s) |
|---|---------------|--------|--------|---------|
| R1 | Fix Critic fail-open → fail-closed with `type: 'unknown'` | A2 compliance | LOW | `src/orchestrator/critic/llm-critic-impl.ts` |
| R2 | Add timing-safe token comparison | Security | LOW | `src/security/auth.ts` |
| R3 | Fix `replace` → global replace in guardrails | Security | LOW | `src/guardrails/index.ts` |
| R4 | Ship Oracle Gate as Claude Code hooks package | Adoption | MEDIUM | New: hooks config + docs |

### Tier 2 — Fix Soon (structural improvements)

| # | Recommendation | Impact | Effort | File(s) |
|---|---------------|--------|--------|---------|
| R5 | Refactor core loop → state machine with checkpoints | Reliability | HIGH | `src/orchestrator/core-loop.ts`, new state types |
| R6 | Eliminate API key exposure — Orchestrator LLM proxy | Security (A6) | HIGH | `src/orchestrator/worker/worker-pool.ts`, worker-entry.ts |
| R7 | Split EventBus: sync (governance) + async (telemetry) | L0 latency | MEDIUM | `src/core/bus.ts` |
| R8 | Semantic approach clustering for Evolution Engine | Learning signal | MEDIUM | `src/sleep-cycle/sleep-cycle.ts` |
| R9 | Close ECP spec-implementation gap (Level 0 = raw JSON) | Protocol integrity | MEDIUM | `src/oracle/runner.ts`, ECP spec |

### Tier 3 — Strategic (before Phase 5)

| # | Recommendation | Impact | Effort | Dependencies |
|---|---------------|--------|--------|-------------|
| R10 | Run against SWE-bench-lite, publish results | External validation | HIGH | Test harness setup |
| R11 | Formalize `falsifiable_by` condition grammar | Ecosystem interop | MEDIUM | Protocol design work |
| R12 | Connect perception signals to Self-Model predictions | Smarter routing | MEDIUM | Self-Model refactor |
| R13 | Harden shadow runner (Docker isolation, concurrency limit) | Security | MEDIUM | Docker dependency |
| R14 | Split `confidence` into `tier_reliability` + `engine_certainty` | Protocol correctness | HIGH | Breaking protocol change |

---

## 6. Provocative Questions

These questions were posed by experts and remain open for ongoing discussion:

1. **"If Claude Code adds a confidence field to hooks API tomorrow — does ECP still have value?"** (Protocol Expert)
2. **"Self-improvement ceiling is top 3-5 task patterns — is 5,000+ lines of Evolution Engine worth it?"** (AI/ML Expert)
3. **"A system that tests itself in non-A6-compliant mode and claims A6 — how credible is that?"** (Pragmatic Engineer)
4. **"Advisory peer mesh that fail-opens to single instance — is that 'multi-instance' or just 'single instance that might cache data from friends'?"** (Systems Architect)
5. **"LLM-as-Critic has veto power at L2+ — can the governance path still be called 'non-LLM'?"** (AI/ML + Architect)

---

## 7. Cross-References

| This Section | Links To |
|:-------------|:---------|
| §2.1 Core Loop God Function | TDD §15 Q11 (checkpoint state), §16 (Core Loop spec) |
| §2.3 API Key Forwarding | TDD §15 Q12 (proxy vs direct), architecture D5 (worker isolation) |
| §2.4 Evolution Engine Grouping | TDD §15 Q13 (approach normalization), §12B (Evolution Engine) |
| §3.1 ECP vs MCP | ECP spec Appendix D, concept §2.3 (ECP rationale) |
| §3.3 A3 Honesty | Concept §1.1 A3 (deterministic governance definition) |
| §4.2 Protocol Findings | ECP spec Appendix D (Known Limitations) |
| §4.4 Security Findings | TDD §15 Q12 (API keys), Q20 (shadow isolation) |
| §5 Recommendations | gap-analysis §10.6 (summary table) |

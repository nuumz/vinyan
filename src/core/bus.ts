/**
 * Event Bus — deterministic message routing between Orchestrator components.
 *
 * Zero-dependency, synchronous, fully type-safe.
 * A3 compliance: FIFO ordering, deterministic dispatch.
 *
 * Source of truth: design/implementation-plan.md §1C.4
 */

import type { PeerTrustLevel } from '../oracle/tier-clamp.ts';
import type {
  CachedSkill,
  EvolutionaryRule,
  ExecutionTrace,
  GoalGroundingCheck,
  RoutingDecision,
  SelfModelPrediction,
  ShadowJob,
  ShadowValidationResult,
  TaskInput,
  TaskResult,
  ToolResult,
  WorkerOutput,
} from '../orchestrator/types.ts';
import type { Fact, OracleVerdict } from './types.ts';

// ── Event Map ────────────────────────────────────────────────────────

export interface VinyanBusEvents {
  // Spec-required (§1C.4)
  'task:start': { input: TaskInput; routing: RoutingDecision };
  'task:complete': { result: TaskResult };
  'phase:timing': { taskId: string; phase: string; durationMs: number; routingLevel: number };
  'worker:dispatch': { taskId: string; routing: RoutingDecision };
  'oracle:verdict': { taskId: string; oracleName: string; verdict: OracleVerdict };
  'critic:verdict': { taskId: string; accepted: boolean; confidence: number; reason?: string };
  // Book-integration Wave 5: emitted by DebateRouterCritic when the
  // debate path (3-seat advocate/counter/architect) fires, either
  // because risk score ≥ threshold or because `DEBATE:force` was in
  // the task constraints. Consumers (Economy OS, dashboards) use this
  // to track debate spending separately from baseline critic spending.
  //
  // `trigger` is either a manual override ('force'/'skip') or
  // 'risk-threshold' when the router fired based on the risk rule.
  'critic:debate_fired': {
    taskId: string;
    riskScore?: number;
    routingLevel?: number;
    trigger: 'force' | 'skip' | 'risk-threshold';
  };
  // Book-integration Wave 5.7a: emitted when DebateBudgetGuard denies
  // a would-be debate fire because the per-task cap was reached. Paired
  // with `critic:debate_fired` for dashboards — the difference between
  // the two counts tells operators how often debate was BLOCKED by the
  // cap vs how often it successfully fired.
  //
  // `denyType` is the programmatic discriminator for dashboard filtering:
  //   - 'max-per-task': per-task cap reached for this task id
  //   - 'max-per-day':  per-day cap reached across all tasks
  // `reason` is a short human-readable string; `maxPerTask` /
  // `maxPerDay` are the configured caps; `taskCount` and `dayCount`
  // are the current counters at the moment of the deny.
  'critic:debate_denied': {
    taskId: string;
    reason: string;
    denyType: 'max-per-task' | 'max-per-day';
    maxPerTask: number;
    maxPerDay: number | null;
    taskCount: number;
    dayCount: number;
  };
  'trace:record': { trace: ExecutionTrace };
  'trace:write_failed': { taskId: string; traceId: string; error: string };
  'grounding:checked': GoalGroundingCheck;
  /**
   * A10 / T6 \u2014 emitted when the goal-grounding boundary takes a runtime
   * action beyond plain confidence downgrade. Carries the action label and
   * the underlying check for observability.
   */
  'grounding:action_taken': {
    taskId: string;
    action: GoalGroundingCheck['action'];
    phase: GoalGroundingCheck['phase'];
    reason: string;
  };

  // Worker lifecycle
  'worker:complete': { taskId: string; output: WorkerOutput; durationMs: number };
  'worker:error': { taskId: string; error: string; routing: RoutingDecision };

  // Shadow validation (Phase 2.2)
  'shadow:enqueue': { job: ShadowJob };
  'shadow:complete': { job: ShadowJob; result: ShadowValidationResult };
  'shadow:failed': { job: ShadowJob; error: string };

  // Skill Formation (Phase 2.5)
  'skill:match': { taskId: string; skill: CachedSkill };
  'skill:miss': { taskId: string; taskSignature: string };
  'skill:outcome': { taskId: string; skill: CachedSkill; success: boolean };

  // Evolution Engine (Phase 2.6)
  'evolution:rulesApplied': { taskId: string; rules: EvolutionaryRule[] };
  'evolution:rulePromoted': { ruleId: string; taskSig: string };
  'evolution:ruleRetired': { ruleId: string; reason: string };
  /** Phase D: capability claim promoted onto a stable agent. */
  'evolution:capabilityPromoted': {
    agentId: string;
    capabilityId: string;
    confidence: number;
    observationCount: number;
    taskTypeSignature: string;
  };
  /** Phase 5: quarantined persistent custom-agent proposal created. */
  'evolution:agentProposalCreated': {
    proposalId: string;
    suggestedAgentId: string;
    taskTypeSignature: string;
    unmetCapabilityIds: string[];
    evidenceTraceIds: string[];
    wilsonLowerBound: number;
  };

  // Sleep Cycle (Phase 2.4)
  'sleep:cycleComplete': {
    cycleId: string;
    patternsFound: number;
    rulesGenerated: number;
    skillsCreated: number;
    rulesPromoted: number;
    capabilitiesPromoted?: number;
    agentProposalsCreated?: number;
  };
  // Phase C2: knowledge-index rebuild status emitted at the end of run().
  'sleep_cycle:knowledge_index_rebuilt': {
    cycleId: string;
    modules: number;
    path: string;
  };
  'sleep_cycle:knowledge_index_failed': {
    cycleId: string;
    reason: string;
  };

  // Self-Model (Phase 1C.1)
  'selfmodel:predict': { prediction: SelfModelPrediction };

  // Forward Predictor (A7: prediction error as learning signal)
  'prediction:generated': { prediction: import('../orchestrator/forward-predictor-types.ts').OutcomePrediction };
  'prediction:calibration': { taskId: string; brierScore: number };
  'prediction:outcome-skipped': { predictionId: string; reason: string };
  'prediction:miscalibrated': { taskId: string; brierScore: number; threshold: number };
  'prediction:tier_upgraded': { taskId: string; fromBasis: string; toBasis: string };

  // World Graph
  'graph:fact': { fact: Fact };

  // Circuit breaker
  'circuit:open': { oracleName: string; failureCount: number };
  'circuit:close': { oracleName: string };

  // Tool execution (Phase 2 — G1)
  'tools:executed': { taskId: string; results: ToolResult[] };

  // Tool approval — user prompted to approve commands not in allowlist
  'tool:approval_required': { requestId: string; command: string; reason: string };

  // Tool remediation — automatic error recovery for failed tool executions
  'tool:failure_classified': { taskId: string; type: string; recoverable: boolean; error: string };
  'tool:remediation_attempted': { taskId: string; correctedCommand: string; confidence: number; reasoning: string };
  'tool:remediation_succeeded': { taskId: string; correctedCommand: string };
  'tool:remediation_failed': { taskId: string; reason: string };

  // User preference learning — behavioral app/tool preference applied
  'preference:applied': { taskId: string; category: string; preferredApp: string; usageCount: number };

  // Task lifecycle extensions
  'task:escalate': { taskId: string; fromLevel: number; toLevel: number; reason: string };
  /**
   * Stage-level progress snapshot — finer than `phase:timing`, complements it.
   *
   * `phase:timing` fires AFTER a phase completes (perceive/plan/generate/...).
   * `task:stage_update` fires DURING a phase to surface what the orchestrator
   * is doing right now (e.g. `planning:decomposing`, `planning:scoring`,
   * `generation:agent-loop`, `verification:running-oracles`). UIs can render
   * "Planning · Decomposing · retry 1/2" without having to diff bus traffic.
   *
   * Observational only (A1, A3): never used for routing decisions. Producers
   * are free to emit no `task:stage_update` at all — consumers MUST treat
   * absence as "phase-level granularity is enough".
   */
  'task:stage_update': {
    taskId: string;
    /** High-level phase this stage belongs to (perceive | spec | plan | generate | verify | learn). */
    phase: string;
    /** Free-form sub-stage label, e.g. `decomposing`, `scoring`, `approval-gate`, `ready`, `fallback`. */
    stage: string;
    /** Status of the stage transition. `entered` = just started; `progress` = mid-stage update; `exited` = stage finished. */
    status: 'entered' | 'progress' | 'exited';
    /** Attempt number for retryable stages (1-based). Optional — omit when not retrying. */
    attempt?: number;
    /** Optional human-readable reason — e.g. why a stage repeated, why a fallback fired. */
    reason?: string;
    /** Optional progress counts (e.g. plan steps done/total). */
    progress?: { done: number; total: number };
  };
  'task:timeout': {
    taskId: string;
    elapsedMs: number;
    budgetMs: number;
    /** Routing level the timeout was attributed to (the level that actually consumed budget, not a post-escalation re-label). */
    routingLevel?: number;
    /** Optional human-readable explanation — e.g. "wall-clock budget exhausted before next attempt could start". */
    reason?: string;
    /** Last `phase:timing` event observed for this task before the timeout. */
    lastPhase?: { phase: string; durationMs: number; ts: number };
    /** Last `agent:tool_started` / `agent:tool_executed` event observed before the timeout. */
    lastTool?: { name: string; ts: number; status: 'started' | 'executed'; isError?: boolean };
    /** Most recent `agent:plan_update` snapshot — number of done/skipped over total steps. */
    planProgress?: { done: number; total: number };
    /** Latest `task:stage_update` snapshot — what sub-stage was running when the wall clock fired. */
    currentStage?: { phase: string; stage: string; attempt?: number; ts: number };
  };
  'task:budget-exceeded': { taskId: string; totalTokensConsumed: number; globalCap: number };

  // A9: Resilient Degradation — normalized runtime degradation contract.
  'degradation:triggered': {
    taskId?: string;
    failureType:
      | 'oracle-unavailable'
      | 'llm-provider-failure'
      | 'tool-timeout'
      | 'tool-failure'
      | 'rate-limit'
      | 'peer-unavailable'
      | 'trace-store-write-failure'
      | 'budget-pressure'
      | 'economy-accounting-failure'
      | 'session-persistence-failure'
      | 'mutation-apply-failure';
    component: string;
    action: 'retry' | 'fallback' | 'degrade' | 'fail-closed' | 'escalate';
    capabilityImpact: 'none' | 'reduced' | 'blocked';
    retryable: boolean;
    severity: 'info' | 'warning' | 'critical';
    policyVersion: string;
    reason: string;
    sourceEvent: string;
    occurredAt: number;
  };

  /**
   * A9 — economy accounting failure (cost write / ledger update fails).
   * Emitted when cost recording cannot be persisted; degrades open by default
   * because billing-side observability is best-effort, but feeds the
   * degradation tracker so operators can see correlated outages.
   */
  'economy:accounting_failed': { taskId?: string; reason: string };

  /**
   * A9 — session/chat persistence failure (session row insert/update fails).
   * Degrades open: chat UX should not crash on transient write errors.
   */
  'session:persistence_failed': { sessionId?: string; reason: string };

  /**
   * A9 — mutation-apply failure (write/destructive workspace tool failed
   * after classification). Distinct from `tool:failure_classified` because
   * fail-closed semantics anchor here per the A9 policy matrix.
   */
  'tool:mutation_failed': {
    taskId?: string;
    toolName: string;
    category: 'write' | 'destructive';
    reason: string;
  };

  /**
   * Manual retry request — emitted by the API server when an operator (or
   * the chat UI) hits POST /api/v1/tasks/:id/retry. Observational only
   * (A1, A3): governance never reads this; it exists so dashboards / SSE
   * consumers can surface the parent → child chain.
   */
  'task:retry_requested': {
    taskId: string;
    parentTaskId: string;
    reason: string;
    sessionId?: string;
  };

  /**
   * Operator-driven cancellation — fired by the API server when a task
   * row transitions to `cancelled` (DELETE /tasks/:id). Recorded for
   * historical replay so the operations console drawer can surface the
   * lifecycle change after refresh, even when SSE was disconnected.
   *
   * `source: 'human'`   — operator clicked Cancel
   * `source: 'shutdown'`— graceful shutdown drained inflight rows
   * `source: 'auto'`    — orchestrator self-cancelled (timeout, etc.)
   */
  'task:cancelled': {
    taskId: string;
    sessionId?: string;
    reason: string;
    cancelledAt: number;
    source: 'human' | 'shutdown' | 'auto';
  };

  // TestGenerator observability
  'testgen:error': { taskId: string; error: string };

  // Human approval gate (A6: zero-trust for high-risk production tasks)
  'task:approval_required': { taskId: string; riskScore: number; reason: string };
  /**
   * Fired whenever an A6 task approval transitions out of the pending map —
   * explicit human resolve via API, programmatic resolve, or auto-rejection
   * by the timeout timer. Carries the final decision and the source so
   * cross-tab UIs can drop their cached approval card the moment the gate
   * clears, without polling. Persistence is intentionally skipped (the
   * `task:complete` / `task:escalate` row already records the outcome).
   */
  'task:approval_resolved': {
    taskId: string;
    decision: 'approved' | 'rejected';
    source: 'human' | 'timeout' | 'shutdown';
  };

  // R5: ApprovalLedgerStore lifecycle events. These complement the
  // existing `task:approval_*` events by carrying the durable approval
  // id, approval key, status (including superseded/timed_out), and
  // resolution metadata. Subscribers wanting full audit replay should
  // use these; legacy UIs subscribed to `task:approval_*` keep working.
  'approval:ledger_pending': {
    approvalId: string;
    taskId: string;
    approvalKey: string;
    riskScore: number;
    reason: string;
    requestedAt: number;
    profile?: string;
    sessionId?: string;
  };
  'approval:ledger_resolved': {
    approvalId: string;
    taskId: string;
    approvalKey: string;
    status: 'approved' | 'rejected' | 'timed_out' | 'shutdown_rejected' | 'superseded';
    source: 'human' | 'timeout' | 'shutdown' | 'system';
    decision: string | 'rejected' | 'approved' | 'superseded';
    resolvedAt: number;
    resolvedBy?: string;
    batchCount?: number;
  };
  'approval:ledger_superseded': {
    parentTaskId: string;
    childTaskId: string;
    count: number;
  };

  // R1: workflow delegate failure terminal event. Emitted in every
  // failure branch of the delegate-sub-agent step (timeout, child task
  // returned status='failed', empty-response treated as failed,
  // skipped-due-to-dependency-cascade). Strengthens A8 by making the
  // delegate failure replayable from the durable event log alone —
  // `workflow:delegate_completed` only fires on the success path AND
  // on the empty-response-failed path; the watchdog timeout path
  // previously emitted only `workflow:delegate_timeout` (live signal,
  // not durable terminal).
  'workflow:delegate_failed': {
    taskId: string;
    stepId: string;
    subTaskId?: string;
    agentId: string | null;
    status: 'failed' | 'timeout' | 'skipped';
    reason: string;
    errorClass?: string;
    durationMs?: number;
    tokensUsed?: number;
  };

  // Agentic SDLC — Spec Refinement phase (between Perceive and Predict)
  'spec:drafted': {
    taskId: string;
    criteriaCount: number;
    edgeCaseCount: number;
    openQuestionCount: number;
    durationMs: number;
  };
  'spec:approved': { taskId: string; approvedBy: string; criteriaCount: number };
  'spec:rejected': { taskId: string; reason: string };
  'spec:drafting_failed': { taskId: string; reason: string; durationMs: number };

  // Agentic SDLC — Brainstorm phase (pre-Perceive ideation)
  'brainstorm:drafted': {
    taskId: string;
    candidateCount: number;
    convergenceScore: number;
    durationMs: number;
  };
  'brainstorm:approved': { taskId: string; approvedCandidateId?: string; convergenceScore: number };
  'brainstorm:rejected': { taskId: string; reason: string };
  'brainstorm:drafting_failed': { taskId: string; reason: string; durationMs: number };

  // PH3.6: Epsilon-greedy exploration
  'task:explore': { taskId: string; fromLevel: number; toLevel: number };

  // EHD Phase 3B: Pipeline confidence decision events
  'pipeline:re-verify': { taskId: string; composite: number | undefined; routing: RoutingDecision };
  'pipeline:escalate': { taskId: string; composite: number | undefined; fromLevel: number };
  'pipeline:refuse': { taskId: string; composite: number | undefined; reason: string };

  // Guardrail detections
  'guardrail:injection_detected': { field: string; patterns: string[] };
  'guardrail:bypass_detected': { field: string; patterns: string[] };
  'guardrail:violation': { workerId: string; type: string; details?: string };
  // Book-integration Wave 1.1: worker-level silence watchdog.
  // `state` = 'silent' → recoverable warning; 'stalled' → recommend kill.
  // `silentForMs` is the gap since the last worker turn; `lastEvent`
  // is the label of the last heartbeat (e.g. "tool_calls", "session_start").
  'guardrail:silent_agent': {
    taskId: string;
    workerId?: string;
    state: 'silent' | 'stalled';
    silentForMs: number;
    lastEvent: string;
  };

  // K1.5: Security violation — input rejected at task entry (block, not strip)
  'security:injection_detected': { taskId: string; detections: string[]; timestamp: number };

  // Self-model calibration
  'selfmodel:calibration_error': { taskId: string; error: string };

  // Oracle contradiction detection (A1: epistemic separation surfaces disagreements)
  'oracle:contradiction': { taskId: string; passed: string[]; failed: string[] };

  // K1.1: Contradiction escalation — auto-escalate routing level on unresolved oracle conflict
  'verification:contradiction_escalated': {
    taskId: string;
    fromLevel: number;
    toLevel: number;
    passed: string[];
    failed: string[];
  };
  'verification:contradiction_unresolved': { taskId: string; passed: string[]; failed: string[] };

  // ECP §7.3: Engine requests more compute budget (A2: uncertainty is first-class)
  'oracle:deliberation_request': { taskId: string; oracleName: string; reason: string; suggestedBudget: number };
  // K1.0: A5 Tiered Trust — llm-self-report verdict excluded from gate decisions
  'oracle:self_report_excluded': { taskId: string; oracleName: string; confidence: number };
  // K1.3: A6 Zero-Trust — tool call denied by capability scope
  'agent:tool_denied': { taskId: string; toolName: string; violation?: string };
  // K1.3: Contract violation policy triggered (kill or tolerance exceeded)
  'agent:contract_violation': { taskId: string; violations: number; policy: string };

  // DAG decomposition fallback (A3: deterministic governance transparency)
  'decomposer:fallback': { taskId: string };

  // Unified profile lifecycle — kind='worker' | 'oracle-peer' | 'oracle-local'.
  // Single source of truth for promotion/demotion/retire/reactivate across all
  // profile kinds. Consumers filter by `kind` when they care about a subset.
  'profile:registered': { kind: string; id: string };
  'profile:promoted': { kind: string; id: string; reason: string };
  'profile:demoted': { kind: string; id: string; reason: string; permanent: boolean };
  'profile:reactivated': { kind: string; id: string; emergency?: boolean };
  'profile:retired': { kind: string; id: string; reason: string };

  // Ecosystem runtime-state FSM (dormant/awakening/standby/working).
  // Orthogonal to profile:* (career-state). Emitted by RuntimeStateManager on
  // every legal transition.
  'ecosystem:runtime_transition': {
    agentId: string;
    from: 'dormant' | 'awakening' | 'standby' | 'working';
    to: 'dormant' | 'awakening' | 'standby' | 'working';
    reason: string;
    taskId?: string;
    activeTaskCount: number;
    at: number;
  };

  // Ecosystem commitment ledger (O2): "engine X owes deliverable Y by deadline Z".
  // Created at bid-accept, resolved at oracle-verdict. Resolution outcome feeds
  // the A7 prediction-error signal.
  'commitment:created': {
    commitmentId: string;
    engineId: string;
    taskId: string;
    deliverableHash: string;
    deadlineAt: number;
    acceptedAt: number;
  };
  'commitment:resolved': {
    commitmentId: string;
    engineId: string;
    taskId: string;
    kind: 'delivered' | 'failed' | 'transferred';
    evidence: string;
    resolvedAt: number;
    latencyMs: number;
  };

  // Ecosystem volunteer protocol (O4): "I can help" offer when the auction
  // has no winning bid. `ecosystem:volunteer_offered` fires per offer,
  // `ecosystem:volunteer_selected` fires once at window close.
  'ecosystem:volunteer_offered': {
    offerId: string;
    engineId: string;
    taskId: string;
    offeredAt: number;
    declaredConfidence?: number;
  };
  'ecosystem:volunteer_selected': {
    taskId: string;
    winnerEngineId: string;
    commitmentId: string;
    score: number;
    offerCount: number;
  };

  // Team blackboard (FS-backed) — emitted whenever `.vinyan/teams/<id>/<key>.md`
  // is written, either by internal orchestrator code (source='internal') or
  // by an external editor / git pull (source='external'). A4 consumers
  // subscribe to invalidate dependent facts. Tests can drive this event
  // manually to simulate concurrent external edits.
  'team:blackboard_updated': {
    teamId: string;
    key: string;
    version: number;
    author: string;
    source: 'internal' | 'external';
    path: string;
  };

  // Ecosystem reconcile — emitted once per violation found by a scheduled
  // invariant sweep. Subjects are engineId (I-E1) or commitmentId (I-E2).
  // I-E3 (department ↔ capability mismatch) self-heals and does not emit.
  'ecosystem:invariant_violation': {
    id: 'I-E1' | 'I-E2' | 'I-E3';
    subject: string;
    detail: string;
    checkedAt: number;
  };

  // Ecosystem reconcile — emitted once per scheduled sweep (success or error).
  // Dashboards can use this to track whether the sweep is actually firing.
  'ecosystem:reconcile_tick': {
    checkedAt: number;
    violationCount: number;
    departmentsRefreshed: number;
    durationMs: number;
    error?: string;
  };

  // Ecosystem engine registry — emitted when a ReasoningEngine is added to
  // the registry. EcosystemCoordinator listens to upsert department
  // membership and auto-register the engine into the runtime FSM.
  'engine:registered': {
    engineId: string;
    capabilities: readonly string[];
    engineType: string;
  };
  'engine:deregistered': {
    engineId: string;
  };

  // Worker selection (Phase 4.4)
  'worker:selected': { taskId: string; workerId: string; reason: string; score: number; alternatives: number };
  'worker:exploration': { taskId: string; selectedWorkerId: string; defaultWorkerId: string };

  // Warm pool observability (perf tuning)
  'warmpool:hit': { taskId: string };
  'warmpool:miss': { taskId: string; reason: 'all_busy' | 'not_initialized' };
  'warmpool:timeout': { taskId: string; workerTaskCount: number; timeoutMs: number };
  'warmpool:worker_replaced': { reason: 'timeout' | 'stdin_error' | 'parse_error'; taskCount: number };

  // Fleet governance (Phase 4.5)
  'fleet:convergence_warning': { giniScore: number; dominantWorkerId: string; allocation: number };
  'fleet:emergency_reactivation': { workerId: string; reason: string };
  'fleet:diversity_enforced': { workerId: string; boostAmount: number };

  // Fleet-level uncertainty — GAP-H UC-7 (Phase 4.4)
  'task:uncertain': { taskId: string; reason: string; maxCapability: number };

  // Artifact commit (Phase 1 — A6: orchestrator disposes)
  'commit:rejected': { taskId: string; rejected: Array<{ path: string; reason: string }> };

  // Observability — GAP-H failure mode detection (Phase 5.15)
  'memory:eviction_warning': { taskId: string; evictionCount: number; memoryPressure: number };
  'context:verdict_omitted': { taskId: string; oracleName: string; reason: string };
  'selfmodel:systematic_miscalibration': {
    taskId: string;
    biasDirection: 'over' | 'under';
    magnitude: number;
    windowSize: number;
  };
  'observability:alert': {
    detector: string;
    severity: 'warning' | 'critical';
    message: string;
    metadata?: Record<string, unknown>;
  };

  // API & Session events (Phase 5.1)
  'api:request': { method: string; path: string; taskId?: string };
  'api:response': { method: string; path: string; status: number; durationMs: number };
  'session:created': { sessionId: string; source: string };
  'session:compacted': { sessionId: string; taskCount: number };
  'session:updated': { sessionId: string; fields: Array<'title' | 'description'> };
  'session:archived': { sessionId: string };
  'session:unarchived': { sessionId: string };
  'session:deleted': { sessionId: string };
  'session:restored': { sessionId: string };
  'session:purged': { sessionId: string };
  'memory:approved': { recordId: string; key?: string };
  'memory:rejected': { recordId: string; key?: string };

  // Scheduler — durable agent cron (gateway_schedules + ScheduleRunner).
  // Lifecycle events for the operator console; the underlying runner
  // already exists, these surface its activity.
  // A3 / A8: every event carries scheduleId + profile so replay can
  // reconstruct schedule history per-profile.
  'scheduler:job_created': {
    scheduleId: string;
    profile: string;
    cron: string;
    timezone: string;
    goal: string;
  };
  'scheduler:job_updated': {
    scheduleId: string;
    profile: string;
    fields: ReadonlyArray<'cron' | 'timezone' | 'goal' | 'status' | 'constraints'>;
  };
  'scheduler:job_paused': { scheduleId: string; profile: string };
  'scheduler:job_resumed': { scheduleId: string; profile: string; nextFireAt: number | null };
  'scheduler:job_deleted': { scheduleId: string; profile: string };
  'scheduler:job_due': { scheduleId: string; profile: string; nextFireAt: number };
  'scheduler:job_started': { scheduleId: string; profile: string; taskId: string };
  'scheduler:job_completed': {
    scheduleId: string;
    profile: string;
    taskId: string;
    outcome: string;
    durationMs: number;
  };
  'scheduler:job_failed': {
    scheduleId: string;
    profile: string;
    taskId: string;
    reason: string;
    failureStreak: number;
  };
  'scheduler:circuit_opened': { scheduleId: string; profile: string; failureStreak: number };
  'scheduler:recursion_blocked': {
    scheduleId: string;
    profile: string;
    /** API path that the scheduled task tried to mutate. */
    blockedPath: string;
  };

  // Skill proposals — agent-managed skill creation as procedural memory
  // (`skill_proposals` table, mig 029). Every proposal stays quarantined
  // until a human approves it (A6 / A8 — no auto-activation).
  'skill:proposed': {
    proposalId: string;
    profile: string;
    proposedName: string;
    successCount: number;
    safetyFlags: ReadonlyArray<string>;
    trustTier: string;
  };
  'skill:proposal_approved': {
    proposalId: string;
    profile: string;
    proposedName: string;
    decidedBy: string;
  };
  'skill:proposal_rejected': {
    proposalId: string;
    profile: string;
    proposedName: string;
    decidedBy: string;
    reason: string;
  };
  'skill:proposal_quarantined': {
    proposalId: string;
    profile: string;
    proposedName: string;
    safetyFlags: ReadonlyArray<string>;
  };

  // Autogenerator runtime — restart-safe tracker + adaptive threshold.
  // Workspace-wide; recorder ignores them (audit lives in the
  // parameter ledger / state table). UI surfaces them in the
  // diagnostics panel.
  'skill:autogen_tracker_loaded': {
    bootId: string;
    loaded: number;
    prunedStale: number;
    invalidatedSchema: number;
    invalidatedCorrupt: number;
  };
  'skill:autogen_tracker_pruned': {
    bootId: string;
    reason: 'ttl' | 'capacity' | 'corrupt';
    count: number;
  };
  'skill:autogen_tracker_recovered': {
    bootId: string;
    signatureKey: string;
    successesAtBoot: number;
  };
  'skill:autogen_tracker_invalidated': {
    bootId: string;
    reason: 'schema-mismatch' | 'corrupt-json' | 'missing-table';
    count: number;
  };
  'skill:autogen_threshold_changed': {
    profile: string;
    oldThreshold: number;
    newThreshold: number;
    reason: string;
    explanation: string;
  };
  'skill:autogen_promotion_blocked': {
    profile: string;
    signatureKey: string;
    reason: 'cooldown' | 'fresh-evidence' | 'below-threshold';
    successes: number;
    threshold: number;
  };

  // Memory Wiki — second-brain substrate (src/memory/wiki/)
  'memory-wiki:source_ingested': {
    sourceId: string;
    kind: string;
    profile: string;
    contentHash: string;
  };
  'memory-wiki:page_proposed': {
    pageId: string;
    profile: string;
    type: string;
    title: string;
    actor: string;
  };
  'memory-wiki:page_written': {
    pageId: string;
    profile: string;
    type: string;
    lifecycle: string;
    evidenceTier: string;
    created: boolean;
    actor: string;
  };
  'memory-wiki:page_rejected': {
    pageId: string;
    reason: string;
    detail: string;
    actor: string;
  };
  'memory-wiki:claim_validated': {
    pageId: string;
    previousLifecycle: string;
    newLifecycle: string;
  };
  'memory-wiki:claim_rejected': {
    pageId: string;
    reason: string;
  };
  'memory-wiki:context_pack_built': {
    profile: string;
    pageCount: number;
    tokenEstimate: number;
    taskId?: string;
  };
  'memory-wiki:lint_started': { profile: string };
  'memory-wiki:lint_completed': {
    profile: string;
    total: number;
    errors: number;
    warnings: number;
  };
  'memory-wiki:stale_detected': { pageId: string; reason: string };
  'memory-wiki:consolidation_completed': {
    profile: string;
    promoted: number;
    demoted: number;
    archived: number;
    mirrored: number;
  };

  // Adaptive parameter store — emitted on every successful `set()`. Lets
  // long-lived consumers (workers, sleep-cycle, dashboards) re-read
  // current values without polling the store. Also a hook for telemetry.
  'adaptive-params:value_changed': {
    key: string;
    oldValue: unknown;
    newValue: unknown;
    reason: string;
    ownerModule: string;
    source: 'ledger' | 'in-memory';
  };

  // ── Proposed A11/A12/A14 stubs (not yet load-bearing, RFC) ──
  // A11 — emitted post-preflight, pre-write at artifact-commit. Lets
  // future capability-escalation gating attach without a code change.
  'commit:capability_escalation_evaluated': {
    taskId: string;
    actor: string;
    targets: readonly string[];
    decision: 'allow' | 'require-human' | 'deny';
    reason: string;
  };
  // Gap 4 — emitted when a successful commit lands on a path under
  // `src/orchestrator/` or `src/core/` (the running orchestrator's own
  // code). UI surfaces "this change requires reload" warning.
  'commit:dormant_pending_reload': {
    taskId: string;
    affectedPaths: readonly string[];
  };
  // A12 — emitted by the plugin loader when a candidate hot-reload is
  // detected (file mtime newer than load mtime). Stub today; will tie
  // into supervisor in Phase 7.
  'module:hot_reload_candidate': {
    moduleId: string;
    detectedAt: number;
    reason: string;
  };
  // A14 — emitted by sleep-cycle when consecutive no-op cycles exceed
  // the plateau threshold. Stub today; future plateau-adaptation logic
  // will lower promotion thresholds in a bounded way.
  'sleep:plateau_detected': {
    cycleId: string;
    consecutiveNoopCycles: number;
    threshold: number;
  };
  // Gap 3 — emitted when a #3 CLI Delegate is asked to modify
  // `src/orchestrator/external-coding-cli/` (its own subsystem). The
  // orchestrator escalates to human approval rather than dispatching.
  'coding-cli:self_application_detected': {
    taskId: string;
    providerId: string;
    targetPaths: readonly string[];
    reason: string;
  };

  // Phase E: File invalidation relay
  'file:hashChanged': { filePath: string; newHash: string; previousHash?: string };

  // Phase D/E/L: Peer lifecycle
  'peer:connected': { peerId: string; instanceId: string; url: string };
  'peer:disconnected': { peerId: string; reason: string };
  'peer:trustChanged': { peerId: string; from: PeerTrustLevel; to: PeerTrustLevel; trigger: string };

  // Phase E: A2A knowledge events
  'a2a:verdictReceived': { peerId: string; oracleName: string; confidence: number };
  'a2a:knowledgeImported': { peerId: string; patternsImported: number; rulesImported: number };
  'a2a:knowledgeOffered': { peerId: string; patternCount: number };
  'a2a:knowledgeAccepted': { peerId: string; acceptedCount: number };

  // Phase v1.1: Coordination
  'a2a:proposalReceived': { peerId: string; proposalId: string; proposalType: string };
  'a2a:commitmentFailed': { peerId: string; commitmentId: string; reason: string };
  'a2a:retractionReceived': { peerId: string; retractionId: string; targetId: string; severity: string };
  'a2a:feedbackReceived': { peerId: string; feedbackId: string; targetId: string; outcome: string };
  'a2a:intentDeclared': { peerId: string; intentId: string; targets: string[]; action: string };
  'a2a:intentConflict': { peerId: string; intentId: string; conflictingIntentId: string };
  'a2a:capabilityUpdated': { peerId: string; instanceId: string; capabilityVersion: number };

  // Phase PH5.8: Instance Coordinator events
  'instance:eventForwarded': { event: string; peerId: string; success: boolean };
  'instance:eventReceived': { event: string; fromInstanceId: string };
  'instance:conflictResolved': {
    taskId: string;
    winner: 'local' | 'remote';
    resolvedAtStep: number;
    explanation: string;
  };
  'instance:profileShared': { peerId: string; profileCount: number };
  'instance:profileImported': { fromInstanceId: string; profileCount: number; reducedConfidence: boolean };

  // Phase PH5.8: Fleet Coordinator events
  'fleet:taskRouted': { taskId: string; targetPeerId: string; reason: string };
  'fleet:capacityUpdate': { instanceId: string; availableSlots: number; totalSlots: number };

  // Phase PH5.8: Sandbox lifecycle events
  'sandbox:created': { containerId: string; taskId: string };
  'sandbox:completed': { containerId: string; taskId: string; exitCode: number; durationMs: number };
  'sandbox:timeout': { containerId: string; taskId: string; timeoutMs: number };
  'sandbox:error': { containerId: string; taskId: string; error: string };

  // Phase 6.4: Delegation events
  'delegation:done': { parentTaskId: string; childTaskId: string; status: string; tokensUsed: number };
  // Agent Conversation §5.6: emitted when handleDelegation dispatches a
  // child task to a peer Vinyan instance instead of a local subprocess.
  // Distinct from delegation:done so dashboards can audit the local-vs-
  // remote split without parsing every delegation:done payload.
  'delegation:remote': { parentTaskId: string; childTaskId: string; peerId: string; status: string };

  // Phase 6.5: Agent session observability
  'agent:session_start': {
    taskId: string;
    routingLevel: number;
    budget: { maxTokens: number; maxTurns: number; contextWindow: number };
  };
  'agent:session_end': {
    taskId: string;
    outcome: string;
    tokensConsumed: number;
    turnsUsed: number;
    durationMs: number;
  };
  'agent:turn_complete': { taskId: string; turnId: string; tokensConsumed: number; turnsRemaining: number };
  /**
   * Tool execution started — emitted by agent-loop BEFORE calling executeTool.
   * UI surfaces this as a "running" tool card for the "full Claude Code feel".
   * Safety: observational only (A3). If the tool then fails / times out,
   * `agent:tool_executed` still fires with `isError:true`, so UI state converges.
   */
  'agent:tool_started': { taskId: string; turnId: string; toolCallId: string; toolName: string; args?: unknown };
  'agent:tool_executed': {
    taskId: string;
    turnId: string;
    toolName: string;
    durationMs: number;
    isError: boolean;
    toolCallId?: string;
  };
  /**
   * Plan / DAG snapshot — emitted by the planning phase after task decomposition
   * and after each subtask transitions state. Surfaced in the UI as a Claude Code
   * "session setup" checklist so the user sees the agent's intent at a glance.
   * Safety: observational only (A3). Steps are derived from the validated DAG;
   * UI never sends this back.
   */
  'agent:plan_update': {
    taskId: string;
    steps: Array<{
      id: string;
      label: string;
      status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
    }>;
  };
  // Agent Conversation: fires when a task returns status='input-required'
  // because either the agent OR the orchestrator paused to ask the user
  // clarifying questions. Consumers (TUI, API streaming, logging) should
  // surface the questions as a friendly prompt, NOT as an error.
  //
  // `source` distinguishes the two paths:
  //   - 'agent':        the worker LLM self-reported uncertainty via
  //                     attempt_completion(needsUserInput=true).
  //   - 'orchestrator': the core loop's Comprehension Check gate fired
  //                     before generation, based on deterministic
  //                     heuristics over the TaskUnderstanding.
  // Field is optional for backward compatibility with listeners that
  // were written before the orchestrator-driven path existed.
  'agent:clarification_requested': {
    taskId: string;
    sessionId?: string;
    /** Legacy string-only rendering. Always populated for back-compat. */
    questions: string[];
    /**
     * Structured questions (Phase D). When present, UIs SHOULD prefer this
     * over `questions` so they can render selectable options. Remains optional
     * so emitters that haven't migrated yet don't need to change shape.
     */
    structuredQuestions?: import('./clarification.ts').ClarificationQuestion[];
    routingLevel: number;
    source?: 'agent' | 'orchestrator';
  };
  /**
   * User's response to a structured clarification. Emitted by UIs (TUI / API
   * WS) so the orchestrator can resume the paused task with the user's
   * selections + free-text override.
   */
  'agent:clarification_response': {
    taskId: string;
    sessionId?: string;
    responses: import('./clarification.ts').ClarificationResponse[];
  };
  /** Agent thinking/rationale — what the LLM is reasoning about this turn. */
  'agent:thinking': { taskId: string; turnId: string; rationale: string };
  /**
   * Token-level assistant text delta (Phase 2 realtime chat). Emitted while
   * an LLM response is being generated, before `agent:turn_complete`. Purely
   * observational — governance decisions NEVER depend on these events (A3).
   * Gated by config.streaming.assistantDelta (default false).
   */
  'agent:text_delta': { taskId: string; turnId?: string; text: string };
  /**
   * Rich LLM stream delta — superset of `agent:text_delta` that carries
   * structured kinds (content / thinking / tool_use_*). Emitted by the
   * agent loop on the orchestrator side after the worker forwards a
   * `stream_delta` NDJSON frame, so A3 stays intact (the bus is emitted
   * in-orchestrator, not from the subprocess).
   *
   * Consumers (ChatStreamRenderer, SSE, VS Code panel) MAY subscribe to
   * either `agent:text_delta` (text-only legacy) or `llm:stream_delta`
   * (rich) — both fire during the same turn when both paths are active.
   */
  'llm:stream_delta': {
    taskId: string;
    turnId?: string;
    engineId?: string;
    kind: 'content' | 'thinking' | 'tool_use_start' | 'tool_use_input' | 'tool_use_end';
    text?: string;
    toolId?: string;
    tool?: string;
    partialJson?: string;
  };
  /**
   * Retry-attempt heartbeat — emitted by an LLM provider before sleeping
   * for backoff between retryable failures (429, 5xx, connect/idle/wall
   * timeouts, transient fetch errors). Carries the upcoming `delayMs` so
   * dashboards can render an ETA card and the delegate watchdog can treat
   * the sleep as live activity rather than a hang.
   *
   * `taskId` is resolved from the request's explicit trace metadata, then
   * the ambient `runWithLLMTrace` context, then the explicit task id the
   * orchestrator passed in. When none of those are set the provider
   * suppresses the emit (no orphan event with an empty correlation id).
   *
   * Observational only (A3): governance never branches on retry events.
   */
  'llm:retry_attempt': {
    taskId: string;
    providerId: string;
    /** 0-indexed attempt that just failed; the upcoming sleep precedes attempt N+1. */
    attempt: number;
    /** Backoff delay in ms before the next attempt fires. */
    delayMs: number;
    /** Short label — error message, status string, or timeout kind. */
    reason: string;
    /** HTTP status code when the retry was triggered by a status response. */
    status?: number;
  };
  /**
   * In-flight heartbeat — emitted at a fixed cadence (default 30s) while
   * an LLM provider call is actually awaiting the network response /
   * stream. Closes the gap that retry-attempt + stream_delta cannot
   * cover: a single non-streaming `provider.generate()` call that takes
   * 90–180s (long-form author / large reasoning) emits NO other event
   * during the wait, which used to look identical to a hang and tripped
   * the delegate watchdog at 120s (incident: author step3 idle timeout
   * after 121s, agent=author).
   *
   * `taskId` is resolved exactly like `llm:retry_attempt`. Suppressed
   * when the trace context cannot bind a taskId — no orphan rows.
   *
   * Internal heartbeat: NOT in the SSE / event-manifest delivery list.
   * UIs that need a "thinking" indicator should listen to
   * `agent:thinking` / `llm:stream_delta` instead — this event is
   * scoped to watchdog liveness only and would be too chatty for chat
   * UIs that already render token streaming directly.
   *
   * Observational only (A3).
   */
  'llm:request_alive': {
    taskId: string;
    providerId: string;
    /** 0-indexed attempt this heartbeat belongs to (resets per retry). */
    attempt: number;
    /** Total elapsed ms since the current attempt started. */
    durationMs: number;
  };
  /**
   * Outbound provider quota / rate-limit governance — surfaced when an LLM
   * provider returns 429 RESOURCE_EXHAUSTED (Google AI Studio quota), 429
   * rate_limited, or any other failure that carries a `retryAfterMs`. The
   * `taskId` is resolved exactly like `llm:retry_attempt`. Observational
   * only (A3) — governance branches consume the normalized error directly.
   *
   * Carries the canonical normalized fields (kind/status/retryAfterMs/
   * quotaMetric/quotaId) so a UI can render a "rate-limited until 12:34"
   * pill without re-parsing provider error bodies.
   */
  'llm:provider_quota_exhausted': {
    taskId: string;
    providerId: string;
    tier?: string;
    model?: string;
    errorKind: 'quota_exhausted' | 'rate_limited';
    status?: number;
    retryAfterMs?: number;
    quotaMetric?: string;
    quotaId?: string;
    message: string;
  };
  /** Cooldown bucket opened in the health store. Drives the dashboard "cooled-down" pill. */
  'llm:provider_cooldown_started': {
    taskId?: string;
    providerId: string;
    tier?: string;
    model?: string;
    errorKind: import('../orchestrator/llm/provider-errors.ts').LLMProviderErrorKind;
    cooldownUntil: number;
    retryAfterMs?: number;
    quotaMetric?: string;
    quotaId?: string;
    failureCount: number;
    message: string;
  };
  /** Selection skipped a provider because its bucket was still in cooldown. */
  'llm:provider_cooldown_skipped': {
    taskId?: string;
    providerId: string;
    tier?: string;
    model?: string;
    cooldownUntil: number;
    rationale: string;
  };
  /** Selection picked an alternate provider because the preferred one was unavailable. */
  'llm:provider_fallback_selected': {
    taskId?: string;
    fromProviderId: string;
    fromTier?: string;
    toProviderId: string;
    toTier?: string;
    rationale: string;
  };
  /** No provider available for this tier / capability — task degrades or fails honestly. */
  'llm:provider_unavailable': {
    taskId?: string;
    requestedTier?: string;
    rationale: string;
    nextRetryHintMs?: number;
  };
  /** A previously cooled-down provider successfully completed a request. */
  'llm:provider_recovered': {
    providerId: string;
    tier?: string;
    model?: string;
    cooldownDurationMs: number;
  };
  /**
   * Internal — emitted by `ProviderHealthStore.emit` so non-bus subscribers
   * (status endpoint cache, metrics) can listen without hooking the public
   * lifecycle events. NOT in the SSE/event-manifest delivery list.
   */
  'llm:provider_health_changed': {
    type: 'cooldown_started' | 'cooldown_extended' | 'recovered' | 'unavailable';
    providerId: string;
    tier?: string;
    model?: string;
    cooldownUntil: number;
    failureCount: number;
    kind: import('../orchestrator/llm/provider-errors.ts').LLMProviderErrorKind;
    taskId?: string;
  };
  // EO #5: Dual-track transcript compaction
  'agent:transcript_compaction': { taskId: string; evidenceTurns: number; narrativeTurns: number; tokensSaved: number };
  // EO #1+#4: DAG execution observability
  'dag:executed': { taskId: string; nodes: number; parallel: boolean; fileConflicts: number };

  // Intent Resolution (pre-pipeline LLM classification)
  'intent:resolved': {
    taskId: string;
    strategy: string;
    confidence: number;
    reasoning: string;
    /** Epistemic state: `known` | `uncertain` | `contradictory`. */
    type?: string;
    /** Origin of the decision: `deterministic`, `llm`, `merged`, `cache`, `fallback`. */
    source?: string;
  };
  /** Deterministic rule and LLM disagreed — A5 tier order selected the winning strategy. */
  'intent:contradiction': {
    taskId: string;
    ruleStrategy: string;
    llmStrategy: string;
    ruleConfidence: number;
    llmConfidence: number;
    winner: string;
  };
  /** Low-confidence or ambiguous resolution — user clarification requested. */
  'intent:uncertain': {
    taskId: string;
    reason: string;
    clarificationRequest: string;
  };
  /** Cache hit — re-used a prior resolution without re-classifying. */
  'intent:cache_hit': { taskId: string; cacheKey: string };
  /**
   * Persona inside the conversational shortcircuit emitted the escape
   * sentinel; the orchestrator re-routed the task to agentic-workflow.
   * Bound at one re-route per task via `TaskInput.intentEscapeAttempts`.
   */
  'intent:escape_sentinel_fired': {
    taskId: string;
    persona?: string;
    reason: string;
  };
  /**
   * Persona's conversational answer claimed delegation in plain prose
   * ("I forwarded this to X agent") without emitting the escape sentinel.
   * Defense-in-depth detector — same re-route consequence as the sentinel.
   * Bound at one re-route per task via `TaskInput.intentEscapeAttempts`.
   */
  'intent:hallucinated_delegation_detected': {
    taskId: string;
    persona?: string;
    snippet?: string;
    locale?: 'thai' | 'english';
  };
  /**
   * Deterministic short-affirmative pre-classifier reconstructed intent from
   * the immediately prior unfulfilled deliverable proposal. Avoids one LLM
   * call and prevents the "ack-without-action" failure mode.
   */
  'intent:short_affirmative_matched': {
    taskId: string;
    reconstructedFromTurnSeq: number;
    reason: string;
  };
  /**
   * Deterministic short-retry pre-classifier reconstructed intent from the
   * immediately prior failed/refused assistant turn. Avoids re-routing a
   * bare "retry" to conversational shortcircuit (which would lose the
   * original goal entirely).
   */
  'intent:short_retry_matched': {
    taskId: string;
    reconstructedFromTurnSeq: number;
    reason: string;
  };

  // STU: Semantic Task Understanding events
  'understanding:layer0_complete': { taskId: string; durationMs: number; verb: string; category: string };
  'understanding:layer1_complete': {
    taskId: string;
    durationMs: number;
    entitiesResolved: number;
    isRecurring: boolean;
  };
  'understanding:layer2_complete': { taskId: string; durationMs: number; hasIntent: boolean; depth: number };
  'understanding:claims_verified': {
    taskId: string;
    durationMs: number;
    totalClaims: number;
    knownClaims: number;
    contradictoryClaims: number;
  };
  'understanding:calibration': { taskId: string; entityAccuracy: number; categoryMatch: boolean };

  // Conversation Comprehension (pre-routing) — A1: engine proposes, oracle verifies,
  // orchestrator commits. Consumers (dashboards, TraceCollector, SelfModel) subscribe
  // to the triad to reconstruct the full decision trail for a turn.
  'comprehension:generated': {
    taskId: string;
    engineId: string;
    tier: string;
    type: 'comprehension' | 'unknown';
    confidence: number;
    inputHash: string;
    durationMs: number;
  };
  'comprehension:verified': {
    taskId: string;
    verified: boolean;
    verdictType: 'known' | 'unknown' | 'uncertain' | 'contradictory';
    tier: string;
    rejectReason?: string;
    durationMs: number;
  };
  'comprehension:committed': {
    taskId: string;
    /** Final resolvedGoal the orchestrator will route on. */
    resolvedGoal: string;
    /** True when oracle accepted the engine's envelope and the payload was usable. */
    used: boolean;
    /** Short reason when `used` is false (fell back to literal goal). */
    fallbackReason?: string;
  };
  /**
   * A7 learning loop (P2.A): fires when the CorrectionDetector labels
   * the prior turn's comprehension record with an outcome. Calibration
   * consumers (SelfModel, dashboards) subscribe to integrate accuracy
   * over time; per-engine EMA lives in ComprehensionCalibrator.
   */
  'comprehension:calibrated': {
    taskId: string;
    priorInputHash: string;
    engineId: string;
    outcome: 'confirmed' | 'corrected' | 'abandoned';
    evidence: Record<string, unknown>;
  };
  /**
   * AXM#3 (A7 observability): fires when an engine's recent-window
   * accuracy has dropped materially vs its historical-window. The
   * orchestrator treats this as an early warning — downstream
   * consumers (oracle tier-clamp, dashboards) react without requiring
   * human intervention.
   */
  'comprehension:calibration_diverged': {
    taskId: string;
    engineId: string;
    engineType: string;
    recentAccuracy: number;
    historicalAccuracy: number;
    delta: number;
    recentSamples: number;
    historicalSamples: number;
  };
  /**
   * P3.A — fires when `effectiveCeiling` has tightened an engine's
   * confidence relative to its base `confidenceCeiling`. The LLM
   * comprehender's self-reported confidence is then clamped to this
   * tighter value. Observability + sanity — operators can watch the
   * system auto-damping a degraded engine.
   */
  'comprehension:ceiling_adjusted': {
    taskId: string;
    engineId: string;
    /** Ceiling before divergence adjustment. */
    baseCeiling: number;
    /** Effective ceiling after divergence adjustment. */
    effectiveCeiling: number;
    /** `baseCeiling - effectiveCeiling` — how much got tightened. */
    tightening: number;
  };
  /**
   * AXM#7 wiring: fires when an engine's Brier score exceeds the
   * miscalibration threshold (> 0.25 = worse than a coin flip) — the
   * engine's confidence outputs are systematically misleading. A7
   * signal; consumers (tier-clamp, dashboards) can tighten further.
   */
  'comprehension:miscalibrated': {
    taskId: string;
    engineId: string;
    brier: number;
    sampleSize: number;
    threshold: number;
  };
  /**
   * GAP#6 — paired recovery event. Fires when an engine that was
   * previously miscalibrated (Brier > threshold) has now dropped back
   * below threshold. Operators use this to see engines come back
   * online; LlmComprehender's self-recusal stops firing after the next
   * calibrated call when Brier is good.
   */
  'comprehension:recalibrated': {
    taskId: string;
    engineId: string;
    brier: number;
    sampleSize: number;
    threshold: number;
  };
  /**
   * Sleep Cycle comprehension miner result (B1–B3). Fired once per
   * `SleepCycleRunner.run()` when mining completes (even when no
   * insights were produced — consumers dedupe on `minedAt`). Payload
   * mirrors the miner's `MiningResult` shape so dashboards can tail
   * the bus without importing miner types at runtime.
   */
  'comprehension:mining_completed': {
    /** Sleep-cycle id that triggered this mining pass (for correlation
     *  with `sleep:cycleComplete`, `agent:evolved`, etc.). */
    cycleId: string;
    minedAt: number;
    windowSinceMs: number;
    rowsScanned: number;
    insights: ReadonlyArray<import('../orchestrator/comprehension/learning/miner.ts').ComprehensionInsight>;
  };

  // Extensible Thinking events
  'thinking:policy-compiled': {
    taskId: string;
    policy: import('../orchestrator/thinking/thinking-policy.ts').ThinkingPolicy;
    routingLevel: number;
  };
  // Phase 2.2+: Emitted by counterfactual retry handler when re-attempting with deeper thinking
  'thinking:counterfactual-retry': { taskId: string; routingLevel: number; retryCount: number; failureReason: string };
  // Phase 2.2+: Emitted when escalation chooses lateral (model swap), vertical (budget increase), or refuse
  'thinking:escalation-path-chosen': {
    taskId: string;
    path: 'lateral' | 'vertical' | 'refuse';
    fromLevel?: number;
    toLevel?: number;
  };
  // Emitted by trace-collector after a task completes, pairing the
  // thinking mode that was used with the measured outcome. Consumed by the
  // thinking readiness gate (`TraceStore.getSuccessRateByThinkingMode`) to
  // decide when adaptive thinking is unblocked — requires ≥100 traces total
  // and a measurable success-rate delta between thinking modes. Payload is
  // deliberately flat so offline analysis tooling can tail the bus without
  // loading the full trace.
  'thinking:policy-evaluated': {
    taskId: string;
    thinkingMode: string | null;
    thinkingTokensUsed: number | null;
    routingLevel: number;
    outcome: 'success' | 'failure' | 'timeout' | 'escalated' | 'partial';
    qualityComposite: number | null;
    oracleCompositeScore: number | null;
  };

  // Thinking readiness verdict — emitted by sleep-cycle after evaluating
  // thinking mode A/B readiness. Consumed by dashboards and adaptive thinking opt-in.
  'thinking:readiness-evaluated': {
    status: 'blocked' | 'ready';
    reason?: string;
    bestMode?: string;
    successRateDelta?: number;
    totalTraces: number;
  };

  // Monitoring — Self-Improving Autonomy events.
  // Per-oracle EMA accuracy update — emitted on warm-threshold crossings
  // and on accuracy moves of ≥ 0.01. Dashboards / sleep-cycle promotion
  // logic can subscribe to track engine reliability over time.
  'monitoring:oracle_calibration': {
    oracleName: string;
    accuracy: number;
    observationCount: number;
    warm: boolean;
  };
  // Drift detected between SelfModel prediction and actual trace outcome.
  // `triggeredDimensions` is the ordered list of dimension names that
  // crossed their threshold (testResults | blastRadius | duration |
  // qualityScore). `maxRelDelta` is useful for severity ranking.
  'monitoring:drift_detected': {
    taskId: string;
    triggeredDimensions: string[];
    maxRelDelta: number;
  };
  // Silent regression alert: rolling-window success rate dropped below
  // baseline for one task type. Cool-down enforced inside RegressionMonitor
  // so dashboards don't get spammed by persistent regressions.
  'monitoring:silent_regression': {
    taskTypeSignature: string;
    recentSuccessRate: number;
    baselineSuccessRate: number;
    drop: number;
    observations: number;
  };

  // Economy Operating System events (Layer 1)
  'economy:cost_recorded': {
    taskId: string;
    engineId: string;
    computed_usd: number;
    cost_tier: 'billing' | 'estimated';
  };
  'economy:budget_warning': {
    window: 'hour' | 'day' | 'month';
    utilization_pct: number;
    spent_usd: number;
    limit_usd: number;
  };
  'economy:budget_exceeded': {
    window: 'hour' | 'day' | 'month';
    spent_usd: number;
    limit_usd: number;
    enforcement: string;
  };
  /**
   * G6 soft-degrade hint: emitted at the 80% warning threshold when
   * `budgets.degrade_on_warning` is enabled. Listeners may use the
   * `soft_degrade_to_level` to downgrade non-critical phase routing
   * before the hard cap is exceeded.
   */
  'economy:budget_soft_degrade': {
    window: 'hour' | 'day' | 'month';
    utilization_pct: number;
    soft_degrade_to_level: number;
  };
  'economy:budget_degraded': { taskId: string; fromLevel: number; toLevel: number; reason: string };
  'economy:rate_card_miss': { engineId: string; fallback: string };

  // Economy Layer 2 events
  'economy:cost_predicted': { taskId: string; predicted_usd: number; confidence: number; basis: string };
  'economy:budget_allocated': { taskId: string; maxTokens: number; source: string };
  'economy:cost_pattern_found': { patternId: string; type: string; description: string };

  // Economy Layer 3: Market events
  'market:auction_started': { auctionId: string; taskId: string; eligibleBidders: number };
  'market:auction_completed': {
    auctionId: string;
    taskId: string;
    winnerId: string;
    score: number;
    bidderCount: number;
  };
  'market:fallback_to_selector': { taskId: string; reason: string };
  'market:settlement_recorded': { settlementId: string; bidAccuracy: number; penaltyType: string | null };
  'market:collusion_suspected': { auctionId: string; bidSpread: number; consecutiveCount: number };
  'market:phase_transition': { from: string; to: string; reason: string };

  // Economy Layer 4: Federation economy events
  'economy:federation_cost_received': { fromInstanceId: string; taskId: string; computed_usd: number };
  'economy:federation_cost_broadcast': { taskId: string; computed_usd: number; peerCount: number };
  'economy:peer_price_negotiated': { peerId: string; taskType: string; agreed_usd: number };
  'economy:economic_dispute': { disputeId: string; type: string; resolution: string };

  // K2.2: Engine selection events
  'engine:selected': { taskId: string; provider: string; trustScore: number; reason: string };

  // Phase-11: skill usage instrumentation. `skill:viewed` is emitted by
  // ToolExecutor when the LLM invokes the `skill_view` tool with a skill id.
  // SkillUsageTracker subscribes and aggregates per-task viewed sets so the
  // overclaim comparator can flag bids that loaded more skills than they used.
  'skill:viewed': { taskId: string; skillId: string };
  /**
   * Phase-11: emitted at task completion when a bid's loaded-skill loadout
   * exceeded what the LLM actually viewed during execution. Producer:
   * factory's executeTask wrapper after recordTaskOutcomeForPersona. M1
   * mitigation — fills the long-reserved `overclaim_violations` counter
   * surface with real data.
   */
  'bid:overclaim_detected': {
    taskId: string;
    agentId: string;
    declaredCount: number;
    viewedCount: number;
    viewedRatio: number;
  };

  /**
   * Hybrid skill redesign — emitted when a Claude-Code-style simple skill
   * accumulates enough outcome evidence to graduate into the heavy
   * SKILL.md schema. Producer: `runSimpleSkillPromoter` invoked from the
   * sleep cycle. Listeners can show "skill X is now in the audited stack"
   * notifications.
   */
  'skill:graduated_from_simple': {
    cycleId: string;
    promoted: Array<{
      name: string;
      /** Heavy artifact-store id (`<agent>/<name>` per-agent, `<name>` shared). */
      heavySkillId: string;
      /** Agent the simple skill was bound to, null when shared-scope. */
      agentId: string | null;
      trials: number;
      successRate: number;
    }>;
  };

  /**
   * Hybrid skill redesign — emitted by the worker-pool every time a simple
   * skill body is inlined into a task's prompt. Factory subscribes to track
   * per-task invocation sets so simple-skill outcomes can be recorded at
   * task completion (separate from heavy-stack `skill:viewed`).
   */
  'skill:simple_invoked': {
    taskId: string;
    skillName: string;
    /** Where the skill was loaded from. */
    scope: 'user' | 'project' | 'user-agent' | 'project-agent';
    /** Agent the skill is bound to, when scope is `*-agent`. */
    agentId?: string;
  };

  /**
   * Phase-13: emitted by the workflow-executor's `delegate-sub-agent` path
   * when A1 Epistemic Separation forced the sub-task onto the canonical
   * Verifier persona instead of inheriting the parent's agentId. Producer:
   * `selectVerifierForDelegation` returning a non-null id. Useful for
   * observability — confirms the A1 guard fired without inspecting the
   * sub-task's resulting trace.
   */
  'workflow:a1_verifier_routed': {
    taskId: string;
    stepId: string;
    generatorAgentId: string | null;
    verifierAgentId: string;
  };

  /**
   * Wall-clock cap fired on a `delegate-sub-agent` step. Without this guard
   * a free-tier 429 retry loop inside the sub-agent could hang the entire
   * workflow indefinitely — incident: session ede9e9e1 sat for 40 min after
   * 3 delegates stalled with no honest failure. Step is then marked failed
   * and the executor proceeds (skipping dependents, surfacing partial
   * results via the honesty fast-path).
   */
  'workflow:delegate_timeout': {
    taskId: string;
    stepId: string;
    agentId: string | null;
    timeoutMs: number;
  };

  /**
   * Multi-agent UI surface: a `delegate-sub-agent` step has been dispatched.
   * Lets the chat UI show the sub-agent as "running" immediately without
   * waiting for the child task's own `task:start` to bubble up. Carries
   * stepId so the agent-timeline card can attach this row to the parent
   * plan checklist by step id.
   */
  'workflow:delegate_dispatched': {
    taskId: string;
    stepId: string;
    agentId: string | null;
    subTaskId: string;
    stepDescription: string;
  };

  /**
   * Multi-agent UI surface: a `delegate-sub-agent` step has finished
   * (success / failure). Carries the resolved agent persona + a short
   * output preview so the timeline can show what each sub-agent actually
   * said before the parent's synthesizer runs. Pairs with
   * `workflow:delegate_dispatched` to bracket the agent's lifecycle on
   * the chat surface.
   */
  'workflow:delegate_completed': {
    taskId: string;
    stepId: string;
    subTaskId: string;
    agentId: string | null;
    status: 'completed' | 'failed' | 'skipped';
    outputPreview: string;
    tokensUsed: number;
  };

  /**
   * Synthesizer LLM ignored the STITCHER rule and compressed/paraphrased
   * step outputs into a tight register. Observability event for the
   * compression safety net in `buildResult` — the executor discards the
   * synthesizer's output and falls back to a deterministic concat to
   * preserve voice diversity. Fired only when the workflow has
   * substantial output (>1500 bytes total) and the LLM compressed below
   * 25%, indicating paraphrase not legitimate consolidation.
   */
  'workflow:synthesizer_compression_detected': {
    taskId: string;
    stepOutputBytes: number;
    synthesizedBytes: number;
    compressionRatio: number;
  };

  /**
   * Planner-emitted plan failed validation: it referenced an agent id not
   * in the live registry (hallucinated) OR assigned the same agentId to
   * multiple `delegate-sub-agent` steps (duplicate, would produce false
   * diversity). The offending `agentId` was dropped from each step before
   * dispatch; the affected delegates run with default routing and their
   * UI rows render with `agent?` instead of misattributing to a persona
   * that didn't actually answer.
   */
  'workflow:planner_validation_warning': {
    goal: string;
    hallucinatedAgentIds: Array<{ stepId: string; agentId: string }>;
    duplicateAgentIds: Array<{ stepId: string; agentId: string }>;
  };

  /**
   * Phase-14 (Item 4): emitted by the agent-loop's `handleDelegation` path
   * when A1 forced the delegated sub-task to the canonical Verifier persona.
   * Mirrors `workflow:a1_verifier_routed` but for the agent-loop (LLM-driven
   * delegate tool) dispatch surface — closes the parallel-dispatch A1 hole.
   */
  'delegation:a1_verifier_routed': {
    taskId: string;
    parentAgentId: string | null;
    verifierAgentId: string;
    requestedTargetAgentId: string | null;
  };

  // Crash Recovery: task checkpoint events
  'task:recovered': { taskId: string; input: TaskInput; abandoned: boolean };

  // Hallucination Mitigation System events
  'hms:grounding_result': { taskId: string; verified: number; refuted: number; grounding_ratio: number };
  'hms:overconfidence_detected': { taskId: string; score: number; certainty_markers: number };
  'hms:risk_scored': { taskId: string; risk: number; primary_signal: string };
  'hms:cross_validation_complete': { taskId: string; consistency: number; probes_sent: number };

  // Economy OS activation events
  'human:review_requested': { taskId: string; prompt: string; timeoutMs: number };
  'human:review_completed': { taskId: string; content: string; reviewerId?: string };
  'market:auto_activated': { costRecordCount: number; engineCount: number; fromPhase: string; toPhase: string };
  'market:settlement_accurate': { provider: string; capability?: string; taskId: string };
  'market:settlement_inaccurate': { provider: string; capability?: string; taskId: string };
  'economy:cost_pattern_detected': { patternId: string; type: string; engineId: string; taskType: string };

  // Wave 1: Goal-Satisfaction Outer Loop
  'goal-loop:iteration-start': { taskId: string; iteration: number };
  'goal-loop:terminal': { taskId: string; iteration: number; status: TaskResult['status'] };
  'goal-loop:evaluation': {
    taskId: string;
    iteration: number;
    score: number;
    basis: string;
    passedChecks: string[];
    failedChecks: string[];
    accountabilityGrade?: import('../orchestrator/goal-satisfaction/goal-evaluator.ts').AccountabilityGrade;
  };
  'goal-loop:accountability-block': {
    taskId: string;
    iteration: number;
    score: number;
    blockers: import('../orchestrator/goal-satisfaction/goal-evaluator.ts').GoalBlocker[];
  };
  /**
   * Slice 4 Gap B (A7): emitted when the worker self-graded and the
   * deterministic evaluator computed its own grade. Pure observation —
   * the orchestrator does not act on this directly; it is consumed by
   * dashboards and the calibration ledger to track over/underconfidence.
   */
  'goal-loop:prediction-error': {
    taskId: string;
    iteration: number;
    selfGrade: import('../orchestrator/goal-satisfaction/goal-evaluator.ts').AccountabilityGrade;
    deterministicGrade: import('../orchestrator/goal-satisfaction/goal-evaluator.ts').AccountabilityGrade;
    magnitude: import('../orchestrator/goal-satisfaction/goal-evaluator.ts').PredictionErrorMagnitude;
    direction: 'aligned' | 'overconfident' | 'underconfident';
  };
  'goal-loop:exhausted': { taskId: string; iteration: number };
  'goal-loop:no-replan': { taskId: string; iteration: number };
  'goal-loop:budget-exhausted': { taskId: string; iteration: number };
  'goal-loop:replan-exhausted': { taskId: string; iteration: number };
  'goal-loop:negative-momentum': {
    taskId: string;
    iteration: number;
    trajectory: import('../orchestrator/goal-satisfaction/goal-evaluator.ts').GoalTrajectory;
  };

  // Wave C: Content hash verification
  'gate:content_hash_mismatch': {
    file: string;
    oracleName: string;
    expected: string;
    actual: string;
  };

  // Wave 2: Replan Engine observability
  'replan:accepted': { taskId: string; iteration: number; planSignature: string };
  'replan:rejected': { taskId: string; iteration: number; reason: string };

  /**
   * ProcessStateReconciler observability — fires once per reconcile call
   * (task or session) AFTER the durable history catches up with what
   * SSE may have dropped. Internal only: NOT in `event-manifest.ts`,
   * NOT forwarded over SSE, NOT persisted. Operators read it via metrics
   * / logs / a future dashboard panel to track "how often does SSE lose
   * events?" — that's the question the reconciler exists to answer.
   *
   * `truncated: true` indicates the page-cap or fetch-timeout safety net
   * fired; the host should treat the cycle as incomplete and may retry.
   */
  'reconciler:replayed': {
    scope: 'task' | 'session';
    scopeId: string;
    appliedCount: number;
    durationMs: number;
    truncated: boolean;
  };

  // Wave 5: Reactive micro-learning — failure cluster signal
  'failure:cluster-detected': { taskSignature: string; failureCount: number; taskIds: string[] };
  'reactive:rule-generated': {
    ruleId: string;
    taskSignature: string;
    action: string;
    specificity: number;
  };
  'reactive:rule-skipped': { taskSignature: string; reason: string };

  // Wave 4: Agent-loop goal-check observability
  'agent-loop:goal-check': {
    taskId: string;
    score: number;
    decision: 'accept' | 'continue' | 'reject';
    reason: string;
  };

  // Room dispatcher observability — emitted by src/orchestrator/room/room-dispatcher.ts.
  // Declared here (rather than the parallel room-dispatcher PR) because cross-file
  // bus event declarations must live in a single shared schema for type safety.
  'room:opened': {
    roomId: string;
    parentTaskId: string;
    roles: string[];
    maxRounds: number;
  };
  'room:failed': {
    roomId: string;
    reason: string;
    rounds: number;
  };
  'room:converged': {
    roomId: string;
    rounds: number;
    mutations: number;
    confidence: number;
  };
  'room:message_committed': {
    roomId: string;
    seq: number;
    author: string;
    entryType: string;
  };
  'room:participant_admitted': {
    roomId: string;
    participantId: string;
    roleName: string;
    workerModelId: string;
  };
  'room:blackboard_updated': {
    roomId: string;
    key: string;
    author: string;
    version: number;
  };
  'room:round_completed': {
    roomId: string;
    round: number;
    participantsActed: number;
    tokensConsumedThisRound: number;
    convergence: 'converged' | 'partial' | 'open';
  };

  // Wave A: Error attribution — A7 learning loop closure
  'learning:error_attributed': {
    taskId: string;
    correctionType: string;
    detail: string;
    applied: boolean;
  };
  'learning:success_pattern': {
    taskSignature: string;
    approach: string;
    commonOracles: string[];
    occurrences: number;
  };

  // A2A cross-instance rooms (R3) — scoped communication channels between peers.
  'a2a:roomCreated': { roomId: string; name: string; roomType: string; creatorInstanceId: string };
  'a2a:roomJoined': { roomId: string; instanceId: string; peerUrl: string };
  'a2a:roomLeft': { roomId: string; instanceId: string };
  'a2a:roomArchived': { roomId: string };
  'a2a:roomMessage': { roomId: string; senderId: string; messageType: string; summary: string };

  // Workflow orchestration — self-orchestrating agent workflow planner + executor
  'workflow:plan_created': { goal: string; stepCount: number; strategies: string[] };
  /**
   * Phase E: fires once per task after the plan has been finalized (research
   * injection applied) and BEFORE any step executes. UIs use this to render a
   * human-readable TODO checklist and — when `awaitingApproval=true` —
   * display an approval prompt whose copy and timeout behaviour depend on
   * `approvalMode`:
   *   - 'agent-discretion': review window; on timeout Vinyan auto-decides
   *     via `evaluateAutoApproval` (read-only → approve; mutating → reject).
   *     `autoDecisionAllowed` is true, `timeoutMs` is the review window.
   *   - 'human-required':   only a human may decide. Timeout MUST NOT
   *     auto-approve. `autoDecisionAllowed` is false; UI must not show
   *     auto-approval copy.
   * Older listeners that ignore the new fields keep working — the legacy
   * `awaitingApproval` boolean is preserved.
   */
  'workflow:plan_ready': {
    taskId: string;
    goal: string;
    steps: Array<{ id: string; description: string; strategy: string; dependencies: string[] }>;
    /** True when the orchestrator is waiting for the user to approve before executing. */
    awaitingApproval: boolean;
    /**
     * Approval mode for this plan. Optional for back-compat; treat absence
     * as 'agent-discretion' when `awaitingApproval=true`.
     */
    approvalMode?: 'agent-discretion' | 'human-required';
    /**
     * Approval window the backend will honor before timing out the gate.
     * UI uses this for the countdown bar — do not hardcode a default.
     */
    timeoutMs?: number;
    /**
     * Whether Vinyan may auto-decide on timeout. False for 'human-required'.
     * UI gates auto-approval copy on this flag.
     */
    autoDecisionAllowed?: boolean;
  };
  /**
   * User (via TUI / HTTP / WS) approved a plan that was awaiting approval —
   * OR Vinyan auto-approved on timeout via `evaluateAutoApproval` (rule-based
   * discretion over the plan; A3-compliant). Dashboards distinguish the two
   * via the optional `auto: true` flag and the verdict `rationale`.
   */
  'workflow:plan_approved': {
    taskId: string;
    sessionId?: string;
    /** True when Vinyan auto-approved on approval-timeout. Absent / false otherwise. */
    auto?: boolean;
    /** Verdict rationale from `evaluateAutoApproval` when `auto === true`. */
    rationale?: string;
  };
  /**
   * User rejected a plan, OR Vinyan rule-based auto-rejected the plan on
   * approval-timeout (the plan contained `full-pipeline` or destructive
   * `direct-tool` steps that need a human reviewer on the line).
   */
  'workflow:plan_rejected': {
    taskId: string;
    sessionId?: string;
    reason?: string;
    /** True when Vinyan auto-rejected on approval-timeout. Absent / false otherwise. */
    auto?: boolean;
    /** Verdict rationale from `evaluateAutoApproval` when `auto === true`. */
    rationale?: string;
  };
  /**
   * Per-step workflow progress. `taskId` (and `sessionId` when known)
   * MUST be present so durable recording via TaskEventStore and the
   * session-scoped SSE membership filter can attribute the event to the
   * right turn — without it, a multi-task session sees freezes when
   * step events drop or interleave.
   */
  'workflow:step_start': {
    taskId: string;
    sessionId?: string;
    stepId: string;
    strategy: string;
    description: string;
  };
  'workflow:step_complete': {
    taskId: string;
    sessionId?: string;
    stepId: string;
    status: 'completed' | 'failed' | 'skipped';
    strategy: string;
    durationMs: number;
    tokensConsumed: number;
  };
  'workflow:step_fallback': {
    taskId: string;
    sessionId?: string;
    stepId: string;
    primaryStrategy: string;
    fallbackStrategy: string;
  };
  'workflow:research_injected': { goal: string; reason: string };
  'workflow:complete': { goal: string; status: string; stepsCompleted: number; totalSteps: number };
  'workflow:knowledge_query': { stepId: string; query: string };
  /**
   * Workflow executor hit a `human-input` step and is paused waiting for
   * the user's answer. Carries `taskId` so UIs can correlate the question
   * to the live streaming turn (without it the frontend cannot tell which
   * turn's bubble should render the input prompt). The matching response
   * event is `workflow:human_input_provided` with the same `taskId` +
   * `stepId`.
   */
  'workflow:human_input_needed': { taskId: string; sessionId?: string; stepId: string; question: string };
  /**
   * User answered an in-plan `human-input` step. Resolves the executor's
   * paused `human-input` dispatch — `value` becomes the step's `output` and
   * downstream dependents continue. Emitted by the API endpoint the chat
   * UI's input card POSTs to.
   */
  'workflow:human_input_provided': {
    taskId: string;
    stepId: string;
    value: string;
    sessionId?: string;
  };
  /**
   * Runtime gate fired AFTER the execution loop completes when at least one
   * step failed AND its cascade caused at least one dependent step to skip.
   * Distinguishes "true partial failure" (user's plan can no longer deliver
   * what they asked for) from "isolated leaf failure" (a side step failed,
   * main work intact). Without this gate the executor silently shipped the
   * partial aggregation as if everything was fine — see image-4 reproduction
   * in docs/design/multi-agent-hardening-roadmap.md (incident 2026-04-29).
   *
   * Sub-tasks (`input.parentTaskId` set) bypass this gate — the parent's
   * gate covers the user's decision surface. Matching response event is
   * `workflow:partial_failure_decision_provided` with the same `taskId`.
   */
  'workflow:partial_failure_decision_needed': {
    taskId: string;
    sessionId?: string;
    /** Steps the executor attempted that returned status='failed'. */
    failedStepIds: string[];
    /** Steps the cascade-skipped because their dep failed. */
    skippedStepIds: string[];
    /** Steps that completed normally — for "we have N answers" UI copy. */
    completedStepIds: string[];
    /** Short human-readable summary used as the card title. */
    summary: string;
    /** Truncated preview of the aggregation that would ship if user picks 'continue'. */
    partialPreview?: string;
    /** Wait window before executor auto-aborts. */
    timeoutMs: number;
  };
  /**
   * User decided whether to ship the partial result. Resolves the executor's
   * paused gate. `auto: true` indicates the executor self-emitted on timeout
   * (no user input arrived within `timeoutMs`); the executor's own listener
   * ignores those self-emits to avoid re-settling its own promise.
   */
  /**
   * Stage Manifest — emitted right after the workflow planner finalizes a
   * plan and BEFORE any step executes (and BEFORE the approval gate). Powers
   * the chat UI's process-replay surface so reload / SSE recovery can
   * reconstruct what Vinyan decided to do, what plan it built, what todo
   * checklist exists, and which sub-agent owns each delegated subtask —
   * without inferring shape client-side. A3-compliant: classification is
   * rule-based on planner output, no LLM post-processing.
   */
  'workflow:decision_recorded': import('../orchestrator/workflow/stage-manifest.ts').WorkflowDecisionRecordedEvent;
  'workflow:todo_created': import('../orchestrator/workflow/stage-manifest.ts').WorkflowTodoCreatedEvent;
  'workflow:todo_updated': import('../orchestrator/workflow/stage-manifest.ts').WorkflowTodoUpdatedEvent;
  'workflow:subtasks_planned': import('../orchestrator/workflow/stage-manifest.ts').WorkflowSubtasksPlannedEvent;
  'workflow:subtask_updated': import('../orchestrator/workflow/stage-manifest.ts').WorkflowSubtaskUpdatedEvent;
  /**
   * COMPETITION-mode synthesizer's structured verdict. Emitted ONLY after
   * the synthesis output's fenced JSON block parses against
   * {@link import('../orchestrator/workflow/stage-manifest.ts').WinnerVerdict}
   * AND `winnerAgentId` (when non-null) is in the participating delegate
   * set. Absence of this event ⇒ no winner declared (legacy turn,
   * non-competition, parse failed, or hallucinated id) — UI must NEVER
   * infer winners from agent order or speed.
   *
   * `winnerAgentId === null` is a deliberate "no clear winner / tie"
   * verdict and is distinct from "event never emitted".
   */
  'workflow:winner_determined': import('../orchestrator/workflow/stage-manifest.ts').WorkflowWinnerDeterminedEvent;

  'workflow:partial_failure_decision_provided': {
    taskId: string;
    decision: 'continue' | 'abort';
    sessionId?: string;
    /** Optional free-text user note. */
    rationale?: string;
    /** True when executor auto-aborted on timeout. */
    auto?: boolean;
  };
  // Agent Context Layer: emitted during sleep cycle when agent identities are refined
  'agent:evolved': {
    cycleId: string;
    agentsEvolved: number;
    episodesCompacted: number;
    personasRefined: number;
    skillsGraduated: number;
    soulsEvolved: number;
  };
  // Living Agent Soul: emitted when an agent's SOUL.md is synthesized
  'agent:soul-evolved': {
    agentId: string;
    version: number;
  };
  // Phase 2: AgentRouter decision for specialist selection
  'agent:routed': {
    taskId: string;
    agentId: string;
    reason: 'override' | 'rule-match' | 'needs-llm' | 'default' | 'synthesized';
    score: number;
  };
  /**
   * Phase B (capability-first): a task-scoped synthetic agent was built
   * because no existing specialist's CapabilityClaims covered the task's
   * required capabilities. The agent is registered for the lifetime of
   * the task and unregistered in `executeTask`'s finally.
   */
  'agent:synthesized': {
    taskId: string;
    agentId: string;
    rationale: string;
    capabilities: string[];
  };
  /** Synthesis attempted but failed (registration collision, etc.). Non-fatal. */
  'agent:synthesis-failed': {
    taskId: string;
    suggestedId: string;
    reason: string;
  };
  /**
   * Phase C1 (capability-first research): the orchestrator gathered local
   * knowledge (world-graph facts + workspace docs) for an unmet capability
   * and injected it into the worker prompt as `[RESEARCH CONTEXT]`. The
   * task goal is NEVER rewritten (A1); findings are evidence, not verdict.
   */
  'agent:capability-research': {
    taskId: string;
    capabilities: string[];
    contextCount: number;
    sources: string[];
  };
  /** Acquisition attempted but failed. Non-fatal — task proceeds without context. */
  'agent:capability-research-failed': {
    taskId: string;
    reason: string;
  };
  /**
   * Gateway inbound (W2 H1). A messaging adapter received a message
   * and published it onto the bus via `GatewayAdapterContext.publishInbound`.
   * The Gateway dispatcher (separate track) subscribes here and turns the
   * envelope into a `TaskInput` for `executeTask` — adapters never call
   * `executeTask` directly (A3, A6, D21).
   *
   * Field is the minimal envelope shape owned by `src/gateway/types.ts`
   * (kept structural to avoid import cycles from bus.ts).
   */
  'gateway:inbound': {
    envelope: import('../gateway/types.ts').GatewayInboundEnvelopeMinimal;
  };

  // ── External Coding CLI (Claude Code, GitHub Copilot, ...) ──────────
  // Provider-neutral events emitted by the ExternalCodingCliController.
  // Adversarial robustness corollary of A6+A8+A9: every event carries
  // taskId, codingCliSessionId, and providerId so replay can reconstruct
  // process state without trusting raw CLI output.
  'coding-cli:session_created': import('../orchestrator/external-coding-cli/types.ts').CodingCliSessionCreatedEvent;
  'coding-cli:session_started': import('../orchestrator/external-coding-cli/types.ts').CodingCliSessionStartedEvent;
  'coding-cli:state_changed': import('../orchestrator/external-coding-cli/types.ts').CodingCliStateChangedEvent;
  'coding-cli:message_sent': import('../orchestrator/external-coding-cli/types.ts').CodingCliMessageSentEvent;
  'coding-cli:output_delta': import('../orchestrator/external-coding-cli/types.ts').CodingCliOutputDeltaEvent;
  'coding-cli:tool_started': import('../orchestrator/external-coding-cli/types.ts').CodingCliToolStartedEvent;
  'coding-cli:tool_completed': import('../orchestrator/external-coding-cli/types.ts').CodingCliToolCompletedEvent;
  'coding-cli:file_changed': import('../orchestrator/external-coding-cli/types.ts').CodingCliFileChangedEvent;
  'coding-cli:command_requested': import('../orchestrator/external-coding-cli/types.ts').CodingCliCommandRequestedEvent;
  'coding-cli:command_completed': import('../orchestrator/external-coding-cli/types.ts').CodingCliCommandCompletedEvent;
  'coding-cli:approval_required': import('../orchestrator/external-coding-cli/types.ts').CodingCliApprovalRequiredEvent;
  'coding-cli:approval_resolved': import('../orchestrator/external-coding-cli/types.ts').CodingCliApprovalResolvedEvent;
  'coding-cli:decision_recorded': import('../orchestrator/external-coding-cli/types.ts').CodingCliDecisionRecordedEvent;
  'coding-cli:checkpoint': import('../orchestrator/external-coding-cli/types.ts').CodingCliCheckpointEvent;
  'coding-cli:result_reported': import('../orchestrator/external-coding-cli/types.ts').CodingCliResultReportedEvent;
  'coding-cli:verification_started': import('../orchestrator/external-coding-cli/types.ts').CodingCliVerificationStartedEvent;
  'coding-cli:verification_completed': import('../orchestrator/external-coding-cli/types.ts').CodingCliVerificationCompletedEvent;
  'coding-cli:completed': import('../orchestrator/external-coding-cli/types.ts').CodingCliCompletedEvent;
  'coding-cli:failed': import('../orchestrator/external-coding-cli/types.ts').CodingCliFailedEvent;
  'coding-cli:stalled': import('../orchestrator/external-coding-cli/types.ts').CodingCliStalledEvent;
  'coding-cli:cancelled': import('../orchestrator/external-coding-cli/types.ts').CodingCliCancelledEvent;
}

// ── Bus implementation ───────────────────────────────────────────────

type Handler<T> = (payload: T) => void;

export type BusEventName = keyof VinyanBusEvents;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class EventBus<Events extends {}> {
  private readonly listeners = new Map<string, Set<Handler<never>>>();
  private readonly maxListeners: number;

  constructor(options?: { maxListeners?: number }) {
    this.maxListeners = options?.maxListeners ?? 10;
  }

  on<K extends keyof Events & string>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    if (set.size >= this.maxListeners) {
      console.warn(`[vinyan-bus] "${event}" has ${set.size} listeners (max: ${this.maxListeners}). Possible leak.`);
    }
    set.add(handler as Handler<never>);
    return () => {
      set?.delete(handler as Handler<never>);
    };
  }

  once<K extends keyof Events & string>(event: K, handler: Handler<Events[K]>): () => void {
    const unsub = this.on(event, ((payload: Events[K]) => {
      unsub();
      handler(payload);
    }) as Handler<Events[K]>);
    return unsub;
  }

  emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Defensive copy — handlers may add/remove listeners during iteration
    for (const handler of [...set]) {
      try {
        const start = performance.now();
        (handler as Handler<Events[K]>)(payload);
        const elapsed = performance.now() - start;
        if (elapsed > 100) {
          console.warn(`[vinyan-bus] Slow handler on "${String(event)}": ${elapsed.toFixed(0)}ms`);
        }
      } catch (err) {
        console.error(`[vinyan-bus] Handler error on "${String(event)}":`, err);
      }
    }
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: keyof Events & string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────

export type VinyanBus = EventBus<VinyanBusEvents>;

export function createBus(options?: { maxListeners?: number }): VinyanBus {
  return new EventBus<VinyanBusEvents>(options);
}

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
  RoutingDecision,
  SelfModelPrediction,
  ShadowJob,
  ShadowValidationResult,
  TaskInput,
  TaskResult,
  ToolResult,
  WorkerOutput,
  WorkerProfile,
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
  'trace:record': { trace: ExecutionTrace };

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

  // Sleep Cycle (Phase 2.4)
  'sleep:cycleComplete': {
    cycleId: string;
    patternsFound: number;
    rulesGenerated: number;
    skillsCreated: number;
    rulesPromoted: number;
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

  // Task lifecycle extensions
  'task:escalate': { taskId: string; fromLevel: number; toLevel: number; reason: string };
  'task:timeout': { taskId: string; elapsedMs: number; budgetMs: number };
  'task:budget-exceeded': { taskId: string; totalTokensConsumed: number; globalCap: number };

  // TestGenerator observability
  'testgen:error': { taskId: string; error: string };

  // Human approval gate (A6: zero-trust for high-risk production tasks)
  'task:approval_required': { taskId: string; riskScore: number; reason: string };

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

  // K1.5: Security violation — input rejected at task entry (block, not strip)
  'security:injection_detected': { taskId: string; detections: string[]; timestamp: number };

  // Self-model calibration
  'selfmodel:calibration_error': { taskId: string; error: string };

  // Oracle contradiction detection (A1: epistemic separation surfaces disagreements)
  'oracle:contradiction': { taskId: string; passed: string[]; failed: string[] };

  // K1.1: Contradiction escalation — auto-escalate routing level on unresolved oracle conflict
  'verification:contradiction_escalated': { taskId: string; fromLevel: number; toLevel: number; passed: string[]; failed: string[] };
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

  // Worker lifecycle (Phase 4.2)
  'worker:registered': { profile: WorkerProfile };
  'worker:promoted': { workerId: string; afterTasks: number; successRate: number };
  'worker:demoted': { workerId: string; reason: string; permanent: boolean };
  'worker:reactivated': { workerId: string; previousDemotionCount: number };

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

  // Phase 6.5: Agent session observability
  'agent:session_start': { taskId: string; routingLevel: number; budget: { maxTokens: number; maxTurns: number; contextWindow: number } };
  'agent:session_end': { taskId: string; outcome: string; tokensConsumed: number; turnsUsed: number; durationMs: number };
  'agent:turn_complete': { taskId: string; turnId: string; tokensConsumed: number; turnsRemaining: number };
  'agent:tool_executed': { taskId: string; turnId: string; toolName: string; durationMs: number; isError: boolean };
  // EO #5: Dual-track transcript compaction
  'agent:transcript_compaction': { taskId: string; evidenceTurns: number; narrativeTurns: number; tokensSaved: number };
  // EO #1+#4: DAG execution observability
  'dag:executed': { taskId: string; nodes: number; parallel: boolean; fileConflicts: number };

  // Intent Resolution (pre-pipeline LLM classification)
  'intent:resolved': { taskId: string; strategy: string; confidence: number; reasoning: string };

  // STU: Semantic Task Understanding events
  'understanding:layer0_complete': { taskId: string; durationMs: number; verb: string; category: string };
  'understanding:layer1_complete': { taskId: string; durationMs: number; entitiesResolved: number; isRecurring: boolean };
  'understanding:layer2_complete': { taskId: string; durationMs: number; hasIntent: boolean; depth: number };
  'understanding:claims_verified': { taskId: string; durationMs: number; totalClaims: number; knownClaims: number; contradictoryClaims: number };
  'understanding:calibration': { taskId: string; entityAccuracy: number; categoryMatch: boolean };

  // Extensible Thinking events
  'thinking:policy-compiled': { taskId: string; policy: import('../orchestrator/thinking/thinking-policy.ts').ThinkingPolicy; routingLevel: number };
  // Phase 2.2+: Emitted by counterfactual retry handler when re-attempting with deeper thinking
  'thinking:counterfactual-retry': { taskId: string; routingLevel: number; retryCount: number; failureReason: string };
  // Phase 2.2+: Emitted when escalation chooses lateral (model swap), vertical (budget increase), or refuse
  'thinking:escalation-path-chosen': { taskId: string; path: 'lateral' | 'vertical' | 'refuse'; fromLevel?: number; toLevel?: number };

  // Economy Operating System events (Layer 1)
  'economy:cost_recorded': { taskId: string; engineId: string; computed_usd: number; cost_tier: 'billing' | 'estimated' };
  'economy:budget_warning': { window: 'hour' | 'day' | 'month'; utilization_pct: number; spent_usd: number; limit_usd: number };
  'economy:budget_exceeded': { window: 'hour' | 'day' | 'month'; spent_usd: number; limit_usd: number; enforcement: string };
  'economy:budget_degraded': { taskId: string; fromLevel: number; toLevel: number; reason: string };
  'economy:rate_card_miss': { engineId: string; fallback: string };

  // Economy Layer 2 events
  'economy:cost_predicted': { taskId: string; predicted_usd: number; confidence: number; basis: string };
  'economy:budget_allocated': { taskId: string; maxTokens: number; source: string };
  'economy:cost_pattern_found': { patternId: string; type: string; description: string };

  // Economy Layer 3: Market events
  'market:auction_started': { auctionId: string; taskId: string; eligibleBidders: number };
  'market:auction_completed': { auctionId: string; winnerId: string; score: number; bidderCount: number };
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

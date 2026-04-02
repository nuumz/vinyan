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

  // World Graph
  'graph:fact': { fact: Fact };

  // Circuit breaker
  'circuit:open': { oracleName: string; failureCount: number };
  'circuit:close': { oracleName: string };

  // Tool execution (Phase 2 — G1)
  'tools:executed': { taskId: string; results: ToolResult[] };

  // Task lifecycle extensions
  'task:escalate': { taskId: string; fromLevel: number; toLevel: number; reason: string };
  'task:timeout': { taskId: string; elapsedMs: number; budgetMs: number };

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

  // Self-model calibration
  'selfmodel:calibration_error': { taskId: string; error: string };

  // Oracle contradiction detection (A1: epistemic separation surfaces disagreements)
  'oracle:contradiction': { taskId: string; passed: string[]; failed: string[] };

  // ECP §7.3: Engine requests more compute budget (A2: uncertainty is first-class)
  'oracle:deliberation_request': { taskId: string; oracleName: string; reason: string; suggestedBudget: number };

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
    for (const handler of set) {
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

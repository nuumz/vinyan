/**
 * Event Bus — deterministic message routing between Orchestrator components.
 *
 * Zero-dependency, synchronous, fully type-safe.
 * A3 compliance: FIFO ordering, deterministic dispatch.
 *
 * Source of truth: vinyan-implementation-plan.md §1C.4
 */
import type { OracleVerdict, Fact } from "./types.ts";
import type {
  TaskInput,
  TaskResult,
  RoutingDecision,
  ExecutionTrace,
  SelfModelPrediction,
  WorkerOutput,
  ShadowJob,
  ShadowValidationResult,
  CachedSkill,
  EvolutionaryRule,
  ToolResult,
  WorkerProfile,
} from "../orchestrator/types.ts";

// ── Event Map ────────────────────────────────────────────────────────

export interface VinyanBusEvents {
  // Spec-required (§1C.4)
  "task:start": { input: TaskInput; routing: RoutingDecision };
  "task:complete": { result: TaskResult };
  "worker:dispatch": { taskId: string; routing: RoutingDecision };
  "oracle:verdict": { taskId: string; oracleName: string; verdict: OracleVerdict };
  "trace:record": { trace: ExecutionTrace };

  // Worker lifecycle
  "worker:complete": { taskId: string; output: WorkerOutput; duration_ms: number };
  "worker:error": { taskId: string; error: string; routing: RoutingDecision };

  // Shadow validation (Phase 2.2)
  "shadow:enqueue": { job: ShadowJob };
  "shadow:complete": { job: ShadowJob; result: ShadowValidationResult };
  "shadow:failed": { job: ShadowJob; error: string };

  // Skill Formation (Phase 2.5)
  "skill:match": { taskId: string; skill: CachedSkill };
  "skill:miss": { taskId: string; taskSignature: string };
  "skill:outcome": { taskId: string; skill: CachedSkill; success: boolean };

  // Evolution Engine (Phase 2.6)
  "evolution:rulesApplied": { taskId: string; rules: EvolutionaryRule[] };
  "evolution:rulePromoted": { ruleId: string; taskSig: string };
  "evolution:ruleRetired": { ruleId: string; reason: string };

  // Sleep Cycle (Phase 2.4)
  "sleep:cycleComplete": { cycleId: string; patternsFound: number; rulesGenerated: number; skillsCreated: number; rulesPromoted: number };

  // Self-Model (Phase 1C.1)
  "selfmodel:predict": { prediction: SelfModelPrediction };

  // World Graph
  "graph:fact": { fact: Fact };

  // Circuit breaker
  "circuit:open": { oracleName: string; failureCount: number };
  "circuit:close": { oracleName: string };

  // Tool execution (Phase 2 — G1)
  "tools:executed": { taskId: string; results: ToolResult[] };

  // Task lifecycle extensions
  "task:escalate": { taskId: string; fromLevel: number; toLevel: number; reason: string };
  "task:timeout": { taskId: string; elapsed_ms: number; budget_ms: number };

  // PH3.6: Epsilon-greedy exploration
  "task:explore": { taskId: string; fromLevel: number; toLevel: number };

  // Guardrail detections
  "guardrail:injection_detected": { field: string; patterns: string[] };
  "guardrail:bypass_detected": { field: string; patterns: string[] };

  // Self-model calibration
  "selfmodel:calibration_error": { taskId: string; error: string };

  // Oracle contradiction detection (A1: epistemic separation surfaces disagreements)
  "oracle:contradiction": { taskId: string; passed: string[]; failed: string[] };

  // DAG decomposition fallback (A3: deterministic governance transparency)
  "decomposer:fallback": { taskId: string };

  // Worker lifecycle (Phase 4.2)
  "worker:registered": { profile: WorkerProfile };
  "worker:promoted": { workerId: string; afterTasks: number; successRate: number };
  "worker:demoted": { workerId: string; reason: string; permanent: boolean };
  "worker:reactivated": { workerId: string; previousDemotionCount: number };

  // Worker selection (Phase 4.4)
  "worker:selected": { taskId: string; workerId: string; reason: string; score: number; alternatives: number };
  "worker:exploration": { taskId: string; selectedWorkerId: string; defaultWorkerId: string };

  // Fleet governance (Phase 4.5)
  "fleet:convergence_warning": { giniScore: number; dominantWorkerId: string; allocation: number };
  "fleet:emergency_reactivation": { workerId: string; reason: string };
  "fleet:diversity_enforced": { workerId: string; boostAmount: number };

  // Fleet-level uncertainty — GAP-H UC-7 (Phase 4.4)
  "task:uncertain": { taskId: string; reason: string; maxCapability: number };

  // Artifact commit (Phase 1 — A6: orchestrator disposes)
  "commit:rejected": { taskId: string; rejected: Array<{ path: string; reason: string }> };
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

  on<K extends keyof Events & string>(
    event: K,
    handler: Handler<Events[K]>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    if (set.size >= this.maxListeners) {
      console.warn(
        `[vinyan-bus] "${event}" has ${set.size} listeners (max: ${this.maxListeners}). Possible leak.`,
      );
    }
    set.add(handler as Handler<never>);
    return () => {
      set!.delete(handler as Handler<never>);
    };
  }

  once<K extends keyof Events & string>(
    event: K,
    handler: Handler<Events[K]>,
  ): () => void {
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

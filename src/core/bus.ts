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
  "shadow:fail": { job: ShadowJob; error: string };

  // Skill Formation (Phase 2.5)
  "skill:match": { taskId: string; skill: CachedSkill };
  "skill:miss": { taskId: string; taskSignature: string };
  "skill:outcome": { taskId: string; skill: CachedSkill; success: boolean };

  // Evolution Engine (Phase 2.6)
  "evolution:rules_applied": { taskId: string; rules: EvolutionaryRule[] };
  "evolution:rule_promoted": { ruleId: string; taskSig: string };
  "evolution:rule_retired": { ruleId: string; reason: string };

  // Sleep Cycle (Phase 2.4)
  "sleep:cycle_complete": { cycleId: string; patternsFound: number; rulesGenerated: number; skillsCreated: number; rulesPromoted: number };

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
        (handler as Handler<Events[K]>)(payload);
      } catch (err) {
        console.error(`[vinyan-bus] Handler error on "${event}":`, err);
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

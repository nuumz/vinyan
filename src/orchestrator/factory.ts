/**
 * Orchestrator Factory — wires all dependencies and returns the executeTask function.
 *
 * This is the single entry point for creating a fully-wired orchestrator.
 * Source of truth: vinyan-tdd.md §16 (Core Loop)
 */
import { verify as depVerify } from "../oracle/dep/dep-analyzer.ts";
import { executeTask, type OrchestratorDeps } from "./core-loop.ts";
import type { TaskInput, TaskResult } from "./types.ts";
import { createBus, type VinyanBus } from "../core/bus.ts";
import { PerceptionAssemblerImpl } from "./perception.ts";
import { RiskRouterImpl } from "./risk-router-adapter.ts";
import { SelfModelStub } from "./self-model-stub.ts";
import { CalibratedSelfModel } from "./self-model.ts";
import { TaskDecomposerStub } from "./task-decomposer-stub.ts";
import { TaskDecomposerImpl } from "./task-decomposer.ts";
import { WorkerPoolImpl } from "./worker/worker-pool.ts";
import { LLMProviderRegistry } from "./llm/provider-registry.ts";
import { registerOpenRouterProviders } from "./llm/openrouter-provider.ts";
import { createAnthropicProvider } from "./llm/anthropic-provider.ts";
import { OracleGateAdapter } from "./oracle-gate-adapter.ts";
import { TraceCollectorImpl } from "./trace-collector.ts";
import { VinyanDB } from "../db/vinyan-db.ts";
import { TraceStore } from "../db/trace-store.ts";
import { WorldGraph } from "../world-graph/world-graph.ts";
import { attachTraceListener } from "../bus/trace-listener.ts";
import { attachAuditListener } from "../bus/audit-listener.ts";
import { join } from "path";
import { PatternStore } from "../db/pattern-store.ts";
import { ShadowStore } from "../db/shadow-store.ts";
import { SkillStore } from "../db/skill-store.ts";
import { RuleStore } from "../db/rule-store.ts";
import { ShadowRunner } from "./shadow-runner.ts";
import { SkillManager } from "./skill-manager.ts";
import { SleepCycleRunner } from "../sleep-cycle/sleep-cycle.ts";

export interface OrchestratorConfig {
  workspace: string;
  /** Override the LLM provider registry (useful for testing with mock providers). */
  registry?: LLMProviderRegistry;
  /** Use subprocess for worker dispatch (default: false). */
  useSubprocess?: boolean;
  /** Provide an existing bus instance (one is created if omitted). */
  bus?: VinyanBus;
}

export interface Orchestrator {
  executeTask(input: TaskInput): Promise<TaskResult>;
  traceCollector: TraceCollectorImpl;
  traceListener: { getMetrics: () => import("../bus/trace-listener.ts").TraceTelemetry; detach: () => void };
  bus: VinyanBus;
  shadowRunner?: ShadowRunner;
  skillManager?: SkillManager;
  sleepCycleRunner?: SleepCycleRunner;
  close(): void;
}

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const { workspace } = config;
  const bus = config.bus ?? createBus();

  // Set up LLM provider registry
  const registry = config.registry ?? createDefaultRegistry();

  // Set up persistent database
  let db: VinyanDB | undefined;
  let traceStore: TraceStore | undefined;
  try {
    db = new VinyanDB(join(workspace, ".vinyan", "vinyan.db"));
    traceStore = new TraceStore(db.getDb());
  } catch {
    // SQLite unavailable — fall back to in-memory only
  }

  // Phase 2 stores — all use same db instance
  let patternStore: PatternStore | undefined;
  let shadowStore: ShadowStore | undefined;
  let skillStore: SkillStore | undefined;
  let ruleStore: RuleStore | undefined;
  if (db) {
    patternStore = new PatternStore(db.getDb());
    shadowStore = new ShadowStore(db.getDb());
    skillStore = new SkillStore(db.getDb());
    ruleStore = new RuleStore(db.getDb());
  }

  // Set up WorldGraph for fact invalidation (A4: content-addressed truth)
  let worldGraph: WorldGraph | undefined;
  try {
    worldGraph = new WorldGraph(join(workspace, ".vinyan", "world-graph.db"));
  } catch {
    // WorldGraph unavailable — fact invalidation disabled
  }

  // Phase 2 managers
  const skillManager = skillStore
    ? new SkillManager({ skillStore, workspace })
    : undefined;
  const shadowRunner = shadowStore
    ? new ShadowRunner({ shadowStore, workspace })
    : undefined;
  const sleepCycleRunner = (patternStore && traceStore)
    ? new SleepCycleRunner({ traceStore, patternStore, skillManager, ruleStore, bus })
    : undefined;

  // Shadow: startup recovery (A6 crash-safety)
  if (shadowRunner) {
    const recovered = shadowRunner.recover();
    if (recovered > 0) console.warn(`[vinyan] Recovered ${recovered} stale shadow jobs`);
  }

  // Wire all dependencies
  const perception = new PerceptionAssemblerImpl({ workspace });
  const riskRouter = new RiskRouterImpl(depVerify);
  const selfModel = db
    ? new CalibratedSelfModel({ traceStore, db: db.getDb() })
    : (() => {
        console.warn("[vinyan] SQLite unavailable — using static self-model (no calibration)");
        return new SelfModelStub();
      })();
  const decomposer = registry.listProviders().length > 0
    ? new TaskDecomposerImpl({ registry })
    : (() => {
        console.warn("[vinyan] No LLM providers — using single-node task decomposition");
        return new TaskDecomposerStub();
      })();
  const workerPool = new WorkerPoolImpl({
    registry,
    workspace,
    useSubprocess: config.useSubprocess,
  });
  const oracleGate = new OracleGateAdapter(workspace);
  const traceCollector = new TraceCollectorImpl(worldGraph, traceStore);

  const deps: OrchestratorDeps = {
    perception,
    riskRouter,
    selfModel,
    decomposer,
    workerPool,
    oracleGate,
    traceCollector,
    bus,
    skillManager,
    shadowRunner,
    ruleStore,
  };

  // Wire bus listeners (read-only observers — A3 compliance)
  const traceListenerHandle = attachTraceListener(bus);
  const detachAudit = attachAuditListener(bus, join(workspace, ".vinyan", "audit.jsonl"));

  return {
    executeTask: (input: TaskInput) => executeTask(input, deps),
    traceCollector,
    traceListener: traceListenerHandle,
    bus,
    shadowRunner,
    skillManager,
    sleepCycleRunner,
    close: () => {
      traceListenerHandle.detach();
      detachAudit();
      worldGraph?.close();
      db?.close();
    },
  };
}

function createDefaultRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();

  // Try OpenRouter first (no SDK dependency, just fetch)
  try {
    registerOpenRouterProviders(registry);
  } catch {
    // OpenRouter not available (missing API key)
  }

  // Try Anthropic SDK as fallback
  if (registry.listProviders().length === 0) {
    try {
      const provider = createAnthropicProvider();
      if (provider) registry.register(provider);
    } catch {
      // Anthropic SDK not available
    }
  }

  return registry;
}

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
import { loadConfig } from "../config/loader.ts";
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
import { ToolExecutor } from "./tools/tool-executor.ts";
import { MetricsCollector } from "../observability/metrics.ts";
import { WorkerStore } from "../db/worker-store.ts";
import type { WorkerProfile } from "./types.ts";

export interface OrchestratorConfig {
  workspace: string;
  /** Override the LLM provider registry (useful for testing with mock providers). */
  registry?: LLMProviderRegistry;
  /** Use subprocess for worker dispatch (default: true for A1/A6 isolation). */
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
  getSessionCount(): number;
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
  let workerStore: WorkerStore | undefined;
  if (db) {
    patternStore = new PatternStore(db.getDb());
    shadowStore = new ShadowStore(db.getDb());
    skillStore = new SkillStore(db.getDb());
    ruleStore = new RuleStore(db.getDb());
    workerStore = new WorkerStore(db.getDb());
  }

  // Phase 4: Auto-register existing LLM providers as WorkerProfiles (PH4.0 data seeding)
  if (workerStore) {
    autoRegisterWorkers(registry, workerStore, bus);
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
  // Load config to unify routing thresholds between config and gate (Gap #14)
  let routingThresholds: { l0_max_risk: number; l1_max_risk: number; l2_max_risk: number } | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    if (vinyanConfig.phase1) {
      const r = vinyanConfig.phase1.routing;
      routingThresholds = { l0_max_risk: r.l0_max_risk, l1_max_risk: r.l1_max_risk, l2_max_risk: r.l2_max_risk };
    }
  } catch { /* config loading is best-effort */ }

  const perception = new PerceptionAssemblerImpl({ workspace });
  const riskRouter = new RiskRouterImpl(depVerify, workspace, routingThresholds);
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
    useSubprocess: config.useSubprocess ?? true, // A1/A6: subprocess isolation by default
  });
  const oracleGate = new OracleGateAdapter(workspace);
  const traceCollector = new TraceCollectorImpl(worldGraph, traceStore);
  const toolExecutor = new ToolExecutor();

  // Startup logging — confirm active components (P3.0 Gap 7)
  const components = [
    `self-model: ${selfModel.constructor.name}`,
    `decomposer: ${decomposer.constructor.name}`,
    `skills: ${skillManager ? "enabled" : "disabled"}`,
    `shadow: ${shadowRunner ? "enabled" : "disabled"}`,
    `sleep-cycle: ${sleepCycleRunner ? "enabled" : "disabled"}`,
    `rules: ${ruleStore ? "enabled" : "disabled"}`,
  ];
  console.log(`[vinyan] Orchestrator initialized — ${components.join(", ")}`);

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
    toolExecutor,
  };

  // Wire bus listeners (read-only observers — A3 compliance)
  const metricsCollector = new MetricsCollector();
  const detachMetrics = metricsCollector.attach(bus);
  const traceListenerHandle = attachTraceListener(bus);
  const detachAudit = attachAuditListener(bus, join(workspace, ".vinyan", "audit.jsonl"));

  // Shadow validation listener — update trace store when shadow processing completes (H3)
  if (shadowRunner && traceStore) {
    bus.on("shadow:complete", ({ result }) => {
      traceStore.updateShadowValidation(result.taskId, result);
    });
  }

  // Session counter — triggers sleep cycle at interval (H1)
  let sessionCount = 0;

  // Shadow background loop — safety net for missed fire-and-forget calls (P3.2)
  let shadowInterval: ReturnType<typeof setInterval> | undefined;
  if (shadowRunner) {
    shadowInterval = setInterval(async () => {
      try {
        const result = await shadowRunner.processNext();
        if (result) {
          bus.emit("shadow:complete", {
            job: { id: "", taskId: result.taskId, status: "done" as const, enqueuedAt: 0, retryCount: 0, maxRetries: 1 },
            result,
          });
        }
      } catch { /* best-effort background processing */ }
    }, 10_000);
  }

  return {
    executeTask: async (input: TaskInput) => {
      const result = await executeTask(input, deps);
      sessionCount++;

      // Trigger sleep cycle at interval (best-effort, never blocks main flow)
      if (sleepCycleRunner && sessionCount >= sleepCycleRunner.getInterval()) {
        sleepCycleRunner.run().catch(() => { /* best-effort */ });
        sessionCount = 0;
      }

      return result;
    },
    traceCollector,
    traceListener: traceListenerHandle,
    bus,
    shadowRunner,
    skillManager,
    sleepCycleRunner,
    getSessionCount: () => sessionCount,
    close: () => {
      if (shadowInterval) clearInterval(shadowInterval);
      detachMetrics();
      traceListenerHandle.detach();
      detachAudit();
      worldGraph?.close();
      db?.close();
    },
  };
}

/**
 * Auto-register existing LLM providers as WorkerProfiles.
 * Grandfathered as "active" — these are proven models from Phase 3.
 */
function autoRegisterWorkers(
  registry: LLMProviderRegistry,
  workerStore: WorkerStore,
  bus: VinyanBus,
): void {
  for (const provider of registry.listProviders()) {
    const workerId = `worker-${provider.id}`;
    const existing = workerStore.findById(workerId);
    if (existing) continue;

    const profile: WorkerProfile = {
      id: workerId,
      config: {
        modelId: provider.id,
        temperature: 0.7,
        systemPromptTemplate: "default",
        maxContextTokens: provider.maxContextTokens,
      },
      status: "active", // grandfathered — proven from Phase 3
      createdAt: Date.now(),
      demotionCount: 0,
    };
    workerStore.insert(profile);
    bus.emit("worker:registered", { profile });
  }
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

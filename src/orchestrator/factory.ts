/**
 * Orchestrator Factory — wires all dependencies and returns the executeTask function.
 *
 * This is the single entry point for creating a fully-wired orchestrator.
 * Source of truth: spec/tdd.md §16 (Core Loop)
 */

import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { attachAuditListener } from '../bus/audit-listener.ts';
import { attachOracleAccuracyListener } from '../bus/oracle-accuracy-listener.ts';
import { attachTraceListener } from '../bus/trace-listener.ts';
import { loadConfig } from '../config/loader.ts';
import { createBus, type VinyanBus } from '../core/bus.ts';
import { OracleAccuracyStore } from '../db/oracle-accuracy-store.ts';
import { OracleProfileStore } from '../db/oracle-profile-store.ts';
import { PatternStore } from '../db/pattern-store.ts';
import { PredictionLedger } from '../db/prediction-ledger.ts';
import { migratePredictionLedgerSchema } from '../db/prediction-ledger-schema.ts';
import { ProviderTrustStore } from '../db/provider-trust-store.ts';
import { RejectedApproachStore } from '../db/rejected-approach-store.ts';
import { RuleStore } from '../db/rule-store.ts';
import { ShadowStore } from '../db/shadow-store.ts';
import { SkillStore } from '../db/skill-store.ts';
import { TaskCheckpointStore } from '../db/task-checkpoint-store.ts';
import { TraceStore } from '../db/trace-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { WorkerStore } from '../db/worker-store.ts';
import { BudgetEnforcer } from '../economy/budget-enforcer.ts';
import { CostLedger } from '../economy/cost-ledger.ts';
import { CostPredictor } from '../economy/cost-predictor.ts';
import { DynamicBudgetAllocator } from '../economy/dynamic-budget-allocator.ts';
import type { EconomyConfig } from '../economy/economy-config.ts';
import { FederationBudgetPool } from '../economy/federation-budget-pool.ts';
import { FederationCostRelay } from '../economy/federation-cost-relay.ts';
import { MarketScheduler } from '../economy/market/market-scheduler.ts';
import { setOracleAccuracyStore } from '../gate/gate.ts';
import { MCPClientPool, type MCPServerConfig } from '../mcp/client.ts';
import type { McpSourceZone } from '../mcp/ecp-translation.ts';
import { GapHDetector } from '../observability/gap-h-detector.ts';
import { MetricsCollector } from '../observability/metrics.ts';
import { verify as depVerify } from '../oracle/dep/dep-analyzer.ts';
import { SleepCycleRunner } from '../sleep-cycle/sleep-cycle.ts';
import { FileWatcher } from '../world-graph/file-watcher.ts';
import { WorldGraph } from '../world-graph/world-graph.ts';
import { ApprovalGate as ApprovalGateImpl } from './approval-gate.ts';
import { DefaultConcurrentDispatcher } from './concurrent-dispatcher.ts';
import { executeTask, type OrchestratorDeps } from './core-loop.ts';
import { ArchitectureDebateCritic, DebateRouterCritic } from './critic/debate-mode.ts';
import { LLMCriticImpl } from './critic/llm-critic-impl.ts';
import type { DataGateThresholds } from './data-gate.ts';
import { DelegationRouter } from './delegation-router.ts';
import { DefaultEngineSelector } from './engine-selector.ts';
import { HumanECPBridge } from './engines/human-ecp-bridge.ts';
import { Z3ReasoningEngine } from './engines/z3-reasoning-engine.ts';
import { CapabilityModel } from './fleet/capability-model.ts';
import { WorkerLifecycle } from './fleet/worker-lifecycle.ts';
import { WorkerSelector } from './fleet/worker-selector.ts';
import { InstanceCoordinator } from './instance-coordinator.ts';
import { createAnthropicProvider } from './llm/anthropic-provider.ts';
import { startLLMProxy } from './llm/llm-proxy.ts';
import { ReasoningEngineRegistry } from './llm/llm-reasoning-engine.ts';
import { registerOpenRouterProviders } from './llm/openrouter-provider.ts';
import { compressPerception } from './llm/perception-compressor.ts';
import { LLMProviderRegistry } from './llm/provider-registry.ts';
import { buildMcpToolMap } from './mcp/mcp-tool-adapter.ts';
import { OracleGateAdapter } from './oracle-gate-adapter.ts';
import { PerceptionAssemblerImpl } from './perception.ts';
import { OracleEMACalibrator } from './phase7/oracle-ema-calibrator.ts';
import { RegressionMonitor } from './phase7/regression-monitor.ts';
import { FileStatsCache } from './prediction/file-stats-cache.ts';
import { ForwardPredictorImpl } from './prediction/forward-predictor.ts';
import { PercentileCache } from './prediction/percentile-cache.ts';
import { CalibratedSelfModel, SelfModelStub } from './prediction/self-model.ts';
import { RemediationEngine } from './remediation-engine.ts';
import { RiskRouterImpl } from './risk-router-adapter.ts';
import { ShadowRunner } from './shadow-runner.ts';
import { SkillManager } from './skill-manager.ts';
import { TaskDecomposerImpl, TaskDecomposerStub } from './task-decomposer.ts';
import { createTaskQueue } from './task-queue.ts';
import { LLMTestGeneratorImpl } from './test-gen/llm-test-generator.ts';
import { DefaultThinkingPolicyCompiler } from './thinking/thinking-compiler.ts';
import { ToolExecutor } from './tools/tool-executor.ts';
import type { Tool } from './tools/tool-interface.ts';
import { TraceCollectorImpl } from './trace-collector.ts';
import type { TaskInput, TaskResult, WorkerProfile } from './types.ts';
import { UnderstandingEngine } from './understanding/understanding-engine.ts';
import type { AgentLoopDeps } from './worker/agent-loop.ts';
import { WorkerPoolImpl } from './worker/worker-pool.ts';

export interface OrchestratorConfig {
  workspace: string;
  /** Override the LLM provider registry (useful for testing with mock providers). */
  registry?: LLMProviderRegistry;
  /**
   * Override with a RE-agnostic engine registry — preferred over `registry` when provided.
   * Any ReasoningEngine (LLM, symbolic, AGI) can be registered here.
   * If omitted, the LLM registry is wrapped via ReasoningEngineRegistry.fromLLMRegistry().
   */
  engineRegistry?: ReasoningEngineRegistry;
  /** Use subprocess for worker dispatch (default: true for A1/A6 isolation). */
  useSubprocess?: boolean;
  /** Provide an existing bus instance (one is created if omitted). */
  bus?: VinyanBus;
  /** Override oracle gate (for testing escalation and fail-closed scenarios). */
  oracleGate?: import('./core-loop.ts').OracleGate;
  /** Override critic engine (for testing fail-closed behavior). */
  criticEngine?: import('./critic/critic-engine.ts').CriticEngine;
  /**
   * Book-integration Wave 1.1: worker-level silence watchdog config.
   * Omit (default) → conservative 15 s warn / 45 s stall thresholds.
   * Pass a custom SilentAgentConfig to tune for long-running tasks.
   */
  silentAgentConfig?: import('../guardrails/silent-agent.ts').SilentAgentConfig;
  /** Enable LLM proxy for credential isolation (A6). Default: false. */
  llmProxy?: boolean;
  /** Session manager for conversation agent mode (optional — wired into deps if provided). */
  sessionManager?: import('../api/session-manager.ts').SessionManager;
  /**
   * Allowlist of engine ID prefixes for auto-registration into worker_profiles.
   * Defaults to the legacy LLM vendor list. Pass [] to disable allowlist filtering
   * (useful when using a custom engineRegistry with non-LLM REs).
   */
  workerModelAllowlist?: string[];
  /** Command approval gate — enables interactive approval for unlisted shell commands. */
  commandApprovalGate?: import('./tools/command-approval-gate.ts').CommandApprovalGate;
}

export interface Orchestrator {
  executeTask(input: TaskInput): Promise<TaskResult>;
  /** K2.3: Execute multiple tasks concurrently with file-lock conflict prevention. */
  executeTaskBatch(tasks: TaskInput[]): Promise<TaskResult[]>;
  traceCollector: TraceCollectorImpl;
  traceListener: { getMetrics: () => import('../bus/trace-listener.ts').TraceTelemetry; detach: () => void };
  bus: VinyanBus;
  /**
   * Optional session manager — set when `OrchestratorConfig.sessionManager`
   * is provided. Exposed on the public interface (PR #11) so the TUI's
   * embedded DataSource can query conversation history for the new Chat
   * tab without going through a side channel. API server already takes
   * sessionManager directly via `APIServerDeps`.
   */
  sessionManager?: import('../api/session-manager.ts').SessionManager;
  shadowRunner?: ShadowRunner;
  skillManager?: SkillManager;
  sleepCycleRunner?: SleepCycleRunner;
  workerLifecycle?: WorkerLifecycle;
  // Exposed stores for API server (G7)
  traceStore?: TraceStore;
  ruleStore?: RuleStore;
  skillStore?: SkillStore;
  patternStore?: PatternStore;
  shadowStore?: ShadowStore;
  workerStore?: WorkerStore;
  worldGraph?: WorldGraph;
  metricsCollector?: MetricsCollector;
  approvalGate?: ApprovalGateImpl;
  getSessionCount(): number;
  close(): void;
}

export function cleanupStaleOverlays(workspace: string, maxAgeMs: number = 7_200_000): number {
  const sessionsDir = join(workspace, '.vinyan', 'sessions');
  if (!existsSync(sessionsDir)) return 0;
  let cleaned = 0;
  for (const dir of readdirSync(sessionsDir)) {
    const fullPath = join(sessionsDir, dir);
    try {
      const stat = statSync(fullPath);
      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        rmSync(fullPath, { recursive: true, force: true });
        cleaned++;
      }
    } catch {
      /* skip if inaccessible */
    }
  }
  return cleaned;
}

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const { workspace } = config;
  const bus = config.bus ?? createBus();

  // Cleanup stale overlay directories from crashed sessions
  const staleCount = cleanupStaleOverlays(workspace);
  if (staleCount > 0) console.warn(`[vinyan] Cleaned up ${staleCount} stale session overlays`);

  // Set up LLM provider registry
  const registry = config.registry ?? createDefaultRegistry();

  // Set up persistent database
  let db: VinyanDB | undefined;
  let traceStore: TraceStore | undefined;
  let oracleAccuracyStore: OracleAccuracyStore | undefined;
  try {
    db = new VinyanDB(join(workspace, '.vinyan', 'vinyan.db'));
    traceStore = new TraceStore(db.getDb());
    oracleAccuracyStore = new OracleAccuracyStore(db.getDb());
  } catch {
    // SQLite unavailable — fall back to in-memory only
  }

  // Wire accuracy store into gate module (module-level injection, like circuitBreaker)
  if (oracleAccuracyStore) {
    setOracleAccuracyStore(oracleAccuracyStore);
  }

  // Phase 2 stores — all use same db instance
  let patternStore: PatternStore | undefined;
  let shadowStore: ShadowStore | undefined;
  let skillStore: SkillStore | undefined;
  let ruleStore: RuleStore | undefined;
  let workerStore: WorkerStore | undefined;
  let rejectedApproachStore: RejectedApproachStore | undefined;
  let providerTrustStore: ProviderTrustStore | undefined;
  if (db) {
    patternStore = new PatternStore(db.getDb());
    shadowStore = new ShadowStore(db.getDb());
    skillStore = new SkillStore(db.getDb());
    ruleStore = new RuleStore(db.getDb());
    workerStore = new WorkerStore(db.getDb());
    rejectedApproachStore = new RejectedApproachStore(db.getDb());
    providerTrustStore = new ProviderTrustStore(db.getDb());
  }

  // Phase 4: Auto-register existing LLM providers as WorkerProfiles (PH4.0 data seeding)
  if (workerStore) {
    autoRegisterWorkers(registry, workerStore, bus, config.workerModelAllowlist, config.engineRegistry);
  }

  // Set up WorldGraph for fact invalidation (A4: content-addressed truth)
  let worldGraph: WorldGraph | undefined;
  let fileWatcher: FileWatcher | undefined;
  try {
    worldGraph = new WorldGraph(join(workspace, '.vinyan', 'world-graph.db'));
    // A4: Watch workspace for external file changes — auto-invalidate stale facts
    fileWatcher = new FileWatcher(worldGraph, workspace);
    fileWatcher.start();
  } catch {
    // WorldGraph unavailable — fact invalidation disabled
  }

  // Load config to unify routing thresholds and Phase 4 governance parameters
  let routingThresholds: { l0_max_risk: number; l1_max_risk: number; l2_max_risk: number } | undefined;
  let extensibleThinkingEnabled = true; // default: enabled
  let extensibleThinkingConfig:
    | { thresholds?: { riskBoundary: number; uncertaintyBoundary: number }; auditSampleRate?: number }
    | undefined;
  let fleetConfig:
    | {
        probation_min_tasks: number;
        demotion_window_tasks: number;
        demotion_max_reentries: number;
        reentry_cooldown_sessions: number;
        epsilon_worker: number;
        diversity_cap_pct: number;
      }
    | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    if (vinyanConfig.orchestrator) {
      const r = vinyanConfig.orchestrator.routing;
      routingThresholds = { l0_max_risk: r.l0_max_risk, l1_max_risk: r.l1_max_risk, l2_max_risk: r.l2_max_risk };
      extensibleThinkingEnabled = vinyanConfig.orchestrator.extensible_thinking?.enabled !== false;
      const et = vinyanConfig.orchestrator.extensible_thinking;
      if (et) {
        extensibleThinkingConfig = {
          thresholds: et.thresholds,
          auditSampleRate: et.audit_sample_rate,
        };
      }
    }
    if (vinyanConfig.fleet) {
      fleetConfig = vinyanConfig.fleet;
    }
  } catch {
    /* config loading is best-effort */
  }

  // Economy Operating System — cost tracking + budget enforcement
  let costLedger: CostLedger | undefined;
  let budgetEnforcer: BudgetEnforcer | undefined;
  let costPredictor: CostPredictor | undefined;
  let dynamicBudgetAllocator: DynamicBudgetAllocator | undefined;
  let economyConfig: EconomyConfig | undefined;
  let marketScheduler: MarketScheduler | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    economyConfig = vinyanConfig.economy;
    if (economyConfig?.enabled && db) {
      costLedger = new CostLedger(db.getDb());
      if (economyConfig.budgets) {
        budgetEnforcer = new BudgetEnforcer(economyConfig.budgets, costLedger, bus);
      }
      // Economy L2: cost prediction + dynamic budgets
      costPredictor = new CostPredictor(costLedger);
      dynamicBudgetAllocator = new DynamicBudgetAllocator(costLedger);
      // Economy L3: market scheduler — shared across engine-selector + sleep cycle
      if (economyConfig.market?.enabled) {
        marketScheduler = new MarketScheduler(economyConfig.market, bus);
      }
      // Economy L3→K2.1: settlement → trust ledger feedback loop
      if (providerTrustStore) {
        bus.on('market:settlement_accurate', ({ provider, capability }) => {
          providerTrustStore!.recordOutcome(provider, true, capability ?? '*');
        });
        bus.on('market:settlement_inaccurate', ({ provider, capability }) => {
          providerTrustStore!.recordOutcome(provider, false, capability ?? '*');
        });
      }
      // Economy L4: federation cost relay — broadcast costs to A2A peers
      if (economyConfig.federation?.cost_sharing_enabled) {
        const relay = new FederationCostRelay(bus);
        bus.on('economy:cost_recorded', ({ taskId, computed_usd }) => {
          relay.broadcastCost({
            instanceId: 'local',
            taskId,
            computed_usd,
            rate_card_id: 'auto',
            cost_tier: 'billing',
            timestamp: Date.now(),
          });
        });
      }
      console.log('[vinyan] Economy OS: cost tracking + prediction enabled');
    }
  } catch {
    /* economy wiring is best-effort */
  }

  // HMS: Hallucination Mitigation System config (disabled by default)
  let hmsConfig: import('../hms/hms-config.ts').HMSConfig | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    if (vinyanConfig.hms?.enabled) {
      hmsConfig = vinyanConfig.hms;
      console.log('[vinyan] HMS: hallucination mitigation enabled');
    }
  } catch {
    /* HMS wiring is best-effort */
  }

  // Non-LLM Reasoning Engines — Z3 constraint solver, human-in-the-loop bridge
  let engineRegistry = config.engineRegistry;
  try {
    const vinyanConfig = loadConfig(workspace);
    const enginesConfig = vinyanConfig.engines;
    if (enginesConfig) {
      if (!engineRegistry) {
        engineRegistry = ReasoningEngineRegistry.fromLLMRegistry(registry);
      }
      if (enginesConfig.z3?.enabled) {
        engineRegistry.register(new Z3ReasoningEngine({ z3Path: enginesConfig.z3.path }));
        console.log('[vinyan] Z3 Constraint Solver engine registered');
      }
      if (enginesConfig.human?.enabled) {
        engineRegistry.register(new HumanECPBridge({ bus, timeoutMs: enginesConfig.human.timeout_ms }));
        console.log('[vinyan] Human-in-the-Loop ECP bridge registered');
      }
      // Register non-LLM engines as workers (autoRegisterWorkers ran earlier with config.engineRegistry)
      if (workerStore) {
        autoRegisterWorkers(registry, workerStore, bus, config.workerModelAllowlist, engineRegistry);
      }
    }
  } catch {
    /* engine registration is best-effort */
  }

  // K2.5: MCP Client Pool — external tool access with oracle verification
  let mcpClientPool: MCPClientPool | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    const mcpConfig = vinyanConfig.network?.mcp;
    if (mcpConfig?.client_servers?.length) {
      const TRUST_MAP: Record<string, McpSourceZone> = {
        untrusted: 'remote',
        provisional: 'network',
        established: 'network',
        trusted: 'local',
      };
      const serverConfigs: MCPServerConfig[] = mcpConfig.client_servers.map(
        (s: { name: string; command: string; trust_level?: string }) => ({
          name: s.name,
          command: s.command,
          trustLevel: TRUST_MAP[s.trust_level ?? 'untrusted'] ?? ('remote' as McpSourceZone),
        }),
      );
      mcpClientPool = new MCPClientPool(serverConfigs, bus);
      console.log(`[vinyan] MCP Client Pool: ${serverConfigs.length} server(s) configured`);
    }
  } catch {
    /* MCP client wiring is best-effort */
  }

  // Phase 7e: shared map holding MCP-adapted tools. Populated
  // asynchronously after `mcpClientPool.initialize()` resolves — the
  // factory does NOT block on remote MCP server readiness. Tasks that
  // run before init completes simply see an empty MCP surface.
  //
  // Both `ToolExecutor` and `agentLoopDeps.extraTools` hold a live
  // reference to this same map so the mutation is observable
  // everywhere it matters.
  const mcpToolMap = new Map<string, Tool>();

  // Phase 4.2: Worker Lifecycle — deterministic state machine for worker governance
  let workerLifecycle: WorkerLifecycle | undefined;
  if (workerStore) {
    workerLifecycle = new WorkerLifecycle({
      workerStore,
      bus,
      probationMinTasks: fleetConfig?.probation_min_tasks ?? 30,
      demotionWindowTasks: fleetConfig?.demotion_window_tasks ?? 30,
      demotionMaxReentries: fleetConfig?.demotion_max_reentries ?? 3,
      reentryCooldownSessions: fleetConfig?.reentry_cooldown_sessions ?? 50,
    });
  }

  // Phase 2 managers
  const skillManager = skillStore ? new SkillManager({ skillStore, workspace }) : undefined;
  const shadowRunner = shadowStore ? new ShadowRunner({ shadowStore, workspace }) : undefined;
  const sleepCycleRunner =
    patternStore && traceStore
      ? new SleepCycleRunner({
          traceStore,
          patternStore,
          skillManager,
          ruleStore,
          bus,
          workerStore,
          workerLifecycle,
          costLedger,
          marketScheduler,
        })
      : undefined;

  // Shadow: startup recovery (A6 crash-safety)
  if (shadowRunner) {
    const recovered = shadowRunner.recover();
    if (recovered > 0) console.warn(`[vinyan] Recovered ${recovered} stale shadow jobs`);
  }

  // Crash Recovery: checkpoint store + startup recovery
  let taskCheckpoint: TaskCheckpointStore | undefined;
  if (db) {
    taskCheckpoint = new TaskCheckpointStore(db.getDb());
    const interrupted = taskCheckpoint.findDispatched();
    if (interrupted.length > 0) {
      console.warn(`[vinyan] Found ${interrupted.length} interrupted task(s) from previous session`);
      for (const task of interrupted) {
        taskCheckpoint.abandon(task.taskId);
        try {
          const input = JSON.parse(task.inputJson);
          bus.emit('task:recovered', { taskId: task.taskId, input, abandoned: true });
        } catch {
          // Malformed checkpoint — just abandon
        }
      }
    }
    // Periodic cleanup: remove completed/failed/abandoned checkpoints older than 24h
    taskCheckpoint.cleanup(24 * 60 * 60 * 1000);
  }

  const perception = new PerceptionAssemblerImpl({ workspace });
  const selfModel = db
    ? new CalibratedSelfModel({ traceStore, db: db.getDb(), bus })
    : (() => {
        console.warn('[vinyan] SQLite unavailable — using static self-model (no calibration)');
        return new SelfModelStub();
      })();
  const riskRouter = new RiskRouterImpl(
    depVerify,
    workspace,
    routingThresholds,
    'getEpistemicSignal' in selfModel ? (selfModel as CalibratedSelfModel) : undefined,
  );
  const decomposer =
    registry.listProviders().length > 0
      ? new TaskDecomposerImpl({ registry })
      : (() => {
          console.warn('[vinyan] No LLM providers — using single-node task decomposition');
          return new TaskDecomposerStub();
        })();
  // A6: Start LLM proxy for credential isolation if enabled
  let llmProxy: import('./llm/llm-proxy.ts').LLMProxyServer | undefined;
  if (config.llmProxy && (config.useSubprocess ?? true)) {
    llmProxy = startLLMProxy(registry);
  }
  const workerPool = new WorkerPoolImpl({
    registry,
    engineRegistry: engineRegistry ?? config.engineRegistry,
    workspace,
    useSubprocess: config.useSubprocess ?? true, // A1/A6: subprocess isolation by default
    proxySocketPath: llmProxy?.socketPath,
    bus,
  });
  const oracleGate = config.oracleGate ?? new OracleGateAdapter(workspace);
  const traceCollector = new TraceCollectorImpl(worldGraph, traceStore, bus);
  if (costLedger) {
    traceCollector.setEconomyDeps(costLedger, economyConfig?.rate_cards, bus);
  }
  const toolExecutor = new ToolExecutor(undefined, config.commandApprovalGate);

  // Phase 7e: kick off MCP pool initialization now that `oracleGate`
  // exists. This is fire-and-forget — `buildMcpToolMap` populates the
  // shared `mcpToolMap` which both the executor and the agent loop
  // reference by value. Failures are logged but never fatal.
  if (mcpClientPool) {
    const pool = mcpClientPool;
    pool
      .initialize()
      .then(() => buildMcpToolMap(pool, oracleGate, workspace))
      .then((built) => {
        for (const [name, tool] of built) {
          mcpToolMap.set(name, tool);
          toolExecutor.registerTool(name, tool);
        }
        if (built.size > 0) {
          console.log(
            `[vinyan] MCP tools registered: ${built.size} tool(s) across ${pool.listServers().length} server(s)`,
          );
        }
      })
      .catch((err) => {
        console.warn(`[vinyan] MCP tool discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  // WP-2: LLM-as-Critic — instantiate when a provider is available (A1: separate from generator)
  const criticProvider = registry.selectByTier('powerful') ?? registry.selectByTier('balanced');
  const baselineCritic = criticProvider ? new LLMCriticImpl(criticProvider) : undefined;

  // Book-integration Wave 2.1: Architecture Debate Mode — 3-agent critic
  // hardening. Wired as a DebateRouterCritic that delegates to the baseline
  // critic by default and fires the 3-agent debate only when the risk-based
  // trigger rule in shouldDebate() says so (A3: deterministic selection).
  //
  // Seat allocation: advocate + architect get the 'powerful' tier because
  // they need to reason over the full proposal; counter gets 'balanced'
  // because its job is to *generate* attack candidates and quality there
  // is mostly about breadth, not precision. If only one tier is available
  // the debate collapses to three calls on the same provider — still
  // A1-compliant because each call runs with its own prompt and context,
  // but the epistemic diversity is weaker and observability should flag it.
  let criticEngine = config.criticEngine ?? baselineCritic;
  if (!config.criticEngine && baselineCritic) {
    const advocateProvider = registry.selectByTier('powerful') ?? registry.selectByTier('balanced') ?? criticProvider;
    const counterProvider = registry.selectByTier('balanced') ?? registry.selectByTier('fast') ?? advocateProvider;
    const architectProvider = registry.selectByTier('powerful') ?? registry.selectByTier('balanced') ?? criticProvider;

    if (advocateProvider && counterProvider && architectProvider) {
      const debateCritic = new ArchitectureDebateCritic({
        advocate: advocateProvider,
        counter: counterProvider,
        architect: architectProvider,
      });
      criticEngine = new DebateRouterCritic(baselineCritic, debateCritic);
    }
  }

  // WP-3: TestGenerator — generative verification at L2+ (A1: separate LLM call from generator)
  const testGenProvider = registry.selectByTier('balanced') ?? registry.selectByTier('powerful');
  const testGenerator = testGenProvider ? new LLMTestGeneratorImpl(testGenProvider, workspace) : undefined;

  // STU Layer 2: Understanding engine — fast tier, budget-gated semantic intent extraction
  const understandingProvider = registry.selectByTier('fast') ?? registry.selectByTier('balanced');
  const understandingEngine = understandingProvider ? new UnderstandingEngine(understandingProvider) : undefined;

  // Remediation engine — tool-uses tier for structured output / problem-solving
  const remediationProvider =
    registry.selectByTier('tool-uses') ?? registry.selectByTier('fast') ?? registry.selectByTier('balanced');
  const remediationEngine = remediationProvider ? new RemediationEngine(remediationProvider) : undefined;

  // Startup logging — confirm active components (P3.0 Gap 7)
  const components = [
    `self-model: ${selfModel.constructor.name}`,
    `decomposer: ${decomposer.constructor.name}`,
    `critic: ${criticEngine ? 'enabled' : 'disabled'}`,
    `test-gen: ${testGenerator ? 'enabled' : 'disabled'}`,
    `llm-providers: ${registry.listProviders().length}`,
    `skills: ${skillManager ? 'enabled' : 'disabled'}`,
    `shadow: ${shadowRunner ? 'enabled' : 'disabled'}`,
    `sleep-cycle: ${sleepCycleRunner ? 'enabled' : 'disabled'}`,
    `rules: ${ruleStore ? 'enabled' : 'disabled'}`,
  ];
  console.log(`[vinyan] Orchestrator initialized — ${components.join(', ')}`);

  // Phase 4: Capability-based worker selector
  let workerSelector: WorkerSelector | undefined;
  if (workerStore && db) {
    const capabilityModel = new CapabilityModel({
      db: db.getDb(),
      minTraces: 5,
      negativeCapabilityThreshold: 0.6,
    });
    const defaultGateThresholds: DataGateThresholds = {
      sleep_cycle_min_traces: 100,
      sleep_cycle_min_task_types: 5,
      skill_min_patterns: 1,
      skill_min_sleep_cycles: 1,
      evolution_min_traces: 200,
      evolution_min_active_skills: 1,
      evolution_min_sleep_cycles: 3,
      fleet_min_active_workers: 2,
      fleet_min_worker_trace_diversity: 2,
      thinking_calibration_min_traces: 50,
      thinking_uncertainty_min_traces: 200,
      thinking_uncertainty_min_task_types: 5,
    };
    workerSelector = new WorkerSelector({
      workerStore,
      capabilityModel,
      bus,
      epsilonWorker: fleetConfig?.epsilon_worker ?? 0.1,
      diversityCapPct: fleetConfig?.diversity_cap_pct ?? 0.7,
      gateStats: () => ({
        traceCount: traceStore?.count() ?? 0,
        distinctTaskTypes: traceStore?.countDistinctTaskTypes() ?? 0,
        patternsExtracted: patternStore?.count() ?? 0,
        activeSkills: skillStore?.countActive() ?? 0,
        sleepCyclesRun: patternStore?.countCycleRuns() ?? 0,
        activeWorkers: workerStore.countActive(),
        workerTraceDiversity: workerStore.countDistinctWorkerIds(),
        thinkingTraceCount: traceStore?.countWithThinking?.() ?? 0,
        thinkingDistinctTaskTypes: traceStore?.countDistinctThinkingTaskTypes?.() ?? 0,
      }),
      gateThresholds: defaultGateThresholds,
      // Economy L2: wire cost-aware scoring when economy is enabled
      costPredictor,
      budgetEnforcer,
    });
  }

  // Phase 5: Instance Coordinator (PH5.8) — cross-instance task delegation
  let instanceCoordinator: InstanceCoordinator | undefined;
  let federationBudgetPool: FederationBudgetPool | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    const instancesConfig = vinyanConfig.network?.instances;
    if (instancesConfig?.enabled && instancesConfig.peers?.length) {
      const oracleProfileStore = db ? new OracleProfileStore(db.getDb()) : undefined;
      // Economy L4: create federation budget pool when federation economy is enabled
      if (economyConfig?.federation?.cost_sharing_enabled) {
        const fraction = economyConfig.federation.shared_pool_fraction ?? 0.1;
        federationBudgetPool = new FederationBudgetPool(fraction, bus);
        // Contribute to pool from local task completions
        bus.on('economy:cost_recorded', ({ computed_usd }) => {
          federationBudgetPool!.contribute(computed_usd);
        });
      }
      instanceCoordinator = new InstanceCoordinator({
        peerUrls: instancesConfig.peers.map((p: { url: string }) => p.url),
        instanceId: crypto.randomUUID(),
        profileStore: oracleProfileStore,
        bus,
        federationBudgetPool,
      });
    }
  } catch {
    /* instance coordinator wiring is best-effort */
  }

  // Approval Gate (A6: human-in-the-loop for high-risk tasks)
  const approvalGate = new ApprovalGateImpl(bus);

  // Forward Predictor (A7: prediction error as learning signal)
  let forwardPredictor: import('./forward-predictor-types.ts').ForwardPredictor | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    const fpConfig = vinyanConfig.orchestrator?.forward_predictor;
    if (fpConfig?.enabled && db) {
      migratePredictionLedgerSchema(db.getDb());
      const predictionLedger = new PredictionLedger(db.getDb());
      forwardPredictor = new ForwardPredictorImpl({
        selfModel,
        ledger: predictionLedger,
        worldGraph,
        config: fpConfig,
        fileStatsCache: new FileStatsCache(),
        percentileCache: new PercentileCache(),
      });
    }
  } catch {
    /* forward predictor wiring is best-effort */
  }

  // Phase 7 — Self-Improving Autonomy modules. Pure in-memory observers
  // that watch each trace and emit `phase7:*` events. They never block
  // the pipeline — Phase Learn calls them in best-effort try/catch.
  // Drift detection is stateless and does not need a dep — it's invoked
  // inline in Phase Learn.
  const oracleEMACalibrator = new OracleEMACalibrator({ bus });
  const regressionMonitor = new RegressionMonitor({ bus });

  const deps: OrchestratorDeps = {
    perception,
    riskRouter,
    selfModel,
    decomposer,
    workerPool,
    oracleGate,
    traceCollector,
    bus,
    workspace,
    skillManager,
    shadowRunner,
    ruleStore,
    toolExecutor,
    workerSelector,
    workerStore,
    workerLifecycle,
    worldGraph,
    criticEngine,
    testGenerator,
    // Disable exploration in test mode for deterministic routing (A3)
    explorationEpsilon: config.useSubprocess === false ? 0 : undefined,
    // Phase 5 — Instance Coordinator (PH5.8)
    instanceCoordinator: instanceCoordinator,
    // Human approval gate (A6)
    approvalGate,
    // Forward Predictor (A7: prediction error as learning signal)
    forwardPredictor,
    // Cross-task learning: eviction archiving + prior-approach loading
    rejectedApproachStore,
    // STU: historical profiler for enrichUnderstanding()
    traceStore,
    // STU Layer 2: semantic intent extraction
    understandingEngine,
    // K2.1: Provider trust for Wilson LB selection
    providerTrustStore,
    // Economy Operating System
    costLedger,
    budgetEnforcer,
    economyRateCards: economyConfig?.rate_cards,
    costPredictor,
    dynamicBudgetAllocator,
    // HMS: Hallucination Mitigation System
    hmsConfig,
    // K2.5: MCP client pool for external tool access
    mcpClientPool,
    // Crash Recovery: task checkpoint store
    taskCheckpoint,
    // Conversation Agent Mode: session manager for cross-turn context
    sessionManager: config.sessionManager,
    // Intent Resolver: LLM registry for pre-routing semantic classification
    llmRegistry: registry,
    remediationEngine,
    // Phase 7 — Self-Improving Autonomy: per-engine EMA calibration +
    // silent-regression watchdog. Phase Learn updates both on every
    // trace; dashboards subscribe to `phase7:*` events. Drift detection
    // is stateless and is invoked inline in Phase Learn — no dep needed.
    oracleEMACalibrator,
    regressionMonitor,
    // K2.2: Engine selector for trust-weighted provider selection
    engineSelector: providerTrustStore
      ? new DefaultEngineSelector({
          trustStore: providerTrustStore,
          bus,
          marketScheduler,
          costPredictor,
        })
      : undefined,
    // Extensible Thinking — 2D routing grid compiler (Phase 2.1)
    thinkingPolicyCompiler: extensibleThinkingEnabled
      ? new DefaultThinkingPolicyCompiler(extensibleThinkingConfig)
      : undefined,
  };

  // K2.3: Wire concurrent dispatcher (needs executeTask thunk, so done after deps)
  const k2TaskQueue = createTaskQueue({ maxConcurrent: 5 });
  const executeTaskThunk = (subInput: TaskInput) => executeTask(subInput, deps);
  deps.concurrentDispatcher = new DefaultConcurrentDispatcher({
    taskQueue: k2TaskQueue,
    executeTask: executeTaskThunk,
    bus,
  });

  // Phase 6.4: Late-bind delegation deps to worker pool
  const delegationRouter = new DelegationRouter();

  // Agent Conversation — consult_peer (PR #7): build a deterministic
  // peer consultant backed by the LLM provider registry. The consultant
  // picks the first reasoning engine whose `id` differs from the
  // worker's current `routing.model`, preferring higher tiers first.
  // This honors A1 epistemic separation (generator != verifier) at the
  // cross-model level without introducing a new dependency abstraction.
  //
  // Returns `null` when no distinct peer is available (e.g., only one
  // provider is registered). handleConsultPeer in agent-loop treats
  // null as a denial rather than consulting the same model.
  const PEER_SYSTEM_PROMPT = [
    'You are a structured second-opinion assistant in the Vinyan orchestrator.',
    'A peer agent has asked you a specific question — answer it directly and concisely.',
    'Your response will be treated as ADVISORY (heuristic tier) by the asking agent,',
    'who has their own evidence base and the full task context.',
    '',
    'Rules:',
    '- Give a direct answer first, then brief supporting reasoning (2-4 sentences total).',
    '- If you disagree with an implied approach, say so and explain why.',
    '- If you do not have enough context to answer, say "insufficient context" and list what you would need.',
    '- Do not speculate beyond the scope of the question.',
    '- Do not ask follow-up questions — you are not in the conversation loop.',
  ].join('\n');
  const peerConsultant: NonNullable<AgentLoopDeps['peerConsultant']> = async (request, workerModelId) => {
    // Preferred tier order: powerful → balanced → fast. Within each
    // tier we only accept a provider whose id differs from the worker's.
    const tiers = ['powerful', 'balanced', 'fast'] as const;
    let peer: ReturnType<typeof registry.selectByTier> | undefined;
    for (const tier of tiers) {
      const candidate = registry.selectByTier(tier);
      if (candidate && candidate.id !== workerModelId) {
        peer = candidate;
        break;
      }
    }
    if (!peer) return null;

    const start = performance.now();
    const userPrompt = request.context
      ? `Question: ${request.question}\n\nContext: ${request.context}`
      : `Question: ${request.question}`;
    // Cap the peer response budget aggressively — consultations are
    // lightweight by design. Clients can hint via requestedTokens but
    // the server-side cap is authoritative.
    const maxTokens = Math.min(Math.max(request.requestedTokens ?? 1500, 256), 2000);
    const response = await peer.generate({
      systemPrompt: PEER_SYSTEM_PROMPT,
      userPrompt,
      maxTokens,
    });
    return {
      opinion: response.content,
      // A5: hardcoded heuristic-tier cap. The peer LLM cannot self-promote
      // to 'known' tier regardless of what it writes in its response.
      confidence: 0.7,
      confidenceSource: 'llm-self-report',
      peerEngineId: peer.id,
      tokensUsed: {
        input: response.tokensUsed.input,
        output: response.tokensUsed.output,
      },
      durationMs: Math.round(performance.now() - start),
    };
  };

  const agentLoopDeps: Partial<AgentLoopDeps> = {
    workspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: resolve(import.meta.dir, 'worker/agent-worker-entry.ts'),
    proxySocketPath: llmProxy?.socketPath,
    toolExecutor: {
      execute: async (call, context) => {
        const results = await toolExecutor.executeProposedTools([call], context);
        return results[0]!;
      },
    },
    compressPerception,
    bus,
    delegationRouter,
    executeTask: executeTaskThunk,
    peerConsultant,
    // Phase 7e: surface dynamically discovered MCP tools in the agent
    // manifest. The map is shared by reference with `toolExecutor`, so
    // tools registered after orchestrator startup appear automatically.
    extraTools: mcpToolMap,
    // Agent Conversation §5.6: hand the InstanceCoordinator (already
    // built above for phase-predict's worker-saturation fallback) to
    // the agent loop too, so subagent-style `delegate_task` calls can
    // also dispatch to remote peers. When `instanceCoordinator` is
    // undefined this property simply doesn't exist on deps and the
    // loop falls back to local-only dispatch.
    instanceCoordinator,
    // Book-integration Wave 1.1: worker-level silence watchdog. Enabled
    // by default with conservative thresholds — 15 s to warn, 45 s to
    // flag stalled. A worker legitimately thinking through a hard
    // problem typically emits progress events (`agent:tool_executed`,
    // `agent:turn_complete`) within the warn window; crossing 45 s
    // without any turn at all is a strong indicator the subprocess is
    // stuck (infinite loop, blocking read, dead LLM call). Operators
    // can override via config.silentAgentConfig or disable entirely
    // by passing `{ warnAfterMs: Number.MAX_SAFE_INTEGER - 1, ... }`.
    silentAgentConfig: config.silentAgentConfig ?? {
      warnAfterMs: 15_000,
      stallAfterMs: 45_000,
    },
  };
  workerPool.setAgentLoopDeps(agentLoopDeps as AgentLoopDeps);

  // Wire bus listeners (read-only observers — A3 compliance)
  const metricsCollector = new MetricsCollector();
  const detachMetrics = metricsCollector.attach(bus);
  const traceListenerHandle = attachTraceListener(bus);
  const detachAudit = attachAuditListener(bus, join(workspace, '.vinyan', 'audit.jsonl'));
  const detachAccuracy = oracleAccuracyStore ? attachOracleAccuracyListener(bus, oracleAccuracyStore) : undefined;

  // GAP-H failure mode detection (G5: was dead code, now live)
  const gapHDetector = new GapHDetector(bus);
  const detachGapH = gapHDetector.attach();

  // A7: Cache predictions for shadow feedback loop (prediction is not persisted to DB)
  const predictionCache = new Map<string, import('./types.ts').SelfModelPrediction>();
  bus.on('selfmodel:predict', ({ prediction }: { prediction: import('./types.ts').SelfModelPrediction }) => {
    predictionCache.set(prediction.taskId, prediction);
    // Keep cache bounded
    if (predictionCache.size > 200) {
      const oldest = predictionCache.keys().next().value;
      if (oldest) predictionCache.delete(oldest);
    }
  });

  // Shadow validation listener — update trace store and feed back to Self-Model (H3 + A7)
  if (shadowRunner && traceStore) {
    bus.on('shadow:complete', ({ result }) => {
      traceStore.updateShadowValidation(result.taskId, result);
      // A7: Feed shadow outcome back to Self-Model for calibration
      const cached = predictionCache.get(result.taskId);
      if (cached && 'calibrate' in selfModel) {
        try {
          const shadowTrace = {
            taskId: result.taskId,
            outcome: result.testsPassed ? ('success' as const) : ('failure' as const),
            durationMs: result.durationMs,
            qualityScore: { composite: result.testsPassed ? 0.8 : 0.3 },
          } as import('./types.ts').ExecutionTrace;
          selfModel.calibrate(cached, shadowTrace);
        } catch {
          /* best-effort calibration */
        }
      }
      predictionCache.delete(result.taskId);
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
          bus.emit('shadow:complete', {
            job: {
              id: '',
              taskId: result.taskId,
              status: 'done' as const,
              enqueuedAt: 0,
              retryCount: 0,
              maxRetries: 1,
            },
            result,
          });
        }
      } catch {
        /* best-effort background processing */
      }
    }, 10_000);
  }

  return {
    executeTask: async (input: TaskInput) => {
      const result = await executeTask(input, deps);
      sessionCount++;

      // Trigger sleep cycle at interval (best-effort, never blocks main flow)
      if (sleepCycleRunner && sessionCount >= sleepCycleRunner.getInterval()) {
        sleepCycleRunner.run().catch(() => {
          /* best-effort */
        });
        sessionCount = 0;
      }

      return result;
    },
    executeTaskBatch: async (tasks: TaskInput[]) => {
      const { executeTaskBatch } = await import('./core-loop.ts');
      return executeTaskBatch(tasks, deps);
    },
    traceCollector,
    traceListener: traceListenerHandle,
    bus,
    sessionManager: config.sessionManager,
    shadowRunner,
    skillManager,
    sleepCycleRunner,
    workerLifecycle,
    // Exposed stores for API server wiring (G7)
    traceStore,
    ruleStore,
    skillStore,
    patternStore,
    shadowStore,
    workerStore,
    worldGraph,
    metricsCollector,
    approvalGate,
    getSessionCount: () => sessionCount,
    close: () => {
      if (shadowInterval) clearInterval(shadowInterval);
      fileWatcher?.stop();
      detachGapH();
      detachMetrics();
      traceListenerHandle.detach();
      detachAudit();
      detachAccuracy?.();
      approvalGate.clear();
      mcpClientPool?.shutdown().catch(() => {});
      llmProxy?.close();
      worldGraph?.close();
      db?.close();
    },
  };
}

/** Default allowed engine ID prefixes — configurable via OrchestratorConfig.workerModelAllowlist. */
const DEFAULT_WORKER_MODEL_ALLOWLIST = ['claude-', 'gpt-', 'gemini-', 'mock/', 'openrouter/', 'anthropic/'];

/**
 * Async variant of createOrchestrator — delegates to the sync version with
 * yield points so the TUI render loop can paint spinner frames.
 *
 * Use this from TUI only. CLI/tests should use the sync createOrchestrator.
 *
 * NOTE: Previously this was a full copy of createOrchestrator that had diverged
 * (missing economy, extensible thinking, provider trust). Now it delegates to
 * ensure feature parity.
 */
export async function createOrchestratorAsync(
  config: OrchestratorConfig,
  onProgress?: (message: string) => void,
): Promise<Orchestrator> {
  const { yieldFrame } = await import('./factory-utils.ts');

  onProgress?.('Opening database...');
  await yieldFrame();

  onProgress?.('Creating components...');
  await yieldFrame();

  const orchestrator = createOrchestrator(config);

  onProgress?.('Ready');
  return orchestrator;
}

/**
 * Auto-register existing providers as WorkerProfiles.
 * Grandfathered as "active" — these are proven models from Phase 3.
 * Allowlist is configurable; pass [] to skip filtering (for custom RE types).
 *
 * Also registers non-LLM engines from engineRegistry so fleet governance
 * (WorkerLifecycle, WorkerSelector, CapabilityModel) can track them.
 */
function autoRegisterWorkers(
  registry: LLMProviderRegistry,
  workerStore: WorkerStore,
  bus: VinyanBus,
  allowlist: string[] = DEFAULT_WORKER_MODEL_ALLOWLIST,
  engineRegistry?: ReasoningEngineRegistry,
): void {
  // Register LLM providers from the legacy registry
  for (const provider of registry.listProviders()) {
    // M12: Validate engine against allowlist before registration. Empty allowlist = no filter.
    if (allowlist.length > 0 && !allowlist.some((p) => provider.id.startsWith(p))) {
      console.warn(`[vinyan] Skipping worker registration for '${provider.id}' — not in model allowlist`);
      continue;
    }

    const workerId = `worker-${provider.id}`;
    if (workerStore.findById(workerId)) continue;

    const profile: WorkerProfile = {
      id: workerId,
      config: {
        modelId: provider.id,
        temperature: 0.7,
        systemPromptTemplate: 'default',
        maxContextTokens: provider.maxContextTokens,
      },
      status: 'active', // grandfathered — proven from Phase 3
      createdAt: Date.now(),
      demotionCount: 0,
    };
    workerStore.insert(profile);
    bus.emit('worker:registered', { profile });
  }

  // Register non-LLM engines from engineRegistry (fleet governance visibility)
  if (engineRegistry) {
    for (const engine of engineRegistry.listEngines()) {
      if (engine.engineType === 'llm') continue; // already registered via LLMProviderRegistry above
      const workerId = `worker-${engine.id}`;
      if (workerStore.findById(workerId)) continue;

      const profile: WorkerProfile = {
        id: workerId,
        config: {
          modelId: engine.id, // engine.id as model identifier for non-LLM REs
          temperature: 0, // not applicable for non-LLM
          systemPromptTemplate: 'none',
          maxContextTokens: engine.maxContextTokens,
          engineType: engine.engineType,
          capabilitiesDeclared: engine.capabilities,
        },
        status: 'active',
        createdAt: Date.now(),
        demotionCount: 0,
      };
      workerStore.insert(profile);
      bus.emit('worker:registered', { profile });
    }
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

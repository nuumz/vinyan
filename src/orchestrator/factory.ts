/**
 * Orchestrator Factory — wires all dependencies and returns the executeTask function.
 *
 * This is the single entry point for creating a fully-wired orchestrator.
 * Source of truth: spec/tdd.md §16 (Core Loop)
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { resolveInstanceId } from '../a2a/identity.ts';
import { attachAuditListener } from '../bus/audit-listener.ts';
import { attachComprehensionTraceListener } from '../bus/comprehension-trace-listener.ts';
import { attachOracleAccuracyListener } from '../bus/oracle-accuracy-listener.ts';
import { attachTraceListener } from '../bus/trace-listener.ts';
import { loadConfig } from '../config/loader.ts';
import type { AgentSpecConfig } from '../config/schema.ts';
import { createBus, type VinyanBus } from '../core/bus.ts';
import { AgentContextStore } from '../db/agent-context-store.ts';
import { AgentProfileStore } from '../db/agent-profile-store.ts';
import { ComprehensionStore } from '../db/comprehension-store.ts';
import { LocalOracleProfileStore } from '../db/local-oracle-profile-store.ts';
import { OracleAccuracyStore } from '../db/oracle-accuracy-store.ts';
import { OracleProfileStore } from '../db/oracle-profile-store.ts';
import { PatternStore } from '../db/pattern-store.ts';
import { PredictionLedger } from '../db/prediction-ledger.ts';
import { migratePredictionLedgerSchema } from '../db/prediction-ledger-schema.ts';
import { ProviderTrustStore } from '../db/provider-trust-store.ts';
import { RejectedApproachStore } from '../db/rejected-approach-store.ts';
import { RoomStore } from '../db/room-store.ts';
import { RuleStore } from '../db/rule-store.ts';
import { ShadowStore } from '../db/shadow-store.ts';
import { SkillStore } from '../db/skill-store.ts';
import { TaskCheckpointStore } from '../db/task-checkpoint-store.ts';
import { TraceStore } from '../db/trace-store.ts';
import { UserPreferenceStore } from '../db/user-preference-store.ts';
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
import { setGateDeps } from '../gate/gate.ts';
import type { MessagingAdapterLifecycleManager } from '../gateway/lifecycle.ts';
import { type ScheduleRunnerHandle, setupScheduleRunner } from '../gateway/scheduling/wiring.ts';
import { MCPClientPool, type MCPServerConfig } from '../mcp/client.ts';
import type { McpSourceZone } from '../mcp/ecp-translation.ts';
import { dedupePreVinyanSources, loadMcpJsonServers, mergeMcpServerSources } from '../mcp/mcp-json-loader.ts';
import { GapHDetector } from '../observability/gap-h-detector.ts';
import { MetricsCollector } from '../observability/metrics.ts';
import { verify as depVerify } from '../oracle/dep/dep-analyzer.ts';
import { verify as goalAlignmentVerify } from '../oracle/goal-alignment/goal-alignment-verifier.ts';
import { loadBundleManifests } from '../plugin/index.ts';
import type { PluginRegistry } from '../plugin/registry.ts';
import { populateProviderKeysFromKeychain } from '../security/keychain.ts';
import {
  type ReactiveTraceSummary,
  reactiveRuleToEvolutionary,
  synthesizeReactiveRule,
  traceToReactiveSummary,
} from '../sleep-cycle/reactive-cycle.ts';
import { SleepCycleRunner } from '../sleep-cycle/sleep-cycle.ts';
import { FileWatcher } from '../world-graph/file-watcher.ts';
import { WorldGraph } from '../world-graph/world-graph.ts';
import type { AgentLoopDeps } from './agent/agent-loop.ts';
import { runAgentLoop } from './agent/agent-loop.ts';
import { AgentEvolution } from './agent-context/agent-evolution.ts';
import { AgentContextBuilder } from './agent-context/context-builder.ts';
import { AgentContextUpdater } from './agent-context/context-updater.ts';
import { SoulReflector } from './agent-context/soul-reflector.ts';
import { SoulStore } from './agent-context/soul-store.ts';
import { AgentMemoryAPIImpl } from './agent-memory/agent-memory-impl.ts';
import { createAgentRouter } from './agent-router.ts';
import { scanAgentMarkdown, soulsByIdFrom } from './agents/markdown-loader.ts';
import { loadAgentRegistry } from './agents/registry.ts';
import { ApprovalGate as ApprovalGateImpl } from './approval-gate.ts';
import { ComprehensionCalibrator } from './comprehension/learning/calibrator.ts';
import { newLlmComprehender } from './comprehension/llm-comprehender.ts';
import { DefaultConcurrentDispatcher } from './concurrent-dispatcher.ts';
import { executeTask, type OrchestratorDeps } from './core-loop.ts';
import { DebateBudgetGuard } from './critic/debate-budget-guard.ts';
import { ArchitectureDebateCritic, DebateRouterCritic } from './critic/debate-mode.ts';
import { LLMCriticImpl } from './critic/llm-critic-impl.ts';
import type { DataGateThresholds } from './data-gate.ts';
import { DelegationRouter } from './delegation-router.ts';
import { buildEcosystem, type EcosystemBundle } from './ecosystem/builder.ts';
import { TaskFactsRegistry } from './ecosystem/task-facts-registry.ts';
import { DefaultEngineSelector } from './engine-selector.ts';
import { HumanECPBridge } from './engines/human-ecp-bridge.ts';
import { Z3ReasoningEngine } from './engines/z3-reasoning-engine.ts';
import { CapabilityModel } from './fleet/capability-model.ts';
import { WorkerLifecycle } from './fleet/worker-lifecycle.ts';
import { WorkerSelector } from './fleet/worker-selector.ts';
import {
  type FailureCluster,
  type FailureClusterConfig,
  FailureClusterDetector,
} from './goal-satisfaction/failure-cluster-detector.ts';
import { DefaultGoalEvaluator } from './goal-satisfaction/goal-evaluator.ts';
import { InstanceCoordinator } from './instance-coordinator.ts';
import { createAnthropicProvider } from './llm/anthropic-provider.ts';
import { loadInstructionMemory } from './llm/instruction-loader.ts';
import { startLLMProxy } from './llm/llm-proxy.ts';
import { ReasoningEngineRegistry } from './llm/llm-reasoning-engine.ts';
import { registerOpenRouterProviders } from './llm/openrouter-provider.ts';
import { compressPerception } from './llm/perception-compressor.ts';
import { LLMProviderRegistry } from './llm/provider-registry.ts';
import { buildMcpToolMap } from './mcp/mcp-tool-adapter.ts';
import { OracleEMACalibrator } from './monitoring/oracle-ema-calibrator.ts';
import { RegressionMonitor } from './monitoring/regression-monitor.ts';
import { OracleGateAdapter } from './oracle-gate-adapter.ts';
import { PerceptionAssemblerImpl } from './perception.ts';
import { initializePlugins, type PluginInitResult } from './plugin-init.ts';
import { ErrorAttributionBus } from './prediction/error-attribution-bus.ts';
import { FileStatsCache } from './prediction/file-stats-cache.ts';
import { ForwardPredictorImpl } from './prediction/forward-predictor.ts';
import { PercentileCache } from './prediction/percentile-cache.ts';
import { CalibratedSelfModel, SelfModelStub } from './prediction/self-model.ts';
import { FleetRegistry } from './profile/fleet-registry.ts';
import { LocalOracleGates, type LocalOracleProfile } from './profile/local-oracle-gates.ts';
import { ProfileLifecycle } from './profile/profile-lifecycle.ts';
import { RemediationEngine } from './remediation-engine.ts';
import { DecompositionLearner } from './replan/decomposition-learner.ts';
import { buildFailurePatternLibrary } from './replan/failure-pattern-library.ts';
import { DefaultReplanEngine, type ReplanEngineConfig } from './replan/replan-engine.ts';
import { RiskRouterImpl } from './risk-router-adapter.ts';
import { RoomDispatcher } from './room/room-dispatcher.ts';
import { ShadowRunner } from './shadow-runner.ts';
import { SkillManager } from './skill-manager.ts';
import { TaskDecomposerImpl, TaskDecomposerStub } from './task-decomposer.ts';
import { createTaskQueue } from './task-queue.ts';
import { LLMTestGeneratorImpl } from './test-gen/llm-test-generator.ts';
import { DefaultThinkingPolicyCompiler } from './thinking/thinking-compiler.ts';
import { ToolExecutor } from './tools/tool-executor.ts';
import type { Tool } from './tools/tool-interface.ts';
import { TraceCollectorImpl } from './trace-collector.ts';
import type { AgentPreferences, AgentProfile, EngineProfile, TaskInput, TaskResult } from './types.ts';
import { UnderstandingEngine } from './understanding/understanding-engine.ts';
import { UserInterestMiner } from './user-context/user-interest-miner.ts';
import { setupUserMdObserver } from './user-context/wiring.ts';
import { WorkerPoolImpl } from './worker/worker-pool.ts';
import { WorkflowRegistry } from './workflows/workflow-registry.ts';

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
  /**
   * Book-integration Wave 5.7a: per-task Architecture Debate cap.
   * Default: 1 — a task can fire the debate at most once across its
   * entire inner retry loop. Set to 0 to disable debate entirely, or
   * to a larger number to allow re-runs after failed retries.
   */
  debateMaxPerTask?: number;
  /**
   * Book-integration Wave 5.7b: per-day Architecture Debate cap.
   * Rolling counter of debate fires between midnight UTC and the
   * next midnight. Default: undefined (no day cap; only per-task
   * cap enforced). Set to 0 to disable debate for the whole day.
   */
  debateMaxPerDay?: number;
  /**
   * Enable LLM proxy for credential isolation (A6).
   * Default: `true` when subprocess workers are used (the production case).
   * Tests with `useSubprocess: false` are unaffected. Pass `false` to opt out
   * (legacy mode forwards `*_API_KEY` to worker subprocesses — A6 violation).
   */
  llmProxy?: boolean;
  /**
   * Pull provider API keys from the OS keychain at startup (G2+ — A6).
   * Default: `false`. When `true`, missing env vars (e.g., `ANTHROPIC_API_KEY`)
   * are populated from the keychain entry stored under service `vinyan`,
   * account = env-var name. Existing env vars take precedence. macOS prompts
   * the user on first read; Linux requires `secret-tool` (libsecret).
   * See src/security/keychain.ts for setup commands.
   */
  useKeychain?: boolean;
  /** Session manager for conversation agent mode (optional — wired into deps if provided). */
  sessionManager?: import('../api/session-manager.ts').SessionManager;
  /**
   * Shared VinyanDB handle. Callers that also need the same database outside
   * the orchestrator (e.g. serve.ts constructs SessionStore + SessionManager
   * from it) MUST inject the handle here so we don't open a second bun:sqlite
   * connection on the same WAL file — that duplicates migration passes, gives
   * each connection its own cache/journal snapshot, and risks SQLITE_BUSY.
   * When provided, the orchestrator will NOT close this handle on teardown —
   * lifecycle stays with the caller.
   */
  db?: import('../db/vinyan-db.ts').VinyanDB;
  /**
   * Allowlist of engine ID prefixes for auto-registration into worker_profiles.
   * Defaults to the legacy LLM vendor list. Pass [] to disable allowlist filtering
   * (useful when using a custom engineRegistry with non-LLM REs).
   */
  workerModelAllowlist?: string[];
  /**
   * Unified AgentProfile: bootstrap policy for newly-registered workers.
   *   'earn'       — register newcomers as `probation`; promote via Wilson LB gate
   *                 from real traces. Existing providers with ≥ probationMinTasks
   *                 historical traces are grandfathered to `active`.
   *   'grandfather' — register newcomers as `active` (legacy behavior, kept so
   *                 smoke tests and fixtures that depend on immediate dispatch
   *                 continue to pass).
   * Default: 'earn' (A7 compliance — engines must earn trust from evidence).
   */
  workerBootstrapPolicy?: 'earn' | 'grandfather';
  /** Command approval gate — enables interactive approval for unlisted shell commands. */
  commandApprovalGate?: import('./tools/command-approval-gate.ts').CommandApprovalGate;
  /** Enable background workspace watching for WorldGraph invalidation (default: true). */
  watchWorkspace?: boolean;
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
  // Unified profile layer (Step 1-3 of the AgentProfile ultraplan).
  localOracleProfileStore?: LocalOracleProfileStore;
  localOracleLifecycle?: ProfileLifecycle<LocalOracleProfile>;
  fleetRegistry?: import('./profile/fleet-registry.ts').FleetRegistry;
  // Exposed stores for API server (G7)
  traceStore?: TraceStore;
  ruleStore?: RuleStore;
  skillStore?: SkillStore;
  patternStore?: PatternStore;
  shadowStore?: ShadowStore;
  workerStore?: WorkerStore;
  /** AgentProfileStore — workspace singleton (Vinyan Agent identity). */
  agentProfileStore?: AgentProfileStore;
  /** Resolved AgentProfile snapshot from bootstrap (convenience). */
  agentProfile?: AgentProfile;
  /** AgentContextStore — per-agent episodic memory and learned skills. */
  agentContextStore?: AgentContextStore;
  /** AgentRegistry — merged built-in + config agent specs. */
  agentRegistry?: ReturnType<typeof loadAgentRegistry>;
  /** MCP client pool — exposed read-only for dashboard inspection. */
  mcpClientPool?: MCPClientPool;
  /** Oracle accuracy store — per-oracle verdict outcomes for /oracles dashboard. */
  oracleAccuracyStore?: OracleAccuracyStore;
  /** Prediction ledger — recorded predictions + Brier scores for /calibration dashboard. */
  predictionLedger?: PredictionLedger;
  /** Provider trust store — per-(provider, capability) reliability for /providers dashboard. */
  providerTrustStore?: ProviderTrustStore;
  /** Federation budget pool — shared across instances for /federation dashboard. */
  federationBudgetPool?: import('../economy/federation-budget-pool.ts').FederationBudgetPool;
  /** Market scheduler — Vickrey auction + phase for /market dashboard. */
  marketScheduler?: import('../economy/market/market-scheduler.ts').MarketScheduler;
  /** Capability model — per-worker capability scores, for /engines deepen. */
  capabilityModel?: import('./fleet/capability-model.ts').CapabilityModel;
  worldGraph?: WorldGraph;
  metricsCollector?: MetricsCollector;
  approvalGate?: ApprovalGateImpl;
  // Economy stores (exposed for API/TUI)
  costLedger?: import('../economy/cost-ledger.ts').CostLedger;
  budgetEnforcer?: import('../economy/budget-enforcer.ts').BudgetEnforcer;
  /**
   * W2 Plugin Registry — populated when `config.plugins.enabled` is true.
   * `undefined` otherwise. Tests/consumers should `await pluginsReady` before
   * inspecting this field because plugin discovery is async.
   */
  pluginRegistry?: PluginRegistry;
  /**
   * W2 messaging-adapter lifecycle (Gateway H1). `startAll` / `stopAll` the
   * subset of plugins whose category is `messaging-adapter`. Only populated
   * alongside `pluginRegistry`.
   */
  messagingLifecycle?: MessagingAdapterLifecycleManager;
  /**
   * Non-fatal warnings raised during plugin discovery / memory or skill
   * tool registration. Only populated alongside `pluginRegistry`.
   */
  pluginWarnings?: readonly string[];
  /**
   * Resolves once the W2 plugin init coroutine has finished (registry
   * ingested discovered plugins; optional auto-activation applied). Tests
   * awaiting `pluginRegistry` should `await pluginsReady` first. Only
   * populated when `config.plugins.enabled` is true.
   */
  pluginsReady?: Promise<PluginInitResult>;
  getSessionCount(): number;
  /**
   * Release all resources held by the orchestrator. Awaits truly async
   * teardown (chokidar file-watcher, MCP subprocess pool) so callers
   * can guarantee process exit is not blocked on leftover fds / pipes.
   * Legacy callers that do not await get fire-and-forget behavior —
   * equivalent to the old sync signature.
   */
  close(): Promise<void>;
}

/**
 * Await `p`, but give up after `ms` and resolve anyway. The timer is
 * unref'd so it never holds the event loop alive on its own. Used for
 * shutdown steps where we want best-effort cleanup but cannot let a
 * misbehaving resource block process exit.
 */
async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const to = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([p.then(() => undefined), to]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  // G2+: Optionally fill missing provider keys from the OS keychain BEFORE
  // building the registry. Env vars still win (so `ANTHROPIC_API_KEY=...
  // bun run vinyan run` keeps overriding behaviour). When the caller supplied
  // their own registry we skip — they own credential resolution.
  if (config.useKeychain && !config.registry) {
    const result = populateProviderKeysFromKeychain();
    if (result.populated.length > 0) {
      console.warn(`[vinyan] Loaded ${result.populated.length} key(s) from keychain (${result.backend})`);
    }
  }

  // Set up LLM provider registry
  const registry = config.registry ?? createDefaultRegistry();

  // Set up persistent database. When the caller injected a handle, reuse it
  // so we don't open a second bun:sqlite connection on the same WAL file.
  // `ownsDb` controls whether close() also closes the handle — injected
  // handles belong to the caller.
  const injectedDb = config.db;
  let db: VinyanDB | undefined = injectedDb;
  const ownsDb = !injectedDb;
  let traceStore: TraceStore | undefined;
  let oracleAccuracyStore: OracleAccuracyStore | undefined;
  try {
    if (!db) {
      db = new VinyanDB(join(workspace, '.vinyan', 'vinyan.db'));
    }
    traceStore = new TraceStore(db.getDb());
    oracleAccuracyStore = new OracleAccuracyStore(db.getDb());
  } catch {
    // SQLite unavailable — fall back to in-memory only
  }

  // Phase 2 stores — all use same db instance
  let patternStore: PatternStore | undefined;
  let shadowStore: ShadowStore | undefined;
  let skillStore: SkillStore | undefined;
  let ruleStore: RuleStore | undefined;
  let workerStore: WorkerStore | undefined;
  let rejectedApproachStore: RejectedApproachStore | undefined;
  let providerTrustStore: ProviderTrustStore | undefined;
  let comprehensionStore: ComprehensionStore | undefined;
  let userPreferenceStore: UserPreferenceStore | undefined;
  let agentContextStore: AgentContextStore | undefined;
  let agentProfileStore: AgentProfileStore | undefined;
  let agentProfile: AgentProfile | undefined;
  if (db) {
    patternStore = new PatternStore(db.getDb());
    shadowStore = new ShadowStore(db.getDb());
    skillStore = new SkillStore(db.getDb());
    ruleStore = new RuleStore(db.getDb());
    workerStore = new WorkerStore(db.getDb());
    rejectedApproachStore = new RejectedApproachStore(db.getDb());
    providerTrustStore = new ProviderTrustStore(db.getDb());
    comprehensionStore = new ComprehensionStore(db.getDb());
    userPreferenceStore = new UserPreferenceStore(db.getDb());
    agentContextStore = new AgentContextStore(db.getDb());

    // AgentProfile — workspace-level Vinyan Agent identity (singleton)
    agentProfileStore = new AgentProfileStore(db.getDb());
    agentProfile = bootstrapAgentProfile(agentProfileStore, workspace, config);
  }

  // Phase 4: Auto-register existing LLM providers as WorkerProfiles (PH4.0 data seeding).
  // fleetConfig is loaded lower; use the same default probation threshold here.
  if (workerStore) {
    autoRegisterWorkers(
      registry,
      workerStore,
      bus,
      config.workerModelAllowlist,
      config.engineRegistry,
      config.workerBootstrapPolicy ?? 'earn',
      30,
    );
  }

  // Set up WorldGraph for fact invalidation (A4: content-addressed truth)
  let worldGraph: WorldGraph | undefined;
  let fileWatcher: FileWatcher | undefined;
  try {
    worldGraph = new WorldGraph(join(workspace, '.vinyan', 'world-graph.db'));
    // A4: Watch workspace for external file changes — auto-invalidate stale facts
    if (config.watchWorkspace !== false) {
      fileWatcher = new FileWatcher(worldGraph, workspace);
      fileWatcher.start();
    }
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
  // Wave 1: Goal-Satisfaction Outer Loop config (gated OFF by default).
  let goalLoopConfig: { enabled: boolean; maxOuterIterations: number; goalSatisfactionThreshold: number } | undefined;
  // Wave 3: Agent-Facing Memory API — default ON (additive).
  let agentMemoryEnabled = true;
  // Wave 2: Replan Engine config (gated OFF by default, requires goalLoop).
  let replanConfig: ReplanEngineConfig | undefined;
  // Wave 5a: Reactive micro-learning config (gated OFF by default).
  let reactiveLearningConfig: FailureClusterConfig | undefined;
  // Wave 5b: Skill hints config (default ON when config absent).
  let skillHintsConfig: { enabled: boolean; topK: number } = { enabled: true, topK: 3 };
  // Wave 4: Agent-loop goal-driven termination (gated OFF by default).
  let agentLoopGoalTerminationConfig:
    | {
        enabled: boolean;
        maxContinuations: number;
        continuationBudgetFraction: number;
        goalSatisfactionThreshold: number;
      }
    | undefined;
  // Phase 2: realtime streaming (token-level `agent:text_delta`). Default OFF.
  let streamingAssistantDelta = false;
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
      const gl = vinyanConfig.orchestrator.goalLoop;
      if (gl) {
        goalLoopConfig = {
          enabled: gl.enabled,
          maxOuterIterations: gl.maxOuterIterations,
          goalSatisfactionThreshold: gl.goalSatisfactionThreshold,
        };
      }
      if (vinyanConfig.orchestrator.agent_memory) {
        agentMemoryEnabled = vinyanConfig.orchestrator.agent_memory.enabled !== false;
      }
      const rp = vinyanConfig.orchestrator.replan;
      if (rp) {
        replanConfig = {
          enabled: rp.enabled,
          maxReplans: rp.maxReplans,
          tokenSpendCapFraction: rp.tokenSpendCapFraction,
          trigramSimilarityMax: rp.trigramSimilarityMax,
        };
      }
      const rl = vinyanConfig.orchestrator.reactiveLearning;
      if (rl) {
        reactiveLearningConfig = {
          enabled: rl.enabled,
          windowMs: rl.windowMs,
          minFailures: rl.minFailures,
        };
      }
      const sh = vinyanConfig.orchestrator.skillHints;
      if (sh) {
        skillHintsConfig = { enabled: sh.enabled, topK: sh.topK };
      }
      const agt = vinyanConfig.orchestrator.agentLoopGoalTermination;
      if (agt) {
        agentLoopGoalTerminationConfig = {
          enabled: agt.enabled,
          maxContinuations: agt.maxContinuations,
          continuationBudgetFraction: agt.continuationBudgetFraction,
          // Inherit threshold from goalLoop so both layers agree.
          goalSatisfactionThreshold: goalLoopConfig?.goalSatisfactionThreshold ?? 0.75,
        };
      }
    }
    if (vinyanConfig.fleet) {
      fleetConfig = vinyanConfig.fleet;
    }
    if (vinyanConfig.streaming?.assistantDelta) {
      streamingAssistantDelta = true;
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
      const budgetConfig = economyConfig.budgets ?? { enforcement: 'warn' as const };
      budgetEnforcer = new BudgetEnforcer(budgetConfig, costLedger, bus);
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

  // Workflow approval gating — Phase E. Default 'auto' (approve short goals,
  // require approval for long-form). No-ops until a user wires the config.
  let workflowConfig: import('./workflow/approval-gate.ts').WorkflowConfig | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    if (vinyanConfig.workflow) {
      workflowConfig = vinyanConfig.workflow;
    }
  } catch {
    /* workflow config is best-effort */
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
      // Wire bus so the ecosystem coordinator (built below) can observe
      // engine:registered / engine:deregistered without touching the hot path.
      engineRegistry.setBus(bus);
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
        autoRegisterWorkers(
          registry,
          workerStore,
          bus,
          config.workerModelAllowlist,
          engineRegistry,
          config.workerBootstrapPolicy ?? 'earn',
          fleetConfig?.probation_min_tasks ?? 30,
        );
      }
    }
  } catch {
    /* engine registration is best-effort */
  }

  // K2.5: MCP Client Pool — external tool access with oracle verification.
  //
  // Sources merged in this order (later overrides earlier per-server, but
  // FIELDS are preserved — vinyan.json overrides only the trust tier and the
  // command, never silently strips `args` that came from `.mcp.json`):
  //   1. `.mcp.json` / `.claude/mcp.json` (G11 — Claude Code drop-in compat)
  //   2. `vinyan.json` `network.mcp.client_servers` (Vinyan-native — used to
  //      upgrade trust tier for a server already declared in `.mcp.json`).
  //
  // Each source is read inside its own try/catch so a malformed `vinyan.json`
  // can't suppress an otherwise-valid `.mcp.json`, and vice versa (review
  // comment on PR #25:693).
  let mcpClientPool: MCPClientPool | undefined;
  try {
    const TRUST_MAP: Record<string, McpSourceZone> = {
      untrusted: 'remote',
      provisional: 'network',
      established: 'network',
      trusted: 'local',
    };

    // 1. .mcp.json — all entries default to 'untrusted' / 'remote' zone.
    let mcpJsonResult: ReturnType<typeof loadMcpJsonServers> = {
      servers: [],
      attemptedPaths: [],
      invalidPaths: [],
    };
    try {
      mcpJsonResult = loadMcpJsonServers(workspace);
    } catch (err) {
      console.warn(
        `[vinyan] .mcp.json read failed: ${err instanceof Error ? err.message : String(err)} — continuing without it`,
      );
    }

    // 1b. Plugin bundle manifest (.vinyan-plugin/plugin.json + thclaws compat) —
    // pure additive source, same default trust as .mcp.json. Concatenated AFTER
    // .mcp.json so bundle entries override raw .mcp.json on name conflict (a
    // bundle is the higher-level packaging unit and operators expect it to win
    // when the same server name appears in both).
    let bundleResult: ReturnType<typeof loadBundleManifests> = {
      bundles: [],
      attemptedPaths: [],
      invalidPaths: [],
      mcpServers: [],
    };
    try {
      bundleResult = loadBundleManifests(workspace);
    } catch (err) {
      console.warn(
        `[vinyan] plugin bundle read failed: ${err instanceof Error ? err.message : String(err)} — continuing without it`,
      );
    }
    // Merge .mcp.json entries with bundle-manifest entries; bundle wins on
    // name conflict (the curated packaging unit overrides raw .mcp.json).
    // Extracted to a pure helper so the precedence chain is unit-testable
    // without spinning up the full factory (review #38:761).
    const dedupedLoaded = dedupePreVinyanSources(mcpJsonResult.servers, bundleResult.mcpServers);

    // 2. vinyan.json — best-effort overrides on name conflict. Loaded in its
    // own try/catch so a malformed vinyan.json doesn't suppress earlier sources.
    let mcpConfig: { client_servers?: Array<{ name: string; command: string; trust_level?: string }> } | undefined;
    try {
      const vinyanConfig = loadConfig(workspace);
      mcpConfig = vinyanConfig.network?.mcp as typeof mcpConfig;
    } catch (err) {
      console.warn(
        `[vinyan] vinyan.json read failed: ${err instanceof Error ? err.message : String(err)} — using earlier sources only`,
      );
    }

    const serverConfigs = mergeMcpServerSources<McpSourceZone>(
      dedupedLoaded,
      mcpConfig?.client_servers ?? [],
      TRUST_MAP,
      'remote',
    ) as MCPServerConfig[];

    if (serverConfigs.length > 0) {
      mcpClientPool = new MCPClientPool(serverConfigs, bus);
      // Distinguish each input file in startup logs so operators aren't
      // misled about which config was actually read.
      const workspaceRoot = resolve(workspace);
      const toRel = (p: string) => {
        const rel = relative(workspaceRoot, p);
        // Guard: path escapes workspace (starts with ".." segment) or is on
        // a different drive (Windows: path.relative returns absolute path).
        return rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) ? p : rel;
      };
      const mcpJsonPaths = Array.from(new Set(mcpJsonResult.attemptedPaths.map(toRel)));
      const bundlePaths = Array.from(new Set(bundleResult.attemptedPaths.map(toRel)));
      const sources: string[] = [];
      if (mcpJsonResult.servers.length > 0) {
        const label =
          mcpJsonPaths.length > 0
            ? `${mcpJsonPaths.join('+')}: ${mcpJsonResult.servers.length}`
            : `mcp.json: ${mcpJsonResult.servers.length}`;
        sources.push(label);
      }
      if (bundleResult.mcpServers.length > 0) {
        const label =
          bundlePaths.length > 0
            ? `${bundlePaths.join('+')}: ${bundleResult.mcpServers.length}`
            : `plugin.json: ${bundleResult.mcpServers.length}`;
        sources.push(label);
      }
      if (mcpConfig?.client_servers?.length) sources.push(`vinyan.json: ${mcpConfig.client_servers.length}`);
      console.log(`[vinyan] MCP Client Pool: ${serverConfigs.length} server(s) configured (${sources.join(', ')})`);
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

  // Ecosystem layer — runtime FSM + commitment ledger + department/team +
  // volunteer protocol + coordinator. Opt-in via `ecosystem.enabled` in
  // vinyan.json. Built before WorkerLifecycle so the helpfulness tiebreaker
  // (O4) can be wired into the promotion gate.
  //
  // Source of truth: docs/design/vinyan-os-ecosystem-plan.md
  let ecosystemBundle: EcosystemBundle | undefined;
  let ecosystemConfig: import('../config/schema.ts').VinyanConfig['ecosystem'] | undefined;
  // Dispatch-scoped facts registry — instantiated unconditionally so the
  // core-loop can register/unregister facts whether or not the ecosystem
  // bundle is built; the bundle's CommitmentBridge consumes the same
  // registry when ecosystem is enabled.
  const taskFactsRegistry = new TaskFactsRegistry();
  try {
    const vinyanConfigForEco = loadConfig(workspace);
    ecosystemConfig = vinyanConfigForEco.ecosystem;
    const effectiveEngineRegistry = engineRegistry ?? config.engineRegistry;
    if (db && ecosystemConfig?.enabled && effectiveEngineRegistry) {
      ecosystemBundle = buildEcosystem({
        db: db.getDb(),
        bus,
        workspace, // enables filesystem-backed team blackboard at <workspace>/.vinyan/teams
        departments: (ecosystemConfig.departments ?? []).map((d) => ({
          id: d.id,
          anchorCapabilities: d.anchor_capabilities,
          minMatchCount: d.min_match_count,
        })),
        // Production-wired: facts registered by core-loop.executeTask are
        // resolved here. The auction → commitment-bridge → ledger path is
        // now runtime-true; previously this returned `null` and silently
        // dropped every commitment.
        taskResolver: (id) => taskFactsRegistry.resolve(id),
        engineRoster: () => effectiveEngineRegistry.listEngines(),
        reconcileIntervalMs: ecosystemConfig.reconcile_interval_ms,
      });

      // Seed runtime FSM for every engine already in the registry so the
      // bridge + reconcile loop have something to observe. Guarded so
      // repeated factory calls (tests, re-init after crash recovery) do
      // not throw — crash-recovery flips Working→Standby at coordinator.start
      // above, so an engine that survived a restart reaches this block
      // already in `standby`.
      for (const eng of effectiveEngineRegistry.listEngines()) {
        const existing = ecosystemBundle.runtime.get(eng.id);
        if (!existing) {
          ecosystemBundle.runtime.register(eng.id);
        }
        const snap = ecosystemBundle.runtime.get(eng.id)!;
        if (snap.state === 'dormant') {
          ecosystemBundle.runtime.awaken(eng.id, 'boot');
          ecosystemBundle.runtime.markReady(eng.id, 'factory-init');
        } else if (snap.state === 'awakening') {
          ecosystemBundle.runtime.markReady(eng.id, 'factory-init');
        }
        // else: already standby/working — leave as-is.
      }

      ecosystemBundle.coordinator.start();
      console.log(
        `[vinyan] ecosystem: ${effectiveEngineRegistry.listEngines().length} engine(s) registered; ${ecosystemBundle.departments.listDepartments().length} department(s) seeded`,
      );
    }
  } catch (err) {
    console.warn(`[vinyan] ecosystem wiring skipped: ${(err as Error).message}`);
  }

  // Phase 4.2: Worker Lifecycle — deterministic state machine for worker governance.
  // Wired after the ecosystem so O4 helpfulness can feed the promotion gate.
  let workerLifecycle: WorkerLifecycle | undefined;
  if (workerStore) {
    workerLifecycle = new WorkerLifecycle({
      workerStore,
      bus,
      probationMinTasks: fleetConfig?.probation_min_tasks ?? 30,
      demotionWindowTasks: fleetConfig?.demotion_window_tasks ?? 30,
      demotionMaxReentries: fleetConfig?.demotion_max_reentries ?? 3,
      reentryCooldownSessions: fleetConfig?.reentry_cooldown_sessions ?? 50,
      ...(ecosystemBundle
        ? {
            helpfulnessCount: (workerId: string) =>
              ecosystemBundle!.helpfulness.get(workerId)?.deliveriesCompleted ?? 0,
          }
        : {}),
    });
  }

  // Unified profile layer — local oracle lifecycle (A7 loop).
  // Registers each oracle observed by OracleAccuracyStore as `probation` so it
  // must earn `active` from resolved-verdict accuracy. Read-only at this step
  // (gate.ts and routing don't yet consult the profile store).
  let localOracleProfileStore: LocalOracleProfileStore | undefined;
  let localOracleLifecycle: ProfileLifecycle<LocalOracleProfile> | undefined;
  if (db && oracleAccuracyStore) {
    localOracleProfileStore = new LocalOracleProfileStore(db.getDb());
    const localOracleGates = new LocalOracleGates({ accuracyStore: oracleAccuracyStore });
    localOracleLifecycle = new ProfileLifecycle<LocalOracleProfile>({
      kind: 'oracle-local',
      store: localOracleProfileStore,
      gates: localOracleGates,
      bus,
    });
    // Bootstrap: seed a probation profile for every oracle already observed.
    // New oracles register themselves lazily via ensureProfile on first use.
    for (const name of oracleAccuracyStore.listDistinctOracleNames()) {
      localOracleProfileStore.ensureProfile(name, 'probation');
    }
  }

  // Hoisted so FleetRegistry can unify remote-oracle view with worker and
  // local oracle views. The InstanceCoordinator block below reuses this
  // instance instead of constructing its own.
  const oracleProfileStore = db ? new OracleProfileStore(db.getDb()) : undefined;

  // FleetRegistry — unified read API over every profile store. Consumed by
  // phases (wired in Step 4). Currently read-only; construction order is
  // independent of routing.
  const fleetRegistry = new FleetRegistry({
    workerStore,
    oraclePeerStore: oracleProfileStore,
    localOracleProfileStore,
  });

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
          localOracleProfileStore,
          localOracleLifecycle,
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
  // A6: Start LLM proxy for credential isolation when subprocess workers run.
  // Default ON when subprocess mode is on; explicit `llmProxy: false` opts out.
  let llmProxy: import('./llm/llm-proxy.ts').LLMProxyServer | undefined;
  const subprocessEnabled = config.useSubprocess ?? true;
  const llmProxyEnabled = (config.llmProxy ?? true) && subprocessEnabled;
  if (llmProxyEnabled) {
    llmProxy = startLLMProxy(registry);
  }
  const workerPool = new WorkerPoolImpl({
    registry,
    engineRegistry: engineRegistry ?? config.engineRegistry,
    workspace,
    useSubprocess: config.useSubprocess ?? true, // A1/A6: subprocess isolation by default
    proxySocketPath: llmProxy?.socketPath,
    bus,
    streaming: streamingAssistantDelta,
    runtimeStateManager: ecosystemBundle?.runtime,
  });
  const oracleGate = config.oracleGate ?? new OracleGateAdapter(workspace);
  const traceCollector = new TraceCollectorImpl(worldGraph, traceStore, bus);
  if (costLedger) {
    traceCollector.setEconomyDeps(costLedger, economyConfig?.rate_cards, bus);
  }
  const toolExecutor = new ToolExecutor(undefined, config.commandApprovalGate);

  // W2: optional plugin subsystem. Gated on `config.plugins.enabled` — OFF
  // by default so existing callers (and all existing tests) see a bit-for-
  // bit identical orchestrator shape. When ON, this kicks off an async
  // init that builds the PluginRegistry, registers DefaultMemoryProvider,
  // adds the three SKILL.md tools, runs external plugin discovery, and
  // builds the messaging-adapter lifecycle manager. The init promise is
  // surfaced as `orchestrator.pluginsReady`. Failures bubble up as
  // `pluginWarnings` — the host remains bootable either way.
  let pluginRegistry: PluginRegistry | undefined;
  let messagingLifecycle: MessagingAdapterLifecycleManager | undefined;
  let pluginWarnings: readonly string[] = [];
  let pluginsReady: Promise<PluginInitResult> | undefined;
  // W3 H3: NL-cron runner. Constructed once plugins resolve (needs lifecycle
  // for reply routing). Fires scheduled tasks through the same executeTask
  // converger — governance stays identical (A3).
  let scheduleRunnerHandle: ScheduleRunnerHandle | undefined;
  // Deferred executeTask holder — the gateway dispatcher needs a closure that
  // reaches the orchestrator's `executeTask`, but the orchestrator object
  // isn't built until much later in this function. We close over a mutable
  // slot and fill it synchronously immediately after the orchestrator is
  // constructed (before any adapter's `startAll()` can fire). A dispatch
  // arriving before wiring completes throws — a bug, not a race, so loud is
  // correct.
  let orchestratorExecuteTask: ((input: TaskInput) => Promise<TaskResult>) | null = null;
  const deferredExecuteTask = async (input: TaskInput): Promise<TaskResult> => {
    if (!orchestratorExecuteTask) {
      throw new Error('gateway dispatcher invoked executeTask before orchestrator ready');
    }
    return orchestratorExecuteTask(input);
  };
  try {
    const vinyanConfigForPlugins = loadConfig(workspace);
    const pluginsCfg = vinyanConfigForPlugins.plugins;
    if (pluginsCfg?.enabled && db) {
      // Tool registry view — the Map is mutated by registerSkillTools inside
      // plugin-init; once init resolves we forward the entries into the live
      // ToolExecutor so `executeProposedTools` can dispatch them.
      const pluginToolRegistry = new Map<string, Tool>();
      const vinyanHome = process.env['VINYAN_HOME'] ?? join(process.env['HOME'] ?? workspace, '.vinyan');
      pluginsReady = initializePlugins({
        db: db.getDb(),
        profile: 'default',
        bus,
        toolRegistry: pluginToolRegistry,
        pluginConfig: pluginsCfg,
        gatewayConfig: vinyanConfigForPlugins.gateway,
        executeTask: deferredExecuteTask,
        vinyanHome,
        profileRoot: workspace,
      })
        .then((result) => {
          pluginRegistry = result.registry;
          messagingLifecycle = result.lifecycle;
          pluginWarnings = result.warnings;
          for (const [name, tool] of pluginToolRegistry) {
            toolExecutor.registerTool(name, tool);
          }
          return result;
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          pluginWarnings = [`plugin init failed: ${msg}`];
          throw err;
        });
    }
  } catch {
    /* plugin wiring is best-effort */
  }

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
      // Wave 5 observability: pass the bus so the router can emit
      // `critic:debate_fired` when the debate path is chosen. Dashboards
      // and Economy OS use this to track debate spending separately.
      //
      // Wave 5.7a: also wire a per-task DebateBudgetGuard (default
      // maxPerTask: 1). If a task's inner retry loop would fire the
      // debate more than once, the guard denies the second+ attempts
      // and falls through to the baseline critic. The cap is a
      // conservative default that prevents runaway Opus×3 spend on a
      // single task. Operators that want a different cap can override
      // via config.debateMaxPerTask.
      const budgetGuard = new DebateBudgetGuard({
        maxPerTask: config.debateMaxPerTask ?? 1,
        ...(config.debateMaxPerDay !== undefined ? { maxPerDay: config.debateMaxPerDay } : {}),
        ...(bus ? { bus } : {}),
      });
      criticEngine = new DebateRouterCritic(baselineCritic, debateCritic, {
        bus,
        budgetGuard,
      });
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
  let capabilityModel: CapabilityModel | undefined;
  if (workerStore && db) {
    capabilityModel = new CapabilityModel({
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
      // Unified profile: read-only view for probation-aware exploration.
      fleetRegistry,
    });
  }

  // Agent Context Layer + Living Agent Soul: create builder, updater, evolution, and soul components.
  // Hoisted out of the `if (agentContextStore)` block so agentLoopDeps (built
  // later) can reference them — subprocess agent dispatch needs the same
  // registries the in-process path uses to inject persona.
  let agentContextUpdater: AgentContextUpdater | undefined;
  let agentContextBuilder: AgentContextBuilder | undefined;
  let soulStore: SoulStore | undefined;
  if (agentContextStore) {
    // Create the soul store FIRST so context-builder can read from it.
    // Narrative sections (persona, antiPatterns, etc.) are sourced from
    // soul.md after migration 041 — soul is the authoritative home.
    soulStore = new SoulStore(workspace);

    agentContextBuilder = new AgentContextBuilder({
      agentContextStore,
      capabilityModel,
      db: db?.getDb(),
      soulStore,
    });
    workerPool.setAgentContextBuilder(agentContextBuilder);
    workerPool.setSoulStore(soulStore);

    // Soul reflector uses tool-uses tier (cheap: haiku ~$0.001/call) for reflection
    const reflectionProvider = registry.selectByTier('tool-uses');
    const soulReflector = reflectionProvider
      ? new SoulReflector({ provider: reflectionProvider, soulStore, agentContextStore })
      : undefined;

    agentContextUpdater = new AgentContextUpdater({
      agentContextStore,
      capabilityModel,
      soulReflector,
    });

    const agentEvolution = new AgentEvolution({
      agentContextStore,
      capabilityModel,
      soulReflector,
      soulStore,
      db: db?.getDb(),
    });

    // Wire agent evolution into sleep cycle runner
    if (sleepCycleRunner) {
      sleepCycleRunner.setAgentEvolution(agentEvolution);
    }
  }

  // Phase 5: Instance Coordinator (PH5.8) — cross-instance task delegation
  let instanceCoordinator: InstanceCoordinator | undefined;
  let federationBudgetPool: FederationBudgetPool | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    const instancesConfig = vinyanConfig.network?.instances;
    if (instancesConfig?.enabled && instancesConfig.peers?.length) {
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
  let predictionLedger: PredictionLedger | undefined;
  try {
    const vinyanConfig = loadConfig(workspace);
    const fpConfig = vinyanConfig.orchestrator?.forward_predictor;
    if (fpConfig?.enabled && db) {
      migratePredictionLedgerSchema(db.getDb());
      predictionLedger = new PredictionLedger(db.getDb());
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

  // Monitoring — Self-Improving Autonomy modules. Pure in-memory observers
  // that watch each trace and emit `monitoring:*` events. They never block
  // the pipeline — Phase Learn calls them in best-effort try/catch.
  // Drift detection is stateless and does not need a dep — it's invoked
  // inline in Phase Learn.
  const oracleEMACalibrator = new OracleEMACalibrator({ bus });
  // Single-shot gate wiring — consolidates accuracy store, EMA calibrator,
  // bus, and local-oracle profile store into one module-level injection.
  setGateDeps({
    oracleAccuracyStore,
    oracleEMACalibrator,
    bus,
    localOracleProfileStore,
  });
  const regressionMonitor = new RegressionMonitor({ bus });

  // Update AgentProfile declared capabilities now that all components are wired.
  // Advertised to peers via A2A agent card.
  if (agentProfileStore) {
    try {
      // Oracle names come from the loaded vinyan config (the enabled oracles)
      const cfg = loadConfig(workspace);
      const oracleNames = Object.entries(cfg.oracles ?? {})
        .filter(([, o]) => (o as { enabled?: boolean }).enabled !== false)
        .map(([name]) => name);
      const engineIds = (config.engineRegistry ?? engineRegistry)?.listEngines()?.map((e) => e.id) ?? [];
      const mcpServerIds = mcpClientPool?.listServers() ?? [];
      const caps = collectDeclaredCapabilities({ oracleNames, engineIds, mcpServerIds });
      agentProfileStore.updateCapabilities(caps);
      // Refresh in-memory reference to include capabilities
      if (agentProfile) agentProfile = agentProfileStore.get() ?? agentProfile;
    } catch (err) {
      console.warn('[vinyan] AgentProfile capability update failed:', err);
    }
  }

  // Multi-agent: load specialist registry (vinyan.json agents[] + built-in defaults
  // + Round F: `.claude/agents/<id>/AGENT.md` markdown loader for Claude Code
  // drop-in compat). vinyan.json wins on id conflict — markdown loader merges
  // first, then config agents override.
  let agentRegistry: ReturnType<typeof loadAgentRegistry> | undefined;
  try {
    const vinyanCfg = loadConfig(workspace);
    const mdScan = scanAgentMarkdown(workspace);
    const mergedConfigs: AgentSpecConfig[] = [...mdScan.entries.map((e) => e.config), ...(vinyanCfg.agents ?? [])];
    agentRegistry = loadAgentRegistry(workspace, mergedConfigs, soulsByIdFrom(mdScan.entries));
    if (mdScan.entries.length > 0) {
      console.log(`[vinyan] Agent registry: ${mdScan.entries.length} agent(s) loaded from .claude/agents/`);
    }
  } catch (err) {
    console.warn('[vinyan] Agent registry load failed, using built-in defaults:', err);
    agentRegistry = loadAgentRegistry(workspace, undefined);
  }
  // Thread registry into WorkerPool so dispatch can resolve agentProfile + peers
  if (agentRegistry) workerPool.setAgentRegistry(agentRegistry);

  // Phase 2: rule-first AgentRouter — pre-routes tasks to specialists deterministically.
  // Constructed alongside the registry so it sees the same roster.
  const agentRouter = agentRegistry ? createAgentRouter({ registry: agentRegistry }) : undefined;

  // User-interest miner — live aggregation from traces + session messages.
  // Noop when traceStore is missing; session-message keywords require SessionManager.
  const userInterestMiner = traceStore
    ? new UserInterestMiner({
        traceStore,
        sessionStore: config.sessionManager?.getSessionStore(),
      })
    : undefined;

  // GAP#1 — instantiate comprehension calibrator + LLM stage-2 engine
  // BEFORE `deps` construction so both can be injected.
  // Without these, the P2.C hybrid pipeline in core-loop is unreachable
  // (deps.llmComprehensionEngine stays undefined → stage 2 never runs).
  const comprehensionCalibrator = comprehensionStore ? new ComprehensionCalibrator(comprehensionStore) : undefined;
  // Wire comprehension substrate into SleepCycleRunner for offline mining
  // (B1 engine-fit + label-drift, B2 stage-agreement, B3 attribution).
  // Substrate is optional — if either piece is missing, the mining step
  // in the cycle silently no-ops.
  if (sleepCycleRunner && comprehensionStore && comprehensionCalibrator) {
    sleepCycleRunner.setComprehensionSubstrate(comprehensionStore, comprehensionCalibrator);
  }
  let llmComprehensionEngine: import('./comprehension/types.ts').ComprehensionEngine | undefined;
  try {
    const llmProvider =
      registry.selectByTier('balanced') ?? registry.selectByTier('fast') ?? registry.selectByTier('powerful');
    if (llmProvider && comprehensionCalibrator) {
      llmComprehensionEngine = newLlmComprehender({
        provider: llmProvider,
        calibrator: comprehensionCalibrator,
        bus,
      });
    }
  } catch {
    // Any failure leaves stage 2 unregistered; stage 1 keeps working.
  }

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
    fleetRegistry,
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
    // A7 learning loop — comprehension calibration persistence
    comprehensionStore,
    // P2.C stage-2 engine — hybrid pipeline only activates when present
    llmComprehensionEngine,
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
    // User preference learning for app/tool resolution (A7)
    userPreferenceStore,
    // User-interest miner — aggregates traces (and session messages when
    // available) so the intent resolver can reason against real past activity.
    userInterestMiner,
    // Workflow approval gating config — passed to workflow-executor so it
    // can pause for user approval when configured.
    workflowConfig,
    // Monitoring — Self-Improving Autonomy: per-engine EMA calibration +
    // silent-regression watchdog. Phase Learn updates both on every
    // trace; dashboards subscribe to `monitoring:*` events. Drift detection
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
          // Book-integration Wave 4.2: role-hint → tier preference.
          // The registry already stores each provider's declared tier,
          // so the selector's roleHint logic can pick Haiku/Sonnet/Opus
          // through this lookup without duplicating tier metadata.
          getProviderTier: (id: string) => {
            for (const p of registry.listProviders()) {
              if (p.id === id) return p.tier;
            }
            return undefined;
          },
          // Ecosystem O1 + O3 — when the ecosystem is enabled, the selector
          // pre-filters by runtime state and department membership.
          runtimeStateManager: ecosystemConfig?.runtime_gate_selection !== false ? ecosystemBundle?.runtime : undefined,
          departmentIndex: ecosystemBundle?.departments,
          // Ecosystem O4 — volunteer fallback invoked only when market + wilson-LB
          // fail to produce a trusted pick. Scoring context comes from the trust
          // store (trust), runtime FSM (load), and a default capability baseline.
          volunteerFallback:
            ecosystemBundle && providerTrustStore
              ? ({ taskId, departmentId }) => {
                  const bundle = ecosystemBundle!;
                  const ts = providerTrustStore!;
                  const ctx = (id: string) => {
                    const rec = ts.getProvider(id);
                    const total = (rec?.successes ?? 0) + (rec?.failures ?? 0);
                    const trust = total > 0 ? rec!.successes / total : 0.5;
                    const load = bundle.runtime.get(id)?.activeTaskCount ?? 0;
                    return { capability: 0.5, trust, currentLoad: load };
                  };
                  // Prefer the real task facts (registered by executeTask) so
                  // the volunteer fallback's commitment matches the
                  // commitment-bridge view. Fall back to a synthetic goal /
                  // deadline only when facts are absent (legacy / out-of-band
                  // entry paths).
                  const facts = taskFactsRegistry.resolve(taskId);
                  const deadlineMs = ecosystemConfig?.volunteer_fallback_deadline_ms ?? 600_000;
                  const res = bundle.coordinator.attemptVolunteerFallback({
                    taskId,
                    goal: facts?.goal ?? `fallback:${taskId}`,
                    deadlineAt: facts?.deadlineAt ?? Date.now() + deadlineMs,
                    ...(departmentId ? { departmentId } : {}),
                    contextProvider: ctx,
                  });
                  return res?.engineId ?? null;
                }
              : undefined,
        })
      : undefined,
    // Extensible Thinking — 2D routing grid compiler (Phase 2.1)
    thinkingPolicyCompiler: extensibleThinkingEnabled
      ? new DefaultThinkingPolicyCompiler(extensibleThinkingConfig)
      : undefined,
    // Wave 1: Goal-Satisfaction Outer Loop — evaluator is instantiated only
    // when goalLoop is enabled in config; the wrapper in executeTask uses
    // this as the on/off signal (presence implies active).
    goalEvaluator: goalLoopConfig?.enabled ? new DefaultGoalEvaluator() : undefined,
    goalLoop: goalLoopConfig,
    // Wave 3: Agent-Facing Memory API ("second brain") — read-only queries
    // over WorldGraph / Trace / Skill / Rule / RejectedApproach stores with
    // per-task LRU caching. Additive; on by default.
    agentMemory: agentMemoryEnabled
      ? new AgentMemoryAPIImpl({
          worldGraph,
          skillStore,
          traceStore,
          ruleStore,
          rejectedApproachStore,
          selfModel,
        })
      : undefined,
    // Ecosystem: dispatch-scoped task facts so CommitmentBridge can resolve
    // goal/targetFiles/deadlineAt synchronously when an auction completes.
    taskFactsRegistry,
    // Wave 2: Replan Engine — only active when both goalLoop and replan are
    // enabled. Self-assembles L1 perception so outer-loop doesn't need routing.
    replanEngine:
      goalLoopConfig?.enabled && replanConfig?.enabled
        ? new DefaultReplanEngine(
            { decomposer, perception, bus, failurePatternLibrary: buildFailurePatternLibrary() },
            replanConfig,
          )
        : undefined,
    replanConfig,
    // Wave 6: Workflow registry — always instantiated with the 4 built-in
    // strategies. Additive and metadata-only; the core-loop uses it as a
    // strategy validator (unknown → fallback) without changing dispatch.
    workflowRegistry: new WorkflowRegistry(),
    // Agent Context Layer: post-task learning for persistent identity/memory/skills
    agentContextUpdater,
    // AgentProfile — workspace-level Vinyan Agent identity (singleton)
    agentProfile,
    agentProfileStore,
    // Specialist agent registry — ts-coder, writer, secretary, etc.
    agentRegistry,
    // Multi-agent: SOUL.md store — used by conversational short-circuit
    // to inject the same evolved persona that worker-pool injects in
    // full-pipeline. Optional; falls back to inline `agent.soul` when absent.
    soulStore,
    // Phase 2: rule-first specialist router (skips LLM when rule-match fires)
    agentRouter,
    // Phase 2: gate for token-level `agent:text_delta` emission in the
    // conversational short-circuit path of the core loop.
    streamingAssistantDelta,
  };

  // K2.3: Wire concurrent dispatcher (needs executeTask thunk, so done after deps)
  const k2TaskQueue = createTaskQueue({ maxConcurrent: 5 });
  const executeTaskThunk = (subInput: TaskInput) => executeTask(subInput, deps);
  deps.concurrentDispatcher = new DefaultConcurrentDispatcher({
    taskQueue: k2TaskQueue,
    executeTask: executeTaskThunk,
    bus,
  });

  // ACR: Wire RoomDispatcher. The `resolveParticipant` callback queries the
  // local workerStore for distinct-model candidates; when the fleet has fewer
  // than 2 distinct modelIds active, it returns null, phase-generate catches
  // RoomAdmissionFailure, and the dispatch falls through to the existing
  // agentic-loop branch — a safe, additive degrade path.
  const roomStore = db ? new RoomStore(db.getDb()) : undefined;
  deps.roomDispatcher = new RoomDispatcher({
    runAgentLoop,
    resolveParticipant: async ({ usedModelIds }) => {
      if (!workerStore) return null;
      const candidates = workerStore.findActive();
      const available = candidates.find((w) => !usedModelIds.has(w.config.modelId));
      if (!available) return null;
      return { workerId: available.id, workerModelId: available.config.modelId };
    },
    workspace,
    bus,
    goalVerifier: goalAlignmentVerify,
    roomStore,
    // Ecosystem O3 — rooms with `contract.teamId` round-trip their shared
    // keys through the team's persistent blackboard. Enabled automatically
    // when the ecosystem is wired; rooms without a teamId are unaffected.
    ...(ecosystemBundle ? { teamManager: ecosystemBundle.teams } : {}),
  });

  // Wave A: Error Attribution Bus — consumes orphaned learning signals and
  // routes them into corrective actions. Subscribes to selfmodel:systematic_miscalibration,
  // prediction:miscalibrated, and hms:risk_scored bus events. A3: all logic is
  // threshold comparisons + method dispatch.
  {
    const errorAttribution = new ErrorAttributionBus({
      bus,
      onSelfModelReset: (taskSig, forceMinLevel) => {
        console.log(`[vinyan] ErrorAttribution: SelfModel reset for '${taskSig}', forceMinLevel=${forceMinLevel}`);
      },
      onPredictionRecalibrate: (taskId, brierScore) => {
        console.log(`[vinyan] ErrorAttribution: prediction recalibrate for ${taskId}, brier=${brierScore.toFixed(3)}`);
      },
      onHMSFailureInject: (taskId, riskScore, signal) => {
        console.log(
          `[vinyan] ErrorAttribution: HMS failure inject for ${taskId}, risk=${riskScore.toFixed(2)}, signal=${signal}`,
        );
      },
    });
    errorAttribution.start();
    deps.errorAttributionBus = errorAttribution;
  }

  // Wave B: Decomposition Learner — records winning DAG shapes after successful
  // outer-loop iterations for future seed retrieval. Gated on patternStore.
  if (patternStore) {
    deps.decompositionLearner = new DecompositionLearner({ patternStore });
  }

  // Wave 5a: Reactive micro-learning — close the failure-cluster → rule loop.
  // Subscribes to `task:complete` (feeds detector) and `failure:cluster-detected`
  // (synthesizes + persists probational rule). Gated OFF by default; when
  // disabled, NO listeners are attached so there's zero runtime cost.
  if (reactiveLearningConfig?.enabled && ruleStore && traceStore) {
    const detector = new FailureClusterDetector(reactiveLearningConfig, bus);

    bus.on('task:complete', ({ result }) => {
      // `input-required` is a pause for clarification, not a terminal failure.
      if (result.status === 'input-required') return;
      const sig = result.trace?.taskTypeSignature;
      if (!sig) return;
      detector.observe({
        taskSignature: sig,
        outcome: result.status === 'completed' ? 'success' : 'failure',
        timestamp: Date.now(),
        taskId: result.id,
      });
    });

    bus.on('failure:cluster-detected', (payload) => {
      try {
        const traces = traceStore!.findByTaskType(payload.taskSignature, 20);
        const summaries = traces.map(traceToReactiveSummary).filter((s): s is ReactiveTraceSummary => s !== null);
        if (summaries.length < 2) {
          bus.emit('reactive:rule-skipped', {
            taskSignature: payload.taskSignature,
            reason: 'insufficient-failure-summaries',
          });
          return;
        }
        const cluster: FailureCluster = {
          taskSignature: payload.taskSignature,
          failureCount: payload.failureCount,
          taskIds: payload.taskIds,
          windowStart: 0,
          windowEnd: Date.now(),
        };
        const proposed = synthesizeReactiveRule(cluster, summaries);
        if (!proposed) {
          bus.emit('reactive:rule-skipped', {
            taskSignature: payload.taskSignature,
            reason: 'no-actionable-pattern',
          });
          return;
        }
        const evolutionary = reactiveRuleToEvolutionary(proposed);
        ruleStore!.insert(evolutionary);
        bus.emit('reactive:rule-generated', {
          ruleId: evolutionary.id,
          taskSignature: payload.taskSignature,
          action: evolutionary.action,
          specificity: evolutionary.specificity,
        });
      } catch (err) {
        bus.emit('reactive:rule-skipped', {
          taskSignature: payload.taskSignature,
          reason: `error:${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

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
    agentWorkerEntryPath: resolve(import.meta.dir, 'agent/agent-worker-entry.ts'),
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
    // Wave 5b: surface skill hints in the worker's init turn constraints.
    // Best-effort read of `deps.agentMemory` — when agentMemory is undefined
    // (config opt-out), the agent loop's guard short-circuits the query.
    agentMemory: deps.agentMemory,
    skillHintsConfig,
    // Wave 4: goal-check hook in agent-loop done path. Reuses Wave 1's
    // evaluator so both levels agree on scoring semantics. Gated off by
    // default via agentLoopGoalTermination config.
    goalEvaluator: deps.goalEvaluator,
    goalTerminationConfig: agentLoopGoalTerminationConfig,
    // Phase 2 realtime streaming (gated by vinyan.json → streaming.assistantDelta).
    streamingAssistantDelta,
    // Multi-agent: specialist registry + SOUL + episodic context all flow
    // through the init turn so subprocess workers see the same persona that
    // the in-process path injects. Absent registries => legacy behaviour.
    ...(agentRegistry ? { agentRegistry } : {}),
    ...(soulStore ? { soulStore } : {}),
    ...(agentContextBuilder ? { agentContextBuilder } : {}),
  };
  workerPool.setAgentLoopDeps(agentLoopDeps as AgentLoopDeps);

  // Wire bus listeners (read-only observers — A3 compliance)
  const metricsCollector = new MetricsCollector();
  const detachMetrics = metricsCollector.attach(bus);
  const traceListenerHandle = attachTraceListener(bus, { workerStore });
  // P3.B — records adaptive-behavior comprehension events
  // (calibrated, calibration_diverged, ceiling_adjusted) + AXM#7 Brier
  // miscalibration emission. Uses the calibrator wired above.
  const comprehensionTraceHandle = attachComprehensionTraceListener({
    bus,
    traceCollector,
    calibrator: comprehensionCalibrator,
  });

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
    // unref() so this timer alone does not hold the process alive when
    // the API server shuts down. close() also clears it explicitly.
    (shadowInterval as { unref?: () => void }).unref?.();
  }

  const orchestrator: Orchestrator = {
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
    localOracleProfileStore,
    localOracleLifecycle,
    fleetRegistry,
    // Exposed stores for API server wiring (G7)
    traceStore,
    ruleStore,
    skillStore,
    patternStore,
    shadowStore,
    workerStore,
    agentProfileStore,
    agentProfile,
    agentContextStore,
    agentRegistry,
    mcpClientPool,
    oracleAccuracyStore,
    predictionLedger,
    providerTrustStore,
    federationBudgetPool,
    marketScheduler,
    capabilityModel,
    worldGraph,
    metricsCollector,
    approvalGate,
    costLedger,
    budgetEnforcer,
    // W2: optional plugin subsystem — populated when
    // `config.plugins.enabled` is true. pluginRegistry / messagingLifecycle
    // / pluginWarnings are filled in asynchronously by the init promise,
    // so consumers must `await pluginsReady` before reading them. Getters
    // read the closure variables to surface the latest state without the
    // factory needing to rebuild its return object.
    ...(pluginsReady ? { pluginsReady } : {}),
    getSessionCount: () => sessionCount,
    close: async () => {
      // Order matters:
      //   1. Stop event sources (interval, bus listeners) so new work
      //      cannot arrive while we tear down stores.
      //   2. Kill subprocesses (warm workers, MCP) to release their
      //      stdin/stdout fds before anything that depends on stable
      //      file descriptors.
      //   3. Await file-watcher close (chokidar holds fs.watch fds)
      //      BEFORE db.close() — otherwise chokidar can fire events
      //      into a closed DB and the chokidar worker thread may
      //      briefly outlive us.
      //   4. Close LLM proxy, world graph, DB — in increasing order
      //      of "holds file locks for long time".
      if (shadowInterval) clearInterval(shadowInterval);
      detachGapH();
      detachMetrics();
      traceListenerHandle.detach();
      comprehensionTraceHandle.detach();
      detachAudit();
      detachAccuracy?.();
      approvalGate.clear();

      // Kill warm worker subprocesses FIRST — without this, their stdin
      // pipes hold file descriptors that keep the parent event loop
      // alive past shutdown, and the subprocesses themselves can
      // outlive the parent in some shells.
      try {
        workerPool.shutdown();
      } catch {
        /* best-effort */
      }
      // W3 H3 cron — stop ScheduleRunner BEFORE the lifecycle so a tick
      // that's already in flight gets the lifecycle it was built with.
      if (scheduleRunnerHandle) {
        try {
          scheduleRunnerHandle.stop();
        } catch {
          /* best-effort */
        }
      }
      // W2 messaging adapters — stop before we tear down anything the
      // adapter callbacks might reach (bus is still alive at this point,
      // but adapters may own their own fds/sockets).
      if (messagingLifecycle) {
        try {
          await raceTimeout(
            messagingLifecycle.stopAll().then(() => undefined),
            2_000,
          );
        } catch {
          /* best-effort */
        }
      }
      // Gateway dispatcher — unsubscribe from the bus. `stopAll` already
      // stopped adapter polling; the dispatcher's own bus handler still
      // needs explicit teardown so a late `bus.emit` doesn't fire through
      // a half-torn-down dispatcher.
      if (pluginsReady) {
        try {
          const bounded = Promise.race<PluginInitResult | undefined>([
            pluginsReady,
            new Promise<undefined>((resolve) => {
              const t = setTimeout(() => resolve(undefined), 1_000);
              (t as { unref?: () => void }).unref?.();
            }),
          ]).catch(() => undefined);
          const initResult = await bounded;
          initResult?.dispatcher?.stop();
        } catch {
          /* best-effort */
        }
      }
      // MCP client pool — subprocess-based. shutdown() is async but we
      // bound the wait so a misbehaving MCP server cannot strand us.
      if (mcpClientPool) {
        try {
          await raceTimeout(mcpClientPool.shutdown(), 2_000);
        } catch {
          /* best-effort */
        }
      }
      // Chokidar file watcher — releases fs.watch fds. Await so these
      // fds are closed before the event loop tries to exit.
      if (fileWatcher) {
        try {
          await raceTimeout(fileWatcher.stop(), 1_000);
        } catch {
          /* best-effort */
        }
      }
      try {
        llmProxy?.close();
      } catch {
        /* best-effort */
      }
      try {
        worldGraph?.close();
      } catch {
        /* best-effort */
      }
      // Only close the db if we opened it. Injected handles belong to the caller
      // and may still be in use (e.g. serve.ts's sessionManager needs it for
      // suspendAll() after orchestrator.close()).
      if (ownsDb) {
        try {
          db?.close();
        } catch {
          /* best-effort */
        }
      }
    },
  };

  // W2 plugin subsystem — expose pluginRegistry / messagingLifecycle /
  // pluginWarnings as live getters so consumers see the latest state once
  // the async `pluginsReady` resolves. Defined here (after the object is
  // built) to avoid spread-losing-getter semantics. When the flag is off,
  // `pluginsReady` is undefined and these getters are not installed — the
  // orchestrator shape stays byte-for-byte identical to the pre-wiring
  // version.
  if (pluginsReady) {
    Object.defineProperty(orchestrator, 'pluginRegistry', {
      enumerable: true,
      configurable: true,
      get: () => pluginRegistry,
    });
    Object.defineProperty(orchestrator, 'messagingLifecycle', {
      enumerable: true,
      configurable: true,
      get: () => messagingLifecycle,
    });
    Object.defineProperty(orchestrator, 'pluginWarnings', {
      enumerable: true,
      configurable: true,
      get: () => pluginWarnings,
    });
  }

  // W2 task #18: fulfill the deferred `executeTask` closure the gateway
  // dispatcher holds. This MUST happen before `startAll()` — the dispatcher
  // bus subscription is live the moment the adapter publishes its first
  // envelope. We bounce through `orchestrator.executeTask` at call time
  // rather than capturing a bound reference so tests can override
  // `orchestrator.executeTask` post-construction (the default wrapper
  // invokes core-loop's `executeTask` plus sleep-cycle tracking).
  orchestratorExecuteTask = (input: TaskInput) => orchestrator.executeTask(input);

  // W2 task #18: kick off messaging-adapter startup once plugins finish
  // initialising. Adapters poll asynchronously; the factory returns
  // promptly so synchronous consumers aren't blocked. Start failures are
  // logged but never fatal — the orchestrator stays bootable even if
  // Telegram's auth fails.
  if (pluginsReady) {
    void pluginsReady
      .then(async (result) => {
        if (result.lifecycle) {
          const startReport = await result.lifecycle.startAll();
          for (const failure of startReport.failed) {
            console.warn('[gateway] adapter failed to start', failure);
          }
        }
        // Dispatcher.start() is already invoked inside initializePlugins;
        // no additional wiring needed here.

        // W3 H3: construct + start the NL-cron runner. Needs the same
        // `deferredExecuteTask` closure the dispatcher holds, plus the
        // messaging lifecycle for reply routing and the market scheduler
        // for a single-tick-source clock (A3). Adapter-less (CLI-only)
        // deployments still get cron: origin=cli schedules just log.
        if (db) {
          try {
            scheduleRunnerHandle = setupScheduleRunner({
              db: db.getDb(),
              executeTask: deferredExecuteTask,
              lifecycle: result.lifecycle,
              marketScheduler,
              log: (level, msg, meta) => {
                if (level === 'error') console.error(`[gateway-cron] ${msg}`, meta ?? '');
                else if (level === 'warn') console.warn(`[gateway-cron] ${msg}`, meta ?? '');
                else console.log(`[gateway-cron] ${msg}`, meta ?? '');
              },
            });
            scheduleRunnerHandle.start();
          } catch (err) {
            console.warn('[gateway-cron] setup failed', err);
          }
        }
      })
      .catch((err) => {
        console.error('[gateway] startup failed', err);
      });
  }

  // W3 P3: wire the USER.md dialectic observer into SessionManager if one
  // is injected. Every user turn gets compared to each section's
  // predicted_response; deltas ledger into `user_md_prediction_errors` and
  // the Sleep Cycle (P5) or a manual trigger runs `applyDialectic` later.
  // Always-on when sessionManager is present — sections-empty case is a
  // no-op.
  if (deps.sessionManager && db) {
    try {
      const { observer } = setupUserMdObserver({
        db: db.getDb(),
        profile: 'default',
      });
      deps.sessionManager.setUserMdObserver(observer);
    } catch (err) {
      console.warn('[user-md] observer setup failed', err);
    }
  }

  return orchestrator;
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
 *
 * Policy (A7 compliance — earn trust from evidence):
 *   'earn' (default): newcomers register as `probation`. If the DB already has
 *                    ≥ probationMinTasks traces for a provider, that provider
 *                    is grandfathered to `active` (evidence-backed).
 *   'grandfather':    all newcomers register as `active` (legacy behavior).
 *
 * Also registers non-LLM engines from engineRegistry so fleet governance
 * (WorkerLifecycle, WorkerSelector, CapabilityModel) can track them.
 */
/**
 * Bootstrap THE Vinyan Agent identity (workspace singleton).
 *
 * On first call per workspace: inserts default row with instance UUID,
 * display name, and VINYAN.md link. On subsequent calls: merges
 * `vinyan.json` agent.preferences into the DB (config-first precedence).
 */
function bootstrapAgentProfile(store: AgentProfileStore, workspace: string, config: OrchestratorConfig): AgentProfile {
  const instanceId = resolveInstanceId(workspace);

  // Read VINYAN.md path + hash if present (non-fatal if missing)
  let vinyanMdPath: string | undefined;
  let vinyanMdHash: string | undefined;
  try {
    const mem = loadInstructionMemory(workspace);
    if (mem) {
      vinyanMdPath = mem.filePath;
      // mem.contentHash is already SHA-256 of merged content
      vinyanMdHash = `sha256:${mem.contentHash}`;
    }
  } catch {
    /* no VINYAN.md — skip link */
  }

  // Pull config overrides
  let configAgent:
    | {
        display_name?: string;
        description?: string;
        preferences?: {
          approval_mode?: AgentPreferences['approvalMode'];
          verbosity?: AgentPreferences['verbosity'];
          default_thinking_level?: AgentPreferences['defaultThinkingLevel'];
          language?: AgentPreferences['language'];
        };
      }
    | undefined;
  try {
    const loaded = loadConfig(workspace);
    configAgent = (loaded as { agent?: typeof configAgent }).agent;
  } catch {
    /* no config → defaults */
  }

  // First-bootstrap or idempotent load
  store.loadOrCreate({
    instanceId,
    workspace,
    displayNameOverride: configAgent?.display_name,
    descriptionOverride: configAgent?.description,
    vinyanMdPath,
    vinyanMdHash,
  });

  // Apply config preferences on every boot (source-of-truth is the config file
  // when present; DB is a fallback for runtime-mutable state).
  const cp = configAgent?.preferences;
  if (cp) {
    const partial: Partial<AgentPreferences> = {};
    if (cp.approval_mode) partial.approvalMode = cp.approval_mode;
    if (cp.verbosity) partial.verbosity = cp.verbosity;
    if (cp.default_thinking_level) partial.defaultThinkingLevel = cp.default_thinking_level;
    if (cp.language) partial.language = cp.language;
    if (Object.keys(partial).length > 0) store.updatePreferences(partial);
  }

  // Refresh VINYAN.md link on every boot (path may have changed)
  store.updateVinyanMdLink(vinyanMdPath ?? null, vinyanMdHash ?? null);

  return store.get()!;
}

/**
 * Collect declared capabilities for A2A advertisement:
 *   - oracle names (from oracleGate)
 *   - engine IDs (from registry)
 *   - MCP server identifiers (from mcpClientPool)
 * Called from the factory after all components are wired.
 */
function collectDeclaredCapabilities(deps: {
  oracleNames?: string[];
  engineIds?: string[];
  mcpServerIds?: string[];
}): string[] {
  const caps: string[] = [];
  for (const name of deps.oracleNames ?? []) caps.push(`oracle:${name}`);
  for (const id of deps.engineIds ?? []) caps.push(`engine:${id}`);
  for (const id of deps.mcpServerIds ?? []) caps.push(`mcp:${id}`);
  return caps;
}

function autoRegisterWorkers(
  registry: LLMProviderRegistry,
  workerStore: WorkerStore,
  bus: VinyanBus,
  allowlist: string[] = DEFAULT_WORKER_MODEL_ALLOWLIST,
  engineRegistry?: ReasoningEngineRegistry,
  policy: 'earn' | 'grandfather' = 'earn',
  probationMinTasks = 30,
): void {
  const resolveBootstrapStatus = (workerId: string): 'active' | 'probation' => {
    if (policy === 'grandfather') return 'active';
    // Earn policy: grandfather only when DB has sufficient traces for this id.
    try {
      const stats = workerStore.getStats(workerId);
      return stats.totalTasks >= probationMinTasks ? 'active' : 'probation';
    } catch {
      return 'probation';
    }
  };
  // Register LLM providers from the legacy registry
  for (const provider of registry.listProviders()) {
    // tool-uses tier is a utility tier (intent resolver, remediation) — not a general worker
    if (provider.tier === 'tool-uses') {
      // Clean up any stale worker profile from prior sessions
      const staleId = `worker-${provider.id}`;
      const stale = workerStore.findById(staleId);
      if (stale && stale.status !== 'demoted') {
        workerStore.updateStatus(staleId, 'demoted', 'tool-uses tier excluded from worker pool');
      }
      continue;
    }

    // M12: Validate engine against allowlist before registration. Empty allowlist = no filter.
    if (allowlist.length > 0 && !allowlist.some((p) => provider.id.startsWith(p))) {
      console.warn(`[vinyan] Skipping worker registration for '${provider.id}' — not in model allowlist`);
      continue;
    }

    const workerId = `worker-${provider.id}`;
    if (workerStore.findById(workerId)) continue;

    const profile: EngineProfile = {
      id: workerId,
      config: {
        modelId: provider.id,
        temperature: 0.7,
        systemPromptTemplate: 'default',
        maxContextTokens: provider.maxContextTokens,
      },
      status: resolveBootstrapStatus(workerId),
      createdAt: Date.now(),
      demotionCount: 0,
    };
    workerStore.insert(profile);
    bus.emit('profile:registered', { kind: 'worker', id: profile.id });
  }

  // Register non-LLM engines from engineRegistry (fleet governance visibility)
  if (engineRegistry) {
    for (const engine of engineRegistry.listEngines()) {
      if (engine.engineType === 'llm') continue; // already registered via LLMProviderRegistry above
      const workerId = `worker-${engine.id}`;
      if (workerStore.findById(workerId)) continue;

      const profile: EngineProfile = {
        id: workerId,
        config: {
          modelId: engine.id, // engine.id as model identifier for non-LLM REs
          temperature: 0, // not applicable for non-LLM
          systemPromptTemplate: 'none',
          maxContextTokens: engine.maxContextTokens,
          engineType: engine.engineType,
          capabilitiesDeclared: engine.capabilities,
        },
        status: resolveBootstrapStatus(workerId),
        createdAt: Date.now(),
        demotionCount: 0,
      };
      workerStore.insert(profile);
      bus.emit('profile:registered', { kind: 'worker', id: profile.id });
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

/**
 * Vinyan API Server — HTTP API accepting tasks, streaming progress.
 *
 * Uses Bun.serve() — zero dependency. Manual routing.
 * Graceful shutdown per TDD §22.7.
 *
 * Source of truth: spec/tdd.md §22
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServer = any;

import { z } from 'zod/v4';
import type { A2AManagerImpl } from '../a2a/a2a-manager.ts';
import { A2ABridge } from '../a2a/bridge.ts';
import type { VinyanBus } from '../core/bus.ts';
import type { RuleStore } from '../db/rule-store.ts';
import type { TraceStore } from '../db/trace-store.ts';
import type { WorkerStore } from '../db/worker-store.ts';
import type { MetricsCollector } from '../observability/metrics.ts';
import { getSystemMetrics } from '../observability/metrics.ts';
import { renderPrometheus } from '../observability/prometheus.ts';
import type { RunOracleOptions } from '../oracle/runner.ts';
import { engineIdFromWorker, workerIdForEngine } from '../orchestrator/llm/engine-worker-binding.ts';
import type { EngineProfile, EngineStats, ExecutionTrace, TaskInput, TaskResult } from '../orchestrator/types.ts';
import { isValidProfileName } from '../orchestrator/types.ts';
import { createAuthMiddleware, requiresAuth } from '../security/auth.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import { classifyEndpoint, RateLimiter } from './rate-limiter.ts';
import type { Session, SessionManager } from './session-manager.ts';
import { createSessionSSEStream, createSSEStream } from './sse.ts';

export interface APIServerConfig {
  port: number;
  bind: string;
  tokenPath: string;
  authRequired: boolean;
  rateLimitEnabled: boolean;
}

export interface APIServerDeps {
  bus: VinyanBus;
  executeTask: (input: TaskInput) => Promise<TaskResult>;
  sessionManager: SessionManager;
  traceStore?: TraceStore;
  /** Per-task durable event log for historical UI process replay (`/tasks/:id/events`). */
  taskEventStore?: import('../db/task-event-store.ts').TaskEventStore;
  ruleStore?: RuleStore;
  workerStore?: WorkerStore;
  /**
   * Live Reasoning Engine registry — source of truth for "engines available
   * right now". `/api/v1/workers` and `/api/v1/engines` merge this with
   * `workerStore` (historical) so the dashboard never shows an empty list
   * just because no task has run yet. Wired in `cli/serve.ts`.
   */
  engineRegistry?: import('../orchestrator/llm/llm-reasoning-engine.ts').ReasoningEngineRegistry;
  worldGraph?: WorldGraph;
  metricsCollector?: MetricsCollector;
  a2aManager?: A2AManagerImpl;
  /** Oracle runner for WebSocket ECP endpoint (PH5.18). */
  runOracle?: (oracleName: string, hypothesis: unknown, options?: RunOracleOptions) => Promise<unknown>;
  /** Economy stores for /api/v1/economy endpoint. */
  costLedger?: { getAggregatedCost(window: string): { total_usd: number; count: number }; count(): number };
  budgetEnforcer?: {
    checkBudget(): Array<{
      window: string;
      spent_usd: number;
      limit_usd: number;
      utilization_pct: number;
      enforcement: string;
      exceeded: boolean;
    }>;
  };
  /** Approval gate for high-risk task approval (A6). */
  approvalGate?: import('../orchestrator/approval-gate.ts').ApprovalGate;
  /** AgentProfileStore — workspace-level Vinyan Agent identity (singleton). */
  agentProfileStore?: import('../db/agent-profile-store.ts').AgentProfileStore;
  /** Skill store for agent-profile summarize(). */
  skillStore?: import('../db/skill-store.ts').SkillStore;
  /** Pattern store for agent-profile summarize(). */
  patternStore?: import('../db/pattern-store.ts').PatternStore;
  /** AgentContextStore — per-agent episodic memory for /agents/:id detail. */
  agentContextStore?: import('../db/agent-context-store.ts').AgentContextStore;
  /** AgentRegistry — merged built-in + config agent specs for /agents listing. */
  agentRegistry?: import('../orchestrator/agents/registry.ts').AgentRegistry;
  /** Workspace path — root of vinyan.json, .vinyan/, etc. Used by /doctor and /config. */
  workspace?: string;
  /** MCP client pool — exposed read-only via /mcp for dashboard inspection. */
  mcpClientPool?: import('../mcp/client.ts').MCPClientPool;
  /** Oracle accuracy store — per-oracle verdict outcomes for /oracles dashboard. */
  oracleAccuracyStore?: import('../db/oracle-accuracy-store.ts').OracleAccuracyStore;
  /** Sleep cycle runner — status + manual trigger for /sleep-cycle dashboard. */
  sleepCycleRunner?: import('../sleep-cycle/sleep-cycle.ts').SleepCycleRunner;
  /** Shadow store — read-only view of shadow validation queue. */
  shadowStore?: import('../db/shadow-store.ts').ShadowStore;
  /** Prediction ledger — Brier scores + outcomes for /calibration. */
  predictionLedger?: import('../db/prediction-ledger.ts').PredictionLedger;
  /** Provider trust store — per-(provider, capability) reliability for /providers. */
  providerTrustStore?: import('../db/provider-trust-store.ts').ProviderTrustStore;
  /** Federation budget pool — shared across instances for /federation. */
  federationBudgetPool?: import('../economy/federation-budget-pool.ts').FederationBudgetPool;
  /** Market scheduler — Vickrey auction + phase for /market. */
  marketScheduler?: import('../economy/market/market-scheduler.ts').MarketScheduler;
  /** Capability model — per-worker capability scores for /engines deepen. */
  capabilityModel?: import('../orchestrator/fleet/capability-model.ts').CapabilityModel;
  /**
   * Default profile name for this server instance. Requests that omit
   * both the `X-Vinyan-Profile` header and `body.profile` fall back to
   * this value. Defaults to `'default'` when not set.
   */
  defaultProfile?: string;
}

type EngineListEntry = EngineProfile & { stats?: EngineStats };

export class VinyanAPIServer {
  private server: BunServer | null = null;
  private auth: ReturnType<typeof createAuthMiddleware>;
  private rateLimiter: RateLimiter;
  private inFlightTasks = new Map<string, { promise: Promise<TaskResult>; cancel?: () => void }>();
  private asyncResults = new Map<string, TaskResult>();
  /** Per-entry TTL eviction timers for asyncResults. Cleared on shutdown. */
  private asyncResultsEviction = new Map<string, ReturnType<typeof setTimeout>>();
  /** Periodic sweeper for idle rate-limit buckets. */
  private rateLimiterPruneInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Cleanups for currently-open SSE streams. Bun normally fires
   * ReadableStream.cancel on client disconnect, but during graceful
   * shutdown we need a way to detach bus listeners deterministically
   * before the server is torn down — otherwise listeners outlive the
   * process and can keep it alive.
   */
  private openSSECleanups = new Set<() => void>();
  private shuttingDown = false;
  private a2aBridge: A2ABridge;
  private defaultSessionId: string | null = null;
  private wsClients = new Set<{ ws: unknown; authenticated: boolean }>();
  /** Dedup map: key = "sessionId:content" → timestamp of last submission. */
  private recentMessageDedup = new Map<string, number>();
  /** Async result retention before eviction. Long enough for clients to poll, bounded for memory. */
  private static readonly ASYNC_RESULT_TTL_MS = 3_600_000; // 1 hour
  /** Rate-limit bucket idle window — buckets idle longer than this are evicted. */
  private static readonly RATE_LIMIT_IDLE_TTL_MS = 3_600_000; // 1 hour
  private static readonly RATE_LIMIT_PRUNE_INTERVAL_MS = 5 * 60_000; // every 5 minutes

  constructor(
    private config: APIServerConfig,
    private deps: APIServerDeps,
  ) {
    this.auth = createAuthMiddleware(config.tokenPath);
    this.rateLimiter = new RateLimiter();
    this.a2aBridge = new A2ABridge({
      executeTask: deps.executeTask,
      baseUrl: `http://${config.bind}:${config.port}`,
      a2aManager: deps.a2aManager,
      agentProfileStore: deps.agentProfileStore,
    });
  }

  start(): void {
    const self = this;

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.bind,
      // Long-lived SSE/WS connections require a generous idle window.
      // Bun's default (10s) kills streams before the 30s heartbeat fires,
      // which the Vite proxy surfaces as "socket hang up" every ~28s.
      idleTimeout: 255,
      async fetch(req, server) {
        // WebSocket upgrade for /ws/ecp
        const url = new URL(req.url);
        if (url.pathname === '/ws/ecp') {
          const upgraded = server.upgrade(req, { data: { authenticated: !self.config.authRequired } } as never);
          if (!upgraded) {
            return new Response('WebSocket upgrade failed', { status: 400 });
          }
          return undefined as unknown as Response;
        }
        return self.handleRequest(req);
      },
      websocket: {
        open(ws) {
          const client = { ws, authenticated: !self.config.authRequired };
          self.wsClients.add(client);
          (ws as unknown as { data: { client: typeof client } }).data = { client };
        },
        message(ws, message) {
          const client = (ws as unknown as { data: { client: { authenticated: boolean } } }).data?.client;
          self.handleWebSocketMessage(
            ws,
            typeof message === 'string' ? message : new TextDecoder().decode(message),
            client,
          );
        },
        close(ws) {
          const client = (ws as unknown as { data: { client: object } }).data?.client;
          if (client) self.wsClients.delete(client as { ws: unknown; authenticated: boolean });
        },
      },
    });

    // Periodic eviction of idle rate-limit buckets so the per-key map
    // does not grow unbounded across long server uptimes.
    this.rateLimiterPruneInterval = setInterval(
      () => this.rateLimiter.prune(VinyanAPIServer.RATE_LIMIT_IDLE_TTL_MS),
      VinyanAPIServer.RATE_LIMIT_PRUNE_INTERVAL_MS,
    );
    (this.rateLimiterPruneInterval as { unref?: () => void }).unref?.();

    console.log(`[vinyan-api] Listening on ${this.config.bind}:${this.config.port}`);
  }

  /**
   * Schedule TTL-based eviction for a completed async task result. Without
   * this, `asyncResults` grows unbounded (one TaskResult per async submission)
   * and eventually causes heap pressure → GC pauses → API "hangs".
   */
  private scheduleAsyncResultEviction(taskId: string): void {
    const prev = this.asyncResultsEviction.get(taskId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.asyncResults.delete(taskId);
      this.asyncResultsEviction.delete(taskId);
    }, VinyanAPIServer.ASYNC_RESULT_TTL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.asyncResultsEviction.set(taskId, timer);
  }

  async handleRequest(req: Request): Promise<Response> {
    if (this.shuttingDown) {
      return jsonResponse({ error: 'Server is shutting down' }, 503);
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Auth check (I15)
    if (this.config.authRequired && requiresAuth(method, path)) {
      const authCtx = this.auth.authenticate(req);
      if (!authCtx.authenticated) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      // Rate limiting
      if (this.config.rateLimitEnabled) {
        const category = classifyEndpoint(method, path);
        if (category) {
          const { allowed, retryAfterSeconds } = this.rateLimiter.check(authCtx.apiKey ?? 'anonymous', category);
          if (!allowed) {
            return jsonResponse({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(retryAfterSeconds) });
          }
        }
      }
    }

    // G2: Emit bus events for API request/response
    const startTime = performance.now();
    this.deps.bus.emit('api:request', { method, path, taskId: extractTaskId(path) });

    try {
      const response = await this.route(method, path, req);
      this.deps.bus.emit('api:response', {
        method,
        path,
        status: response.status,
        durationMs: Math.round(performance.now() - startTime),
      });
      return response;
    } catch (err) {
      console.error('[vinyan-api] Unhandled error:', err);
      return jsonResponse({ error: 'Internal server error' }, 500);
    }
  }

  private async route(method: string, path: string, req: Request): Promise<Response> {
    // Dashboard moved to vinyan-ui (separate project). Redirect for backward compat.
    if (method === 'GET' && (path === '/dashboard' || path.startsWith('/dashboard/'))) {
      return jsonResponse({ message: 'Dashboard moved to vinyan-ui. Run: cd vinyan-ui && bun run dev' }, 301);
    }

    // ── Auth bootstrap (localhost only — lets the UI auto-fetch the token) ──
    if (method === 'GET' && path === '/api/v1/auth/bootstrap') {
      return jsonResponse({ token: this.auth.getToken() });
    }

    // ── Health & Metrics ──────────────────────────────────
    if (method === 'GET' && path === '/api/v1/health') {
      return jsonResponse({ status: 'ok', uptime_ms: process.uptime() * 1000 });
    }

    // G1: Wire real Prometheus metrics
    if (method === 'GET' && path === '/api/v1/metrics') {
      return this.handleMetrics(req);
    }

    // ── Global SSE (all events) ────────────────────────────
    if (method === 'GET' && path === '/api/v1/events') {
      return this.handleGlobalSSE();
    }

    // ── Tasks ─────────────────────────────────────────────
    if (method === 'GET' && path === '/api/v1/tasks') {
      return this.handleListTasks();
    }

    if (method === 'POST' && path === '/api/v1/tasks') {
      return this.handleSyncTask(req);
    }

    if (method === 'POST' && path === '/api/v1/tasks/async') {
      return this.handleAsyncTask(req);
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
      const taskId = path.split('/').pop()!;
      return this.handleGetTask(taskId);
    }

    if (method === 'DELETE' && path.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
      const taskId = path.split('/').pop()!;
      return this.handleCancelTask(taskId);
    }

    // ── Manual Retry (Round 5: stage-aware retry / timeout recovery) ──
    if (method === 'POST' && path.match(/^\/api\/v1\/tasks\/[^/]+\/retry$/)) {
      const taskId = path.split('/')[4]!;
      return this.handleRetryTask(taskId, req);
    }

    // ── Task Approval (A6) ──────────────────────────────────
    if (method === 'POST' && path.match(/^\/api\/v1\/tasks\/[^/]+\/approval$/)) {
      const taskId = path.split('/')[4]!;
      return this.handleApproval(taskId, req);
    }

    if (method === 'GET' && path === '/api/v1/approvals') {
      return this.handleListApprovals();
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/tasks\/[^/]+\/events$/)) {
      const taskId = path.split('/')[4]!;
      return this.handleSSE(taskId);
    }

    // Persisted bus event log for a task — JSON replay used by the chat UI
    // to reconstruct historical process timelines after page reload. Distinct
    // from `/events` (above) which is the live SSE stream.
    if (method === 'GET' && path.match(/^\/api\/v1\/tasks\/[^/]+\/event-history$/)) {
      const taskId = path.split('/')[4]!;
      return this.handleTaskEventHistory(taskId, req);
    }

    // ── Sessions ──────────────────────────────────────────
    if (method === 'GET' && path === '/api/v1/sessions') {
      return this.handleListSessions(req);
    }

    if (method === 'POST' && path === '/api/v1/sessions') {
      return this.handleCreateSession(req);
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/sessions\/[^/]+$/)) {
      const sessionId = path.split('/').pop()!;
      return this.handleGetSession(sessionId);
    }

    if (method === 'PATCH' && path.match(/^\/api\/v1\/sessions\/[^/]+$/)) {
      const sessionId = path.split('/').pop()!;
      return this.handleUpdateSession(sessionId, req);
    }

    if (method === 'DELETE' && path.match(/^\/api\/v1\/sessions\/[^/]+$/)) {
      const sessionId = path.split('/').pop()!;
      // Two-step delete: ?permanent=true hard-deletes a session that's
      // already in Trash. Default behavior is still soft-delete (move to
      // Trash) so existing API clients don't change semantics.
      const url = new URL(req.url);
      if (url.searchParams.get('permanent') === 'true') {
        return this.handleHardDeleteSession(sessionId);
      }
      return this.handleSoftDeleteSession(sessionId);
    }

    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/archive$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleArchiveSession(sessionId);
    }

    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/unarchive$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleUnarchiveSession(sessionId);
    }

    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/restore$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleRestoreSession(sessionId);
    }

    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/compact$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleCompactSession(sessionId);
    }

    // Agent Conversation: conversational message endpoints.
    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/messages$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleSessionMessage(sessionId, req);
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/sessions\/[^/]+\/messages$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleListSessionMessages(sessionId, req);
    }

    // Agent Conversation — long-lived session-scoped SSE (PR #10).
    // One connection per client that observes every task running under
    // the session, across multiple turns, with periodic heartbeats.
    if (method === 'GET' && path.match(/^\/api\/v1\/sessions\/[^/]+\/stream$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleSessionStream(sessionId);
    }

    // Phase D: user responds to a structured clarification request.
    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/clarification\/respond$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleClarificationResponse(sessionId, req);
    }

    // Phase E: user approves or rejects a workflow plan that is awaiting
    // approval (`workflow:plan_ready` with `awaitingApproval: true`).
    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/workflow\/approve$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleWorkflowApprove(sessionId, req);
    }
    if (method === 'POST' && path.match(/^\/api\/v1\/sessions\/[^/]+\/workflow\/reject$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleWorkflowReject(sessionId, req);
    }

    // ── Read-only queries ─────────────────────────────────
    if (method === 'GET' && path === '/api/v1/agent-profile') {
      if (!this.deps.agentProfileStore) {
        return jsonResponse({ error: 'agent-profile store not configured' }, 503);
      }
      const profile = this.deps.agentProfileStore.get();
      if (!profile) {
        return jsonResponse({ error: 'agent profile not bootstrapped' }, 404);
      }
      const summary = this.deps.agentProfileStore.summarize({
        traceStore: this.deps.traceStore,
        skillStore: this.deps.skillStore,
        workerStore: this.deps.workerStore,
        patternStore: this.deps.patternStore,
      });
      return jsonResponse({ profile, summary });
    }

    if (method === 'GET' && path === '/api/v1/workers') {
      return jsonResponse({ workers: this.composeEngineList() });
    }

    if (method === 'GET' && path === '/api/v1/engines') {
      // Same payload shape as /api/v1/workers (the dashboard's "Engines" page
      // expects `Worker[]`). Distinct route surface for future migration to a
      // strictly-live engine view.
      return jsonResponse({ engines: this.composeEngineList() });
    }

    if (method === 'GET' && path === '/api/v1/rules') {
      return this.handleListRules(req);
    }

    if (method === 'GET' && path === '/api/v1/agents') {
      return this.handleListAgents();
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/agents\/[^/]+$/)) {
      const agentId = path.split('/').pop()!;
      return this.handleGetAgent(agentId);
    }

    if (method === 'GET' && path === '/api/v1/skills') {
      return this.handleListSkills(req);
    }

    if (method === 'GET' && path === '/api/v1/patterns') {
      return this.handleListPatterns(req);
    }

    if (method === 'GET' && path === '/api/v1/doctor') {
      return this.handleDoctor(req);
    }

    if (method === 'GET' && path === '/api/v1/config') {
      return this.handleGetConfig();
    }

    if (method === 'POST' && path === '/api/v1/config/validate') {
      return this.handleValidateConfig(req);
    }

    if (method === 'GET' && path === '/api/v1/mcp') {
      return this.handleGetMCP();
    }

    if (method === 'GET' && path === '/api/v1/oracles') {
      return this.handleListOracles();
    }

    if (method === 'GET' && path === '/api/v1/sleep-cycle') {
      return this.handleSleepCycleStatus();
    }

    if (method === 'POST' && path === '/api/v1/sleep-cycle/trigger') {
      return this.handleSleepCycleTrigger();
    }

    if (method === 'GET' && path === '/api/v1/shadow') {
      return this.handleListShadow(req);
    }

    if (method === 'GET' && path === '/api/v1/traces') {
      return this.handleListTraces(req);
    }

    if (method === 'GET' && path === '/api/v1/memory') {
      return this.handleListMemory();
    }

    if (method === 'POST' && path === '/api/v1/memory/approve') {
      return this.handleMemoryApprove(req);
    }

    if (method === 'POST' && path === '/api/v1/memory/reject') {
      return this.handleMemoryReject(req);
    }

    if (method === 'GET' && path === '/api/v1/predictions/calibration') {
      return this.handleCalibration();
    }

    if (method === 'GET' && path === '/api/v1/hms') {
      return this.handleHMS();
    }

    if (method === 'GET' && path === '/api/v1/peers') {
      return this.handleListPeers();
    }

    if (method === 'GET' && path === '/api/v1/providers') {
      return this.handleListProviders();
    }

    if (method === 'GET' && path === '/api/v1/federation') {
      return this.handleFederation();
    }

    if (method === 'GET' && path === '/api/v1/market') {
      return this.handleMarket();
    }

    if (method === 'GET' && path === '/api/v1/economy/recent') {
      return this.handleEconomyRecent(req);
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/engines\/[^/]+$/)) {
      // Engine ids carry slashes ("openrouter/balanced/anthropic/<model>"),
      // so the UI URL-encodes the id segment. Decode here so the registry
      // and workerStore lookups receive the canonical form.
      const encoded = path.split('/').pop()!;
      let id: string;
      try {
        id = decodeURIComponent(encoded);
      } catch {
        id = encoded;
      }
      return this.handleGetEngine(id);
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/sessions\/[^/]+\/clarifications$/)) {
      const sessionId = path.split('/')[4]!;
      return this.handleSessionClarifications(sessionId);
    }

    if (method === 'GET' && path === '/api/v1/facts') {
      if (this.deps.worldGraph) {
        const factsUrl = new URL(req.url);
        const target = factsUrl.searchParams.get('target');
        const limit = parseInt(factsUrl.searchParams.get('limit') ?? '200', 10);
        const facts = target
          ? this.deps.worldGraph.queryFacts(target)
          : this.deps.worldGraph.listFacts(Math.min(limit, 1000));
        return jsonResponse({
          facts: facts.map((f) => ({
            id: f.id,
            target: f.target,
            pattern: f.pattern,
            oracleName: f.oracleName,
            confidence: f.confidence,
            verifiedAt: f.verifiedAt,
            sourceFile: f.sourceFile,
          })),
        });
      }
      return jsonResponse({ facts: [] });
    }

    // ── Economy ──────────────────────────────────────────────
    if (method === 'GET' && path === '/api/v1/economy') {
      const budgetStatuses = this.deps.budgetEnforcer?.checkBudget() ?? [];
      const costHour = this.deps.costLedger?.getAggregatedCost('hour') ?? { total_usd: 0, count: 0 };
      const costDay = this.deps.costLedger?.getAggregatedCost('day') ?? { total_usd: 0, count: 0 };
      const costMonth = this.deps.costLedger?.getAggregatedCost('month') ?? { total_usd: 0, count: 0 };
      const totalEntries = this.deps.costLedger?.count() ?? 0;
      return jsonResponse({
        enabled: !!(this.deps.costLedger || this.deps.budgetEnforcer),
        budget: budgetStatuses,
        cost: { hour: costHour, day: costDay, month: costMonth },
        totalEntries,
      });
    }

    // ── ECP HTTP Verify (PH5.18) ─────────────────────────────
    if (method === 'POST' && path === '/ecp/v1/verify') {
      return this.handleHttpVerify(req);
    }

    // ── A2A Protocol (PH5.6) ────────────────────────────────
    if (method === 'GET' && path === '/.well-known/agent.json') {
      return jsonResponse(this.a2aBridge.getAgentCard());
    }

    if (method === 'POST' && path === '/a2a') {
      return this.handleA2ARequest(req);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }

  // ── Metrics Handler (G1: real Prometheus metrics) ────────────

  private handleMetrics(req: Request): Response {
    const url = new URL(req.url);
    const format = url.searchParams.get('format');
    const counters = this.deps.metricsCollector?.getCounters() ?? {};

    // Without traceStore, return basic counters
    if (!this.deps.traceStore) {
      return jsonResponse({ tasks_in_flight: this.inFlightTasks.size, counters });
    }

    const metrics = getSystemMetrics({
      traceStore: this.deps.traceStore,
      ruleStore: this.deps.ruleStore,
      workerStore: this.deps.workerStore,
    });

    if (format === 'json') {
      return jsonResponse({ ...metrics, counters, tasks_in_flight: this.inFlightTasks.size });
    }

    // Default: Prometheus text exposition format
    return new Response(renderPrometheus(metrics, counters), {
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
    });
  }

  // ── A2A Handler ──────────────────────────────────────────

  private async handleA2ARequest(req: Request): Promise<Response> {
    const body = await req.json();
    const response = await this.a2aBridge.handleRequest(body);
    return jsonResponse(response); // JSON-RPC: errors are in response body, HTTP is always 200
  }

  // ── ECP HTTP Verify Handler (PH5.18) ───────────────────

  /** K1.4: Zod schema for HTTP verify request body */
  private static readonly HttpVerifySchema = z.object({
    oracle_name: z.string().min(1),
    hypothesis: z.unknown(),
    ecp_version: z.string().optional(),
  });

  /**
   * Agent Conversation: request body schema for POST /api/v1/sessions/:id/messages.
   * `content` is the raw user message; the server records it as the next user
   * turn and dispatches a task through the orchestrator. `taskType`, `budget`,
   * and `targetFiles` are optional overrides; when omitted the server infers
   * sensible defaults (matching chat.ts).
   *
   * `stream: true` switches the response to `text/event-stream` (SSE), matching
   * the OpenAI chat.completions streaming convention. Events forwarded include
   * task:start, phase:timing, agent:tool_executed, agent:turn_complete,
   * agent:clarification_requested, and task:complete (which closes the stream).
   */
  private static readonly SessionMessageSchema = z.object({
    content: z.string().min(1, 'content must not be empty'),
    taskType: z.enum(['code', 'reasoning']).optional(),
    targetFiles: z.array(z.string()).optional(),
    budget: z
      .object({
        maxTokens: z.number().positive(),
        maxDurationMs: z.number().positive(),
        maxRetries: z.number().nonnegative(),
      })
      .optional(),
    showThinking: z.boolean().optional(),
    stream: z.boolean().optional(),
    /**
     * Profile namespace override (W1 PR #1). Same rules as
     * `X-Vinyan-Profile`: /^[a-z][a-z0-9-]*$/ or 'default'.
     */
    profile: z
      .string()
      .refine(isValidProfileName, { message: 'profile must match /^[a-z][a-z0-9-]*$/ or be "default"' })
      .optional(),
  });

  private async handleHttpVerify(req: Request): Promise<Response> {
    if (!this.deps.runOracle) {
      return jsonResponse({ error: 'Oracle runner not configured' }, 501);
    }
    try {
      const body = await req.json();
      const parsed = VinyanAPIServer.HttpVerifySchema.safeParse(body);
      if (!parsed.success) {
        return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
      }
      const { oracle_name: oracleName, hypothesis } = parsed.data;
      const verdict = await this.deps.runOracle(oracleName, hypothesis as never);
      return jsonResponse(verdict);
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : 'Oracle execution failed' }, 500);
    }
  }

  // ── WebSocket ECP Handler (PH5.18) ─────────────────────

  /** K1.4: Zod schema for WebSocket JSON-RPC messages */
  private static readonly WsMessageSchema = z.object({
    jsonrpc: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  });

  private handleWebSocketMessage(
    ws: { send(data: string): void },
    data: string,
    client?: { authenticated: boolean },
  ): void {
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const parsed = VinyanAPIServer.WsMessageSchema.safeParse(rawParsed);
    if (!parsed.success) {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: `Invalid request: ${parsed.error.message}` },
        }),
      );
      return;
    }
    const msg = parsed.data;

    if (msg.method === 'ecp/authenticate') {
      const token = (msg.params?.token as string) ?? '';
      const authResult = this.auth.authenticate(
        new Request('http://localhost', { headers: { Authorization: `Bearer ${token}` } }),
      );
      if (client) client.authenticated = authResult.authenticated;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authenticated: authResult.authenticated } }));
      return;
    }

    if (msg.method === 'ecp/heartbeat') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
      return;
    }

    // Auth required for verify operations
    if (this.config.authRequired && !client?.authenticated) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Unauthorized' } }));
      return;
    }

    if (msg.method === 'ecp/verify') {
      const oracleName = msg.params?.oracle_name as string;
      const hypothesis = msg.params?.hypothesis;
      if (!oracleName || !hypothesis) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32602, message: 'Missing oracle_name or hypothesis' },
          }),
        );
        return;
      }
      if (this.deps.runOracle) {
        this.deps.runOracle(oracleName, hypothesis as never).then(
          (verdict) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: verdict })),
          (err) =>
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
              }),
            ),
        );
      } else {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Oracle runner not configured' },
          }),
        );
      }
      return;
    }

    ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } }),
    );
  }

  // ── Task Handlers ───────────────────────────────────────

  // G4: Track tasks in sessions
  private async handleSyncTask(req: Request): Promise<Response> {
    const body = (await req.json()) as Partial<TaskInput>;
    const resolved = resolveRequestProfile(req, body, this.deps.defaultProfile);
    if ('error' in resolved) return jsonResponse({ error: resolved.error }, 400);
    const input = buildTaskInput(body, resolved.profile);

    const session = this.getOrCreateDefaultSession();
    this.deps.sessionManager.addTask(session.id, input);

    const result = await this.deps.executeTask(input);

    this.deps.sessionManager.completeTask(session.id, input.id, result);
    return jsonResponse({ result });
  }

  private async handleAsyncTask(req: Request): Promise<Response> {
    const body = (await req.json()) as Partial<TaskInput>;
    const resolved = resolveRequestProfile(req, body, this.deps.defaultProfile);
    if ('error' in resolved) return jsonResponse({ error: resolved.error }, 400);
    const input = buildTaskInput(body, resolved.profile);

    const session = this.getOrCreateDefaultSession();
    this.deps.sessionManager.addTask(session.id, input);

    const controller = new AbortController();
    const promise = this.deps.executeTask(input);
    this.inFlightTasks.set(input.id, {
      promise,
      cancel: () => {
        controller.abort();
        this.deps.bus.emit('task:timeout', { taskId: input.id, elapsedMs: 0, budgetMs: 0 });
      },
    });

    promise
      .then((result) => {
        this.deps.sessionManager.completeTask(session.id, input.id, result);
        this.asyncResults.set(input.id, result);
        this.scheduleAsyncResultEviction(input.id);
        this.inFlightTasks.delete(input.id);
      })
      .catch(() => {
        this.inFlightTasks.delete(input.id);
      });

    return jsonResponse({ taskId: input.id, status: 'accepted' }, 202);
  }

  private handleListTasks(): Response {
    // Merge in-memory async results with session-persisted tasks.
    // Session store is the source of truth for session-based tasks (Chat).
    const allSessionTasks = this.deps.sessionManager.listAllTasks(200);
    const seenIds = new Set<string>();

    const tasks: Array<{
      taskId: string;
      sessionId?: string;
      status: string;
      goal?: string;
      result?: unknown;
    }> = [];

    // In-flight tasks (running right now)
    for (const [id] of this.inFlightTasks) {
      seenIds.add(id);
      const sessionTask = allSessionTasks.find((t) => t.taskId === id);
      tasks.push({
        taskId: id,
        sessionId: sessionTask?.sessionId,
        status: 'running',
        goal: sessionTask?.goal,
      });
    }

    // Async API results (not from session). Pass through the orchestrator's
    // TaskResult.status verbatim so the UI can distinguish escalated /
    // uncertain / partial from completed and failed (the StatusBadge has
    // dedicated tones for each — collapsing them here loses observability).
    for (const [id, result] of this.asyncResults) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const sessionTask = allSessionTasks.find((t) => t.taskId === id);
      tasks.push({
        taskId: id,
        sessionId: sessionTask?.sessionId,
        status: result.status,
        goal: sessionTask?.goal,
        result,
      });
    }

    // Session-persisted tasks (from Chat)
    for (const st of allSessionTasks) {
      if (seenIds.has(st.taskId)) continue;
      seenIds.add(st.taskId);
      tasks.push({
        taskId: st.taskId,
        sessionId: st.sessionId,
        status: st.status,
        goal: st.goal,
        result: st.result,
      });
    }

    return jsonResponse({ tasks });
  }

  private handleListSessions(req: Request): Response {
    const url = new URL(req.url);
    const stateParam = url.searchParams.get('state') ?? 'active';
    const allowedStates = new Set(['active', 'archived', 'deleted', 'all']);
    const state = (allowedStates.has(stateParam) ? stateParam : 'active') as 'active' | 'archived' | 'deleted' | 'all';
    const search = url.searchParams.get('search') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const offsetRaw = url.searchParams.get('offset');
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 0)) : undefined;
    const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw, 10) || 0) : undefined;
    // `?source=ui|api|all` — by default the chat Sessions page hides
    // sessions auto-created by the async-task API (`source='api'`). Those
    // sessions are task containers only — they never receive
    // recordAssistantTurn, so opening them shows an empty chat which
    // confuses users. Observability tools that want EVERY session can
    // pass `?source=all`. `?source=api` returns api-only.
    const sourceParam = url.searchParams.get('source') ?? 'ui';
    const allowedSources = new Set(['ui', 'api', 'all']);
    const sourceFilter = allowedSources.has(sourceParam) ? sourceParam : 'ui';
    const allSessions = this.deps.sessionManager?.listSessions({ state, search, limit, offset }) ?? [];
    const sessions =
      sourceFilter === 'all'
        ? allSessions
        : allSessions.filter((s) => s.source === sourceFilter);
    return jsonResponse({ sessions });
  }

  private handleGlobalSSE(): Response {
    // Safety-net cleanup after 60 minutes is registered inside createSSEStream
    // so it is cleared when the client disconnects (cancel) — the previous
    // external setTimeout would fire 60 min later even on healthy disconnect,
    // leaking a timer handle per connection.
    let trackerSlot: (() => void) | null = null;
    const { stream, cleanup } = createSSEStream(this.deps.bus, undefined, {
      heartbeatIntervalMs: 30_000,
      safetyTimeoutMs: 3_600_000,
      onClose: () => {
        if (trackerSlot) this.openSSECleanups.delete(trackerSlot);
      },
    });
    trackerSlot = cleanup;
    this.openSSECleanups.add(cleanup);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // Dashboard removed — migrated to vinyan-ui (separate React project).

  private handleGetTask(taskId: string): Response {
    // Check completed results (async API tasks)
    const result = this.asyncResults.get(taskId);
    if (result) {
      return jsonResponse({ taskId, status: 'completed', result });
    }

    // Check in-flight
    if (this.inFlightTasks.has(taskId)) {
      return jsonResponse({ taskId, status: 'running' });
    }

    // Check session-persisted tasks (Chat-originated)
    const allTasks = this.deps.sessionManager.listAllTasks(500);
    const sessionTask = allTasks.find((t) => t.taskId === taskId);
    if (sessionTask) {
      return jsonResponse({
        taskId: sessionTask.taskId,
        sessionId: sessionTask.sessionId,
        status: sessionTask.status,
        goal: sessionTask.goal,
        result: sessionTask.result,
      });
    }

    return jsonResponse({ error: 'Task not found' }, 404);
  }

  private handleCancelTask(taskId: string): Response {
    const inFlight = this.inFlightTasks.get(taskId);
    if (inFlight) {
      inFlight.cancel?.();
      this.inFlightTasks.delete(taskId);
      return jsonResponse({ taskId, status: 'cancelled' });
    }
    return jsonResponse({ error: 'Task not found or already completed' }, 404);
  }

  /**
   * Manual retry — POST /api/v1/tasks/:id/retry
   *
   * Spawns a sibling task that preserves the original goal, sessionId,
   * targetFiles, and constraints. Defaults to a generous 240s budget for
   * timeout-recovery flows; callers may override via `body.budget` or
   * `body.maxDurationMs`. Emits `task:retry_requested` for observability
   * (UI can flip to "Retrying…" immediately) and dispatches via the
   * standard async path so SSE consumers see normal `task:start`.
   */
  private async handleRetryTask(parentTaskId: string, req: Request): Promise<Response> {
    if (this.inFlightTasks.has(parentTaskId)) {
      return jsonResponse({ error: 'Task is still running' }, 409);
    }

    const parent = this.deps.sessionManager.getTaskById(parentTaskId);
    if (!parent) {
      return jsonResponse({ error: 'Parent task not found' }, 404);
    }

    let body: {
      budget?: TaskInput['budget'];
      maxDurationMs?: number;
      reason?: string;
      goal?: string;
      constraints?: string[];
    } = {};
    try {
      const text = await req.text();
      if (text.length > 0) body = JSON.parse(text);
    } catch {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }

    // Default 240s for timeout-recovery; honour explicit overrides first.
    const TIMEOUT_RETRY_BUDGET = { maxTokens: 50_000, maxDurationMs: 240_000, maxRetries: 3 } as const;
    const budget: TaskInput['budget'] =
      body.budget ??
      (body.maxDurationMs
        ? { ...TIMEOUT_RETRY_BUDGET, maxDurationMs: body.maxDurationMs }
        : TIMEOUT_RETRY_BUDGET);

    const newId = crypto.randomUUID();
    const goal = body.goal ?? parent.input.goal;
    const constraints = body.constraints ?? parent.input.constraints;

    const input: TaskInput = {
      ...parent.input,
      id: newId,
      goal,
      ...(constraints && constraints.length > 0 ? { constraints } : {}),
      budget,
    };

    // Track parent linkage on the bus so observability surfaces the chain.
    // Observational only (A1, A3) — never used to alter routing.
    this.deps.bus?.emit('task:retry_requested', {
      taskId: newId,
      parentTaskId,
      reason: body.reason ?? 'manual-retry',
      sessionId: parent.sessionId,
    });

    this.deps.sessionManager.addTask(parent.sessionId, input);

    const promise = this.deps.executeTask(input);
    this.inFlightTasks.set(input.id, {
      promise,
      cancel: () => {
        this.deps.bus?.emit('task:timeout', { taskId: input.id, elapsedMs: 0, budgetMs: 0 });
      },
    });

    promise
      .then((result) => {
        this.deps.sessionManager.completeTask(parent.sessionId, input.id, result);
        this.asyncResults.set(input.id, result);
        this.scheduleAsyncResultEviction(input.id);
        this.inFlightTasks.delete(input.id);
      })
      .catch(() => {
        this.inFlightTasks.delete(input.id);
      });

    return jsonResponse(
      {
        taskId: newId,
        parentTaskId,
        sessionId: parent.sessionId,
        status: 'accepted',
        budget,
      },
      202,
    );
  }

  private async handleApproval(taskId: string, req: Request): Promise<Response> {
    if (!this.deps.approvalGate) {
      return jsonResponse({ error: 'Approval gate not configured' }, 501);
    }
    try {
      const body = (await req.json()) as { decision: string };
      const decision = body.decision === 'approved' ? 'approved' : 'rejected';
      const resolved = this.deps.approvalGate.resolve(taskId, decision as 'approved' | 'rejected');
      if (!resolved) {
        return jsonResponse({ error: 'No pending approval for this task' }, 404);
      }
      return jsonResponse({ taskId, decision, status: 'resolved' });
    } catch {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }
  }

  private handleListApprovals(): Response {
    const ids = this.deps.approvalGate?.getPendingIds() ?? [];
    return jsonResponse({ pending: ids });
  }

  // ── Phase D: structured clarification response ────────────

  private async handleClarificationResponse(sessionId: string, req: Request): Promise<Response> {
    if (!this.deps.bus) {
      return jsonResponse({ error: 'Bus not configured' }, 501);
    }
    try {
      const body = (await req.json()) as {
        taskId?: string;
        responses?: Array<{
          questionId?: string;
          selectedOptionIds?: string[];
          freeText?: string;
        }>;
      };
      if (!body.taskId || !Array.isArray(body.responses)) {
        return jsonResponse({ error: 'taskId and responses[] are required' }, 400);
      }
      const responses = body.responses.map((r) => ({
        questionId: String(r.questionId ?? ''),
        selectedOptionIds: Array.isArray(r.selectedOptionIds) ? r.selectedOptionIds.map(String) : [],
        freeText: typeof r.freeText === 'string' ? r.freeText : undefined,
      }));
      this.deps.bus.emit('agent:clarification_response', {
        taskId: body.taskId,
        sessionId,
        responses,
      });
      return jsonResponse({ taskId: body.taskId, sessionId, status: 'recorded' });
    } catch {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }
  }

  // ── Phase E: workflow approval / rejection ────────────────

  private async handleWorkflowApprove(sessionId: string, req: Request): Promise<Response> {
    if (!this.deps.bus) {
      return jsonResponse({ error: 'Bus not configured' }, 501);
    }
    try {
      const body = (await req.json()) as { taskId?: string };
      if (!body.taskId) {
        return jsonResponse({ error: 'taskId is required' }, 400);
      }
      this.deps.bus.emit('workflow:plan_approved', { taskId: body.taskId, sessionId });
      return jsonResponse({ taskId: body.taskId, sessionId, status: 'approved' });
    } catch {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }
  }

  private async handleWorkflowReject(sessionId: string, req: Request): Promise<Response> {
    if (!this.deps.bus) {
      return jsonResponse({ error: 'Bus not configured' }, 501);
    }
    try {
      const body = (await req.json()) as { taskId?: string; reason?: string };
      if (!body.taskId) {
        return jsonResponse({ error: 'taskId is required' }, 400);
      }
      this.deps.bus.emit('workflow:plan_rejected', {
        taskId: body.taskId,
        sessionId,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      return jsonResponse({ taskId: body.taskId, sessionId, status: 'rejected' });
    } catch {
      return jsonResponse({ error: 'Invalid request body' }, 400);
    }
  }

  // ── Agent / Skill / Pattern Handlers (read-only) ────────

  private handleListAgents(): Response {
    const registry = this.deps.agentRegistry;
    const profileStore = this.deps.agentProfileStore;
    const contextStore = this.deps.agentContextStore;

    if (!registry) {
      return jsonResponse({ agents: [] });
    }

    const specs = registry.listAgents();
    const defaultId = registry.defaultAgent().id;

    const agents = specs.map((a) => {
      const profile = profileStore?.get(a.id) ?? null;
      const context = contextStore?.findById(a.id) ?? null;
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        builtin: a.builtin ?? false,
        isDefault: a.id === defaultId,
        allowedTools: a.allowedTools ?? null,
        routingHints: a.routingHints ?? null,
        capabilityOverrides: a.capabilityOverrides ?? null,
        role: profile?.role ?? null,
        specialization: profile?.specialization ?? null,
        persona: profile?.persona ?? context?.identity.persona ?? null,
        episodeCount: context?.memory.episodes.length ?? 0,
        proficiencyCount: context ? Object.keys(context.skills.proficiencies).length : 0,
      };
    });

    return jsonResponse({ agents });
  }

  private handleGetAgent(id: string): Response {
    const registry = this.deps.agentRegistry;
    if (!registry) {
      return jsonResponse({ error: 'agent registry not configured' }, 503);
    }
    const spec = registry.getAgent(id);
    if (!spec) {
      return jsonResponse({ error: `agent '${id}' not found` }, 404);
    }
    const profile = this.deps.agentProfileStore?.get(id) ?? null;
    const context = this.deps.agentContextStore?.findById(id) ?? null;

    return jsonResponse({
      spec: {
        id: spec.id,
        name: spec.name,
        description: spec.description,
        builtin: spec.builtin ?? false,
        isDefault: registry.defaultAgent().id === spec.id,
        soul: spec.soul ?? null,
        soulPath: spec.soulPath ?? null,
        allowedTools: spec.allowedTools ?? null,
        routingHints: spec.routingHints ?? null,
        capabilityOverrides: spec.capabilityOverrides ?? null,
      },
      profile,
      context,
    });
  }

  private handleListSkills(req: Request): Response {
    const store = this.deps.skillStore;
    if (!store) return jsonResponse({ skills: [] });

    const statusParam = new URL(req.url).searchParams.get('status');
    const skills = statusParam
      ? store.findByStatus(statusParam as 'active' | 'probation' | 'demoted')
      : [...store.findByStatus('active'), ...store.findByStatus('probation'), ...store.findByStatus('demoted')];

    return jsonResponse({ skills });
  }

  private handleListPatterns(req: Request): Response {
    const store = this.deps.patternStore;
    if (!store) return jsonResponse({ patterns: [] });

    const minDecay = parseFloat(new URL(req.url).searchParams.get('minDecay') ?? '0');
    const patterns = store.findActive(minDecay);
    return jsonResponse({ patterns });
  }

  // ── Rules / Oracles / Sleep Cycle Handlers ──────────────

  private handleListRules(req: Request): Response {
    const store = this.deps.ruleStore;
    if (!store) return jsonResponse({ rules: [], counts: { active: 0, probation: 0, retired: 0 } });

    const statusParam = new URL(req.url).searchParams.get('status') as 'active' | 'probation' | 'retired' | null;

    const rules = statusParam ? store.findByStatus(statusParam) : store.findByStatus('active');
    const counts = {
      active: store.countByStatus('active'),
      probation: store.countByStatus('probation'),
      retired: store.countByStatus('retired'),
    };
    return jsonResponse({ rules, counts });
  }

  private async handleListOracles(): Promise<Response> {
    // Static registry — built-in oracles always known, even without runtime state.
    const { listOracles, getOracleEntry } = await import('../oracle/registry.ts');
    const { getOracleCircuitBreaker } = await import('../gate/gate.ts');
    const names = listOracles();
    const breakerStates = getOracleCircuitBreaker().getAllStates();
    const accuracyStore = this.deps.oracleAccuracyStore;

    // Pull config overrides from vinyan.json if workspace is available
    let configOverrides: Record<string, unknown> = {};
    if (this.deps.workspace) {
      try {
        const { loadConfig } = await import('../config/index.ts');
        const cfg = loadConfig(this.deps.workspace);
        configOverrides = (cfg.oracles ?? {}) as Record<string, unknown>;
      } catch {
        /* best-effort */
      }
    }

    // Also surface any names seen in traces but not in the static registry
    const seenNames = new Set(names);
    if (accuracyStore) {
      for (const n of accuracyStore.listDistinctOracleNames()) {
        seenNames.add(n);
      }
    }

    const oracles = Array.from(seenNames).map((name) => {
      const entry = getOracleEntry(name);
      // Strip prefix "-oracle" when looking up config (ast-oracle → ast)
      const configKey = name.replace(/-oracle$/, '');
      const cfg = (configOverrides[configKey] ?? configOverrides[name] ?? {}) as {
        enabled?: boolean;
        tier?: string;
        timeout_ms?: number;
        timeout_behavior?: string;
      };

      const accuracy = accuracyStore ? accuracyStore.computeOracleAccuracy(name) : null;

      return {
        name,
        builtin: entry != null,
        tier: cfg.tier ?? entry?.tier ?? null,
        timeoutMs: cfg.timeout_ms ?? entry?.timeoutMs ?? null,
        timeoutBehavior: cfg.timeout_behavior ?? null,
        enabled: cfg.enabled ?? true,
        languages: entry?.languages ?? [],
        transport: entry?.transport ?? 'stdio',
        circuitState: breakerStates[name] ?? 'closed',
        accuracy,
      };
    });

    oracles.sort((a, b) => a.name.localeCompare(b.name));
    return jsonResponse({ oracles });
  }

  private handleSleepCycleStatus(): Response {
    const runner = this.deps.sleepCycleRunner;
    const patternStore = this.deps.patternStore;

    const interval = runner?.getInterval() ?? null;
    const totalRuns = patternStore?.countCycleRuns() ?? 0;
    const recentRuns = patternStore?.getRecentCycleTimestamps(10) ?? [];

    return jsonResponse({
      enabled: runner != null,
      interval,
      totalRuns,
      recentRuns,
      patternsExtracted: patternStore?.count() ?? 0,
    });
  }

  private async handleSleepCycleTrigger(): Promise<Response> {
    const runner = this.deps.sleepCycleRunner;
    if (!runner) {
      return jsonResponse({ error: 'sleep-cycle runner not configured' }, 503);
    }
    // Fire-and-forget: kick off run, return immediately.
    // SSE event sleep:cycleComplete will notify the UI when it finishes.
    runner.run().catch((err) => {
      console.error('[vinyan-api] sleep-cycle trigger failed:', err);
    });
    return jsonResponse({ triggered: true, startedAt: Date.now() }, 202);
  }

  // ── Tier 3: Peers / Providers / Federation / Market / Engine / Sessions ───

  private handleListPeers(): Response {
    const a2a = this.deps.a2aManager as { peerTrustManager?: { getAllPeers(): unknown[] } } | undefined;
    const trustManager = a2a?.peerTrustManager;
    if (!trustManager) {
      return jsonResponse({ enabled: false, peers: [] });
    }
    const peers = trustManager.getAllPeers();
    return jsonResponse({ enabled: true, peers });
  }

  private handleListProviders(): Response {
    const store = this.deps.providerTrustStore;
    if (!store) return jsonResponse({ enabled: false, providers: [] });
    const providers = store.getAllProviders();
    return jsonResponse({ enabled: true, providers });
  }

  private handleFederation(): Response {
    const pool = this.deps.federationBudgetPool;
    if (!pool) {
      return jsonResponse({
        enabled: false,
        pool: { total_contributed_usd: 0, total_consumed_usd: 0, remaining_usd: 0, exhausted: false },
      });
    }
    return jsonResponse({ enabled: true, pool: pool.getStatus() });
  }

  private handleMarket(): Response {
    const scheduler = this.deps.marketScheduler;
    if (!scheduler) {
      return jsonResponse({ enabled: false, active: false });
    }
    const phase = scheduler.getPhase();
    const bidderStats = scheduler.getAccuracyTracker().getAllRecords();
    return jsonResponse({
      enabled: true,
      active: scheduler.isActive(),
      phase,
      bidderStats,
    });
  }

  private handleEconomyRecent(req: Request): Response {
    const ledger = this.deps.costLedger as { queryByTimeRange?: (from: number, to: number) => unknown[] } | undefined;
    if (!ledger?.queryByTimeRange) return jsonResponse({ entries: [] });
    const limit = Math.min(parseInt(new URL(req.url).searchParams.get('limit') ?? '100', 10) || 100, 500);
    const since = Date.now() - 7 * 24 * 3600 * 1000; // last 7 days
    const all = ledger.queryByTimeRange(since, Date.now()) as Array<{ timestamp: number }>;
    const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp);
    return jsonResponse({ entries: sorted.slice(0, limit), total: all.length });
  }

  private handleGetEngine(id: string): Response {
    const workerId = workerIdForEngine(id);
    const historical =
      this.deps.workerStore?.findById(id) ??
      this.deps.workerStore?.findById(workerId) ??
      this.deps.workerStore?.findByModelId(id)[0] ??
      null;
    // Fall back to the live registry when the engine has never run a task
    // (workerStore is populated lazily from trace records). Without this
    // fallback, every engine 404s on a fresh server before the first task.
    const worker = historical ?? this.engineFromRegistry(id) ?? this.engineFromRegistry(engineIdFromWorker(id));
    if (!worker) return jsonResponse({ error: `engine '${id}' not found` }, 404);

    const capModel = this.deps.capabilityModel;
    const capabilities = capModel?.getWorkerCapabilities(worker.id) ?? [];

    const trustStore = this.deps.providerTrustStore;
    const providerTrust =
      trustStore && worker.config.modelId
        ? trustStore.getProvider(worker.config.modelId.split('/')[0] ?? worker.config.modelId)
        : null;

    return jsonResponse({ worker: this.withEngineStats(worker), capabilities, providerTrust });
  }

  /**
   * Map a live ReasoningEngine into the EngineProfile shape the dashboard
   * expects. Returns `null` when the registry has no engine with that id.
   *
   * Used only as a fallback for engines registered AFTER the lifecycle
   * listener attached (rare — the listener auto-creates worker rows for
   * normal registrations). The id mirrors the worker convention so
   * `engineRegistry.selectById` can resolve either form.
   */
  private engineFromRegistry(id: string): EngineProfile | null {
    const engine = this.deps.engineRegistry?.get(id);
    if (!engine) return null;
    return {
      // Match the worker-id convention so the dashboard renders a stable
      // identifier across registry-only and worker-backed entries.
      id: workerIdForEngine(engine.id),
      config: {
        modelId: engine.id,
        temperature: 0,
        engineType: engine.engineType,
        capabilitiesDeclared: engine.capabilities,
        maxContextTokens: engine.maxContextTokens,
        tier: engine.tier,
      },
      status: 'active',
      // Real timestamp — UI's `timeAgo(createdAt)` would otherwise render
      // "55 years ago" for the epoch placeholder used previously.
      createdAt: Date.now(),
      demotionCount: 0,
    };
  }

  /**
   * Build the unified engine list surfaced via /api/v1/workers and
   * /api/v1/engines. Composition rules:
   *   1. For every live engine in the registry, find its corresponding
   *      worker profile in `workerStore`. The id mapping is
   *      `worker.id === "worker-" + engine.id` — see `autoRegisterWorkers`
   *      in factory.ts. We also fall back to matching by
   *      `worker.config.modelId === engine.id` so future id-scheme drift
   *      doesn't silently re-introduce duplicates.
   *   2. When a match is found, the worker entry wins — it carries the
   *      authoritative lifecycle status (probation/active/demoted),
   *      demotionCount, and createdAt. The registry contributes nothing
   *      not already on the worker.
   *   3. When no match exists (rare — engine registered AFTER
   *      autoRegisterWorkers ran, or registry-only engines like ephemeral
   *      test fixtures), synthesise a row from the registry with status
   *      'active'.
   *   4. Append historical worker rows whose engine is no longer in the
   *      live registry — useful for retrospective inspection of retired
   *      engines.
   *
   * Net effect: ONE row per engine. Dashboard shows the live roster on a
   * fresh server, with worker-derived status (correct fleet behaviour) and
   * no phantom duplicates.
   */
  private composeEngineList(): EngineListEntry[] {
    const historical = this.deps.workerStore?.findAll() ?? [];
    // Reverse-index by canonical engine id via the typed binding helper so
    // any future change to the prefix scheme propagates through one source
    // of truth (`engine-worker-binding.ts`) rather than ad-hoc string ops.
    const historicalByEngineId = new Map<string, EngineProfile>();
    for (const w of historical) {
      historicalByEngineId.set(engineIdFromWorker(w.id), w);
      // Belt-and-suspenders: also key by config.modelId so engines whose
      // worker id was minted under a different scheme still match.
      if (w.config.modelId && !historicalByEngineId.has(w.config.modelId)) {
        historicalByEngineId.set(w.config.modelId, w);
      }
    }

    const liveEngines = this.deps.engineRegistry?.listEngines() ?? [];
    const consumedWorkerIds = new Set<string>();
    const merged: EngineProfile[] = [];

    for (const engine of liveEngines) {
      const histEntry = historicalByEngineId.get(engine.id);
      if (histEntry) {
        merged.push(histEntry);
        consumedWorkerIds.add(histEntry.id);
      } else {
        const fromReg = this.engineFromRegistry(engine.id);
        if (fromReg) merged.push(fromReg);
      }
    }
    // Append retired/historical-only worker entries (no matching live engine).
    for (const w of historical) {
      if (!consumedWorkerIds.has(w.id)) merged.push(w);
    }
    return merged.map((worker) => this.withEngineStats(worker));
  }

  /**
   * Resolve worker stats with id-alias awareness.
   *
   * Traces written before the canonical `worker-${engine.id}` mapping
   * landed (or by code paths that still pass the bare engine id /
   * model id) live under different `worker_id` keys in
   * `execution_traces`. The dashboard previously displayed `Tasks=0`
   * for those rows even though the drilldown's recent-tasks list — fed
   * from the live task stream — clearly showed completed work.
   *
   * Lookup order (first non-empty wins; never sum aliases to avoid
   * double counting when both legacy and canonical ids exist):
   *   1. `worker.id` (canonical, e.g. `worker-openrouter/...`)
   *   2. `engineIdFromWorker(worker.id)` (bare engine id without prefix)
   *   3. `worker.config.modelId` (legacy traces keyed by model)
   *   4. `workerIdForEngine(worker.config.modelId)` (defensive — if the
   *      worker id was minted from a different scheme but model id
   *      matches an engine).
   */
  private withEngineStats(worker: EngineProfile): EngineListEntry {
    const store = this.deps.workerStore;
    if (!store) return worker;

    const candidates = new Set<string>();
    candidates.add(worker.id);
    candidates.add(engineIdFromWorker(worker.id));
    if (worker.config.modelId) {
      candidates.add(worker.config.modelId);
      candidates.add(workerIdForEngine(worker.config.modelId));
    }

    let stats: EngineStats | undefined;
    for (const id of candidates) {
      const candidate = store.getStats(id);
      if (candidate.totalTasks > 0) {
        stats = candidate;
        break;
      }
      if (!stats) stats = candidate; // fall back to a zero-stats payload
    }
    return stats ? { ...worker, stats } : worker;
  }

  private handleSessionClarifications(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'session not found' }, 404);
    const pending = (session as { pendingClarifications?: string[] }).pendingClarifications ?? [];
    return jsonResponse({
      sessionId,
      pendingClarifications: pending,
      status: session.status,
    });
  }

  // ── Shadow / Trace / Memory / Calibration / HMS ────────

  private handleListShadow(req: Request): Response {
    const store = this.deps.shadowStore;
    if (!store) {
      return jsonResponse({
        enabled: false,
        jobs: [],
        counts: { pending: 0, running: 0, done: 0, failed: 0 },
      });
    }
    const statusParam = new URL(req.url).searchParams.get('status') as 'pending' | 'running' | 'done' | 'failed' | null;
    const jobs = statusParam ? store.findByStatus(statusParam) : store.findPending();
    const counts = {
      pending: store.countByStatus('pending'),
      running: store.countByStatus('running'),
      done: store.countByStatus('done'),
      failed: store.countByStatus('failed'),
    };

    // Redact mutations content (may be huge); expose file list + size only
    const compact = jobs.map((j) => ({
      id: j.id,
      taskId: j.taskId,
      status: j.status,
      enqueuedAt: j.enqueuedAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      retryCount: j.retryCount,
      maxRetries: j.maxRetries,
      result: j.result,
      mutationCount: j.mutations?.length ?? 0,
      mutationFiles: (j.mutations ?? []).map((m) => m.file),
    }));

    return jsonResponse({ enabled: true, jobs: compact, counts });
  }

  private handleListTraces(req: Request): Response {
    const store = this.deps.traceStore;
    if (!store) return jsonResponse({ traces: [], count: 0 });

    const url = new URL(req.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 500);
    const outcome = url.searchParams.get('outcome');
    const taskType = url.searchParams.get('taskType');

    let traces: ExecutionTrace[];
    if (taskType) {
      traces = store.findByTaskType(taskType, limit);
    } else if (outcome) {
      traces = store.findByOutcome(outcome, limit);
    } else {
      traces = store.findRecent(limit);
    }

    return jsonResponse({
      traces,
      count: traces.length,
      total: store.count(),
    });
  }

  private async handleListMemory(): Promise<Response> {
    const workspace = this.deps.workspace;
    if (!workspace) {
      return jsonResponse({ error: 'workspace not configured' }, 503);
    }
    try {
      const { listPendingProposals, parseProposalFile } = await import('../orchestrator/memory/memory-proposals.ts');
      const pending = listPendingProposals(workspace);
      const proposals = pending.map((p) => {
        const parsed = parseProposalFile(p.content);
        return {
          filename: p.filename,
          path: p.path,
          slug: parsed?.slug ?? p.filename.replace(/\.md$/, ''),
          category: parsed?.category ?? null,
          confidence: parsed?.confidence ?? null,
          description: parsed?.description ?? null,
          content: p.content,
        };
      });
      return jsonResponse({ proposals });
    } catch (err) {
      return jsonResponse(
        {
          error: 'Failed to list memory proposals',
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  }

  private async handleMemoryApprove(req: Request): Promise<Response> {
    const workspace = this.deps.workspace;
    if (!workspace) return jsonResponse({ error: 'workspace not configured' }, 503);

    let body: { handle?: string; reviewer?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Request body must be JSON' }, 400);
    }

    if (!body.handle) return jsonResponse({ error: 'handle is required' }, 400);
    if (!body.reviewer) {
      return jsonResponse({ error: 'reviewer is required (A1 compliance: audit trail must name a human)' }, 400);
    }

    try {
      const { approveProposal } = await import('../orchestrator/memory/memory-proposals.ts');
      const result = approveProposal(workspace, body.handle, body.reviewer);
      this.deps.bus.emit('memory:approved', { recordId: body.handle });
      return jsonResponse({ approved: result.consumedPending, learnedPath: result.learnedPath });
    } catch (err) {
      return jsonResponse(
        {
          error: 'Approve failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
  }

  private async handleMemoryReject(req: Request): Promise<Response> {
    const workspace = this.deps.workspace;
    if (!workspace) return jsonResponse({ error: 'workspace not configured' }, 503);

    let body: { handle?: string; reviewer?: string; reason?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Request body must be JSON' }, 400);
    }

    if (!body.handle) return jsonResponse({ error: 'handle is required' }, 400);
    if (!body.reviewer) {
      return jsonResponse({ error: 'reviewer is required (audit trail must name a human)' }, 400);
    }
    if (!body.reason) {
      return jsonResponse({ error: 'reason is required (rejections must be explained)' }, 400);
    }

    try {
      const { rejectProposal } = await import('../orchestrator/memory/memory-proposals.ts');
      const result = rejectProposal(workspace, body.handle, body.reviewer, body.reason);
      this.deps.bus.emit('memory:rejected', { recordId: body.handle });
      return jsonResponse({ rejected: result.consumedPending, rejectedPath: result.rejectedPath });
    } catch (err) {
      return jsonResponse(
        {
          error: 'Reject failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
  }

  private handleCalibration(): Response {
    const ledger = this.deps.predictionLedger;
    if (!ledger) {
      return jsonResponse({
        enabled: false,
        traceCount: 0,
        recentBrierScores: [],
        averageBrier: null,
      });
    }
    const recentBrierScores = ledger.getRecentBrierScores(100);
    const averageBrier =
      recentBrierScores.length > 0 ? recentBrierScores.reduce((a, b) => a + b, 0) / recentBrierScores.length : null;
    return jsonResponse({
      enabled: true,
      traceCount: ledger.getTraceCount(),
      recentBrierScores,
      averageBrier,
    });
  }

  private async handleHMS(): Promise<Response> {
    // HMS is stateless — no store. Expose config + recent trace risk scores.
    const workspace = this.deps.workspace;
    let config: unknown = null;
    if (workspace) {
      try {
        const { loadConfig } = await import('../config/index.ts');
        const cfg = loadConfig(workspace);
        config = cfg.hms ?? null;
      } catch {
        /* best-effort */
      }
    }

    const traceStore = this.deps.traceStore;
    const recentTraces = traceStore?.findRecent(50) ?? [];
    // Surface traces with non-null risk scores + outcome
    const riskScored = recentTraces
      .filter((t) => typeof (t as { riskScore?: number }).riskScore === 'number')
      .map((t) => ({
        id: t.id,
        taskId: t.taskId,
        timestamp: t.timestamp,
        outcome: t.outcome,
        riskScore: (t as { riskScore?: number }).riskScore ?? null,
        approach: t.approach,
      }));

    const highRiskCount = riskScored.filter((t) => (t.riskScore ?? 0) >= 0.6).length;

    return jsonResponse({
      config,
      recentTraces: riskScored,
      summary: {
        totalAnalyzed: riskScored.length,
        highRiskCount,
        avgRisk:
          riskScored.length > 0 ? riskScored.reduce((acc, t) => acc + (t.riskScore ?? 0), 0) / riskScored.length : null,
      },
    });
  }

  // ── Doctor / Config / MCP Handlers (read-only) ──────────

  private async handleDoctor(req: Request): Promise<Response> {
    const workspace = this.deps.workspace;
    if (!workspace) {
      return jsonResponse({ error: 'workspace not configured' }, 503);
    }
    const deep = new URL(req.url).searchParams.get('deep') === 'true';
    const { runDoctorChecks, summarizeChecks } = await import('../cli/doctor.ts');
    const checks = await runDoctorChecks(workspace, { deep });
    const summary = summarizeChecks(checks);
    return jsonResponse({
      status: summary.status,
      timestamp: Date.now(),
      checks,
      summary: { passed: summary.passed, total: summary.total },
      deep,
    });
  }

  private async handleGetConfig(): Promise<Response> {
    const workspace = this.deps.workspace;
    if (!workspace) {
      return jsonResponse({ error: 'workspace not configured' }, 503);
    }
    try {
      const { loadConfig } = await import('../config/index.ts');
      const config = loadConfig(workspace);
      return jsonResponse({ config });
    } catch (err) {
      return jsonResponse(
        {
          error: 'Failed to load config',
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  }

  private async handleValidateConfig(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ valid: false, errors: [{ path: '', message: 'Request body is not valid JSON' }] }, 400);
    }
    const { VinyanConfigSchema } = await import('../config/schema.ts');
    const result = VinyanConfigSchema.safeParse(body);
    if (result.success) {
      return jsonResponse({ valid: true });
    }
    return jsonResponse({
      valid: false,
      errors: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  private async handleGetMCP(): Promise<Response> {
    const pool = this.deps.mcpClientPool;
    const workspace = this.deps.workspace;

    // Configured servers (from vinyan.json) — redact command for safety
    let configured: Array<{ name: string; trustLevel: string }> = [];
    if (workspace) {
      try {
        const { loadConfig } = await import('../config/index.ts');
        const config = loadConfig(workspace);
        const servers = config.network?.mcp?.client_servers ?? [];
        configured = servers.map((s) => ({
          name: s.name,
          trustLevel: s.trust_level,
        }));
      } catch {
        /* best-effort — missing config shouldn't break /mcp */
      }
    }

    if (!pool) {
      return jsonResponse({
        enabled: false,
        configured,
        servers: [],
      });
    }

    const connected = new Set(pool.listServers());
    let tools: Array<{ serverName: string; name: string; description?: string }> = [];
    try {
      const raw = await pool.listAllTools();
      tools = raw.map((t) => ({
        serverName: t.serverName,
        name: t.tool.name,
        description: t.tool.description,
      }));
    } catch {
      /* best-effort */
    }

    const servers = configured.map((c) => ({
      name: c.name,
      trustLevel: c.trustLevel,
      connected: connected.has(c.name),
      toolCount: tools.filter((t) => t.serverName === c.name).length,
    }));

    // Include connected servers that aren't in config (edge case)
    for (const name of connected) {
      if (!servers.find((s) => s.name === name)) {
        servers.push({
          name,
          trustLevel: 'unknown',
          connected: true,
          toolCount: tools.filter((t) => t.serverName === name).length,
        });
      }
    }

    return jsonResponse({ enabled: true, configured, servers, tools });
  }

  private handleSSE(taskId: string): Response {
    // Safety-net (5 min) registered inside the stream so a normal client
    // disconnect clears the timer instead of leaking it.
    let trackerSlot: (() => void) | null = null;
    const { stream, cleanup } = createSSEStream(this.deps.bus, taskId, {
      safetyTimeoutMs: 300_000,
      onClose: () => {
        if (trackerSlot) this.openSSECleanups.delete(trackerSlot);
      },
    });
    trackerSlot = cleanup;
    this.openSSECleanups.add(cleanup);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * GET /api/v1/tasks/:id/event-history
   *
   * Returns the persisted bus event log for a task in chronological order.
   * Powers the chat UI's "Process" card on past assistant messages — same
   * event shape that was streamed live via `/events` SSE, just replayed from
   * `task_events` storage. Supports `?since=<seq>` for incremental fetch.
   *
   * Returns 404 when no recorder is wired (no DB) — clients fall back to
   * showing only the trace summary in that case.
   */
  private handleTaskEventHistory(taskId: string, req: Request): Response {
    const store = this.deps.taskEventStore;
    if (!store) {
      return jsonResponse({ error: 'Event history disabled (no DB)' }, 404);
    }
    const url = new URL(req.url);
    const sinceParam = url.searchParams.get('since');
    const limitParam = url.searchParams.get('limit');
    const since = sinceParam !== null ? Math.max(0, parseInt(sinceParam, 10) || 0) : undefined;
    const limit = limitParam !== null ? Math.max(1, Math.min(5000, parseInt(limitParam, 10) || 0)) : undefined;
    const events = store.listForTask(taskId, { since, limit });
    const last = events.length > 0 ? events[events.length - 1] : undefined;
    return jsonResponse({
      taskId,
      events,
      // Convenience cursor for incremental polling.
      lastSeq: last ? last.seq : (since ?? 0),
    });
  }

  // ── Session Handlers ────────────────────────────────────

  private async handleCreateSession(req: Request): Promise<Response> {
    let body: { source?: string; title?: string | null; description?: string | null } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      // Empty / non-JSON body — keep defaults (matches the prior behavior
      // where create() ran with `body.source ?? 'api'` even on a missing body).
    }
    const session = this.deps.sessionManager.create(body.source ?? 'api', {
      title: body.title ?? null,
      description: body.description ?? null,
    });
    // G2: Emit session bus event
    this.deps.bus.emit('session:created', { sessionId: session.id, source: body.source ?? 'api' });
    return jsonResponse({ session }, 201);
  }

  private handleGetSession(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    return jsonResponse({ session });
  }

  private async handleUpdateSession(sessionId: string, req: Request): Promise<Response> {
    let body: { title?: string | null; description?: string | null } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const patch: { title?: string | null; description?: string | null } = {};
    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        return jsonResponse({ error: 'title must be string or null' }, 400);
      }
      if (typeof body.title === 'string' && body.title.length > 200) {
        return jsonResponse({ error: 'title must be 200 characters or fewer' }, 400);
      }
      patch.title = body.title;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return jsonResponse({ error: 'description must be string or null' }, 400);
      }
      if (typeof body.description === 'string' && body.description.length > 4000) {
        return jsonResponse({ error: 'description must be 4000 characters or fewer' }, 400);
      }
      patch.description = body.description;
    }
    if (patch.title === undefined && patch.description === undefined) {
      return jsonResponse({ error: 'At least one of title or description is required' }, 400);
    }
    const session = this.deps.sessionManager.updateMetadata(sessionId, patch);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    const fields: Array<'title' | 'description'> = [];
    if (patch.title !== undefined) fields.push('title');
    if (patch.description !== undefined) fields.push('description');
    this.deps.bus.emit('session:updated', { sessionId, fields });
    return jsonResponse({ session });
  }

  /**
   * Lifecycle transitions return a `LifecycleResult { applied, session, reason }`
   * envelope from SessionManager so we can map the three real outcomes to
   * distinct HTTP responses:
   *   - reason='not_found'     → 404 (no row at all)
   *   - reason='invalid_state' → 409 (e.g. archive-an-already-archived row)
   *   - applied=true           → 200 + bus event
   *
   * Without this, callers got a 200 even when nothing changed and bus
   * subscribers fired on phantom transitions.
   */
  private handleArchiveSession(sessionId: string): Response {
    const result = this.deps.sessionManager.archive(sessionId);
    if (result.reason === 'not_found') return jsonResponse({ error: 'Session not found' }, 404);
    if (result.reason === 'invalid_state') {
      return jsonResponse(
        { error: 'Session cannot be archived in its current state', session: result.session },
        409,
      );
    }
    this.deps.bus.emit('session:archived', { sessionId });
    return jsonResponse({ session: result.session });
  }

  private handleUnarchiveSession(sessionId: string): Response {
    const result = this.deps.sessionManager.unarchive(sessionId);
    if (result.reason === 'not_found') return jsonResponse({ error: 'Session not found' }, 404);
    if (result.reason === 'invalid_state') {
      return jsonResponse(
        { error: 'Session is not archived', session: result.session },
        409,
      );
    }
    this.deps.bus.emit('session:unarchived', { sessionId });
    return jsonResponse({ session: result.session });
  }

  private handleSoftDeleteSession(sessionId: string): Response {
    const result = this.deps.sessionManager.softDelete(sessionId);
    if (result.reason === 'not_found') return jsonResponse({ error: 'Session not found' }, 404);
    if (result.reason === 'invalid_state') {
      return jsonResponse(
        { error: 'Session is already in trash', session: result.session },
        409,
      );
    }
    this.deps.bus.emit('session:deleted', { sessionId });
    return jsonResponse({ session: result.session });
  }

  private handleRestoreSession(sessionId: string): Response {
    const result = this.deps.sessionManager.restore(sessionId);
    if (result.reason === 'not_found') return jsonResponse({ error: 'Session not found' }, 404);
    if (result.reason === 'invalid_state') {
      return jsonResponse(
        { error: 'Session is not in trash', session: result.session },
        409,
      );
    }
    this.deps.bus.emit('session:restored', { sessionId });
    return jsonResponse({ session: result.session });
  }

  /**
   * DELETE /api/v1/sessions/:id?permanent=true
   *
   * Hard-delete from Trash. Two-step flow (soft → hard) is intentional:
   * a session must be trashed first; any other state returns 409 to prevent
   * one-click data loss. On success the row plus its tasks and turns are
   * gone forever — there is no Restore path after this point.
   */
  private handleHardDeleteSession(sessionId: string): Response {
    const result = this.deps.sessionManager.hardDelete(sessionId);
    if (result.reason === 'not_found') return jsonResponse({ error: 'Session not found' }, 404);
    if (result.reason === 'invalid_state') {
      return jsonResponse(
        {
          error: 'Session must be moved to trash before permanent delete',
          session: result.session,
        },
        409,
      );
    }
    this.deps.bus.emit('session:purged', { sessionId });
    return jsonResponse({ deleted: true, sessionId });
  }

  private handleCompactSession(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    const result = this.deps.sessionManager.compact(sessionId);
    // G2: Emit session compacted bus event
    this.deps.bus.emit('session:compacted', { sessionId, taskCount: result.statistics.totalTasks });
    return jsonResponse({ compaction: result });
  }

  // ── Conversational message endpoints (Agent Conversation) ─────
  //
  // POST /api/v1/sessions/:id/messages  — send a user message, run a task,
  //                                        return the TaskResult + pending
  //                                        clarifications.
  // GET  /api/v1/sessions/:id/messages  — list conversation history.
  //
  // These extend the Agent Conversation clarification protocol (see
  // docs/design/agent-conversation.md) from CLI-only to HTTP so web/mobile/
  // external clients can participate in multi-turn conversations with the
  // agent, including the input-required clarification round-trip.

  /**
   * POST /api/v1/sessions/:id/messages
   *
   * Mirrors chat.ts's rl.on('line') handler:
   *   1. Validate body + resolve session (404 if missing).
   *   2. Query getPendingClarifications(). If non-empty, the current
   *      message is treated as a clarification answer — the open questions
   *      and the user's free-form reply are packed into a single
   *      `CLARIFICATION_BATCH:<JSON>` constraint so the understanding
   *      pipeline sees the user's answer as first-class grounding (not a
   *      fresh intent), and the task's goal stays anchored to the original
   *      user request rather than being overwritten by the reply text.
   *   3. Record the user turn, dispatch executeTask, record the assistant
   *      turn, and return a structured response with both the TaskResult
   *      and the updated session state (including any NEW pending
   *      clarifications raised by this turn).
   *
   * Response shape on success (200):
   *   {
   *     session: { id, pendingClarifications: string[] },
   *     task:    TaskResult
   *   }
   *
   * Note: status='input-required' returns HTTP 200, not a 4xx — it's a
   * valid outcome requesting user input, not an error.
   */
  private async handleSessionMessage(sessionId: string, req: Request): Promise<Response> {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = VinyanAPIServer.SessionMessageSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: `Invalid request: ${parsed.error.message}` }, 400);
    }
    const { content, taskType, targetFiles, budget, showThinking, stream } = parsed.data;

    // W1 PR #1: resolve profile from body > X-Vinyan-Profile > server default.
    // Validation already ran on body.profile inside SessionMessageSchema, so
    // an error here can only originate from a bad header.
    const resolvedProfile = resolveRequestProfile(req, parsed.data, this.deps.defaultProfile);
    if ('error' in resolvedProfile) return jsonResponse({ error: resolvedProfile.error }, 400);

    // ── Dedup: reject identical messages within a short window ──
    // Prevents duplicate tasks when the UI retries on timeout or the
    // user double-clicks Send. Key = session+content hash, TTL = 60s.
    const dedupKey = `${sessionId}:${content}`;
    const now = Date.now();
    const lastSeen = this.recentMessageDedup.get(dedupKey);
    if (lastSeen && now - lastSeen < 60_000) {
      return jsonResponse({ error: 'Duplicate message — task already submitted' }, 409);
    }
    this.recentMessageDedup.set(dedupKey, now);
    // Evict old entries periodically (keep map from growing unbounded)
    if (this.recentMessageDedup.size > 500) {
      for (const [k, ts] of this.recentMessageDedup) {
        if (now - ts > 60_000) this.recentMessageDedup.delete(k);
      }
    }

    // Auto-detect clarification follow-up: if the last assistant message
    // was an [INPUT-REQUIRED] block and the user has not yet answered, this
    // new user message IS the answer. Pack the open questions + the user's
    // free-form reply into a single CLARIFICATION_BATCH constraint so
    // agent-worker-entry's buildInitUserMessage renders them in the
    // "## User Clarifications" section of the next task's init prompt —
    // and anchor the task goal to the original user request (walking back
    // through any prior clarification rounds) rather than overwriting it
    // with the short reply text.
    const pendingBefore = this.deps.sessionManager.getPendingClarifications(sessionId);
    const originalGoal = pendingBefore.length > 0 ? this.deps.sessionManager.getOriginalTaskGoal(sessionId) : null;
    const clarificationConstraints =
      pendingBefore.length > 0
        ? [
            `CLARIFICATION_BATCH:${JSON.stringify({
              questions: pendingBefore,
              reply: content,
            })}`,
          ]
        : [];

    // Record the user turn BEFORE dispatching the task so the
    // conversation history (loaded by core-loop.ts via sessionManager)
    // includes it.
    this.deps.sessionManager.recordUserTurn(sessionId, content);

    // Auto-name session from the first user message if no title was set.
    // We use task count rather than turn count because a clarification
    // round counts as a turn but not a task — re-naming on a follow-up
    // would feel surprising. The truncated single-line title is a cheap
    // deterministic placeholder; the user can edit it inline at any time
    // from the chat header. Failures here are non-fatal: titling is a
    // convenience, not a correctness path.
    let effectiveSessionTitle = session.title;
    if (!effectiveSessionTitle && session.taskCount === 0) {
      const derived = deriveSessionTitle(content);
      if (derived) {
        try {
          const updated = this.deps.sessionManager.updateMetadata(sessionId, { title: derived });
          if (updated) {
            effectiveSessionTitle = updated.title;
            this.deps.bus.emit('session:updated', {
              sessionId,
              fields: ['title'],
            });
          }
        } catch (err) {
          // Swallow — auto-naming must never block message handling.
          console.warn('[server] auto-name session failed', err);
        }
      }
    }

    // Infer taskType when the client didn't specify: code if targetFiles
    // present, otherwise reasoning (matching chat.ts).
    const inferredType: 'code' | 'reasoning' = taskType ?? (targetFiles?.length ? 'code' : 'reasoning');

    // Operator-supplied session metadata reaches the agent as a strictly
    // auxiliary SESSION_CONTEXT pipeline constraint. The agent worker
    // renders it as a `## Session Context` XML block (see
    // src/orchestrator/agent/agent-worker-entry.ts). We do NOT mutate
    // input.goal and do not feed this into routing/governance \u2014 it is
    // grounding only (A1, A3).
    const sessionContextConstraints: string[] = [];
    if (effectiveSessionTitle || session.description) {
      const payload: { title?: string; description?: string } = {};
      if (effectiveSessionTitle) payload.title = effectiveSessionTitle;
      if (session.description) payload.description = session.description;
      sessionContextConstraints.push(`SESSION_CONTEXT:${JSON.stringify(payload)}`);
    }

    const constraints: string[] = [
      ...(showThinking ? ['THINKING:enabled'] : []),
      ...sessionContextConstraints,
      ...clarificationConstraints,
    ];

    const input: TaskInput = {
      id: crypto.randomUUID(),
      source: 'api',
      goal: originalGoal ?? content,
      taskType: inferredType,
      sessionId,
      profile: resolvedProfile.profile,
      ...(targetFiles?.length ? { targetFiles } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      budget: budget ?? DEFAULT_TASK_BUDGET,
    };

    // Track in session_tasks for audit / observability (mirrors handleSyncTask).
    this.deps.sessionManager.addTask(sessionId, input);

    // ── Streaming path (OpenAI-style SSE) ─────────────────────
    //
    // When `stream: true`, return a text/event-stream response that
    // forwards per-phase bus events filtered by this task's id. The
    // client sees real-time progress and the stream auto-closes when
    // the orchestrator emits `task:complete` at the end of the task
    // (see createSSEStream in src/api/sse.ts).
    //
    // Critical ordering: createSSEStream MUST run BEFORE executeTask
    // so the ReadableStream.start() callback (which subscribes to the
    // bus synchronously per WHATWG spec) is called before any events
    // fire. Once the subscribers are attached, kicking off executeTask
    // is safe — events emitted during the pipeline will be captured
    // and delivered to the client.
    if (stream === true) {
      // Safety-net for chat-style tasks managed inside the stream itself.
      // Long agentic workflows can legitimately run longer than the default
      // per-task budget because they execute multiple LLM steps; keep this
      // comfortably above the workflow ceiling so a healthy stream does not
      // close moments before task:complete.
      const sseSafetyTimeoutMs = Math.max(900_000, input.budget.maxDurationMs * 6);
      let trackerSlot: (() => void) | null = null;
      const { stream: sseStream, cleanup } = createSSEStream(this.deps.bus, input.id, {
        safetyTimeoutMs: sseSafetyTimeoutMs,
        onClose: () => {
          if (trackerSlot) this.openSSECleanups.delete(trackerSlot);
        },
      });
      trackerSlot = cleanup;
      this.openSSECleanups.add(cleanup);

      // Kick off executeTask WITHOUT awaiting so we can return the stream
      // Response immediately. The .then handler records the assistant
      // turn and completes the session task; the .catch handler recovers
      // from unexpected throws by synthesizing a failed result and
      // manually emitting task:complete to close the stream (real
      // executeTask would normally emit this itself, but a bare throw
      // bypasses the normal emit path).
      this.deps
        .executeTask(input)
        .then((result) => {
          this.deps.sessionManager.completeTask(sessionId, input.id, result);
          this.deps.sessionManager.recordAssistantTurn(sessionId, input.id, result);
        })
        .catch((err) => {
          const failedResult: TaskResult = {
            id: input.id,
            status: 'failed',
            mutations: [],
            trace: {
              id: `trace-${input.id}-stream-error`,
              taskId: input.id,
              timestamp: Date.now(),
              routingLevel: 0,
              approach: 'stream-error',
              oracleVerdicts: {},
              modelUsed: 'unknown',
              tokensConsumed: 0,
              durationMs: 0,
              outcome: 'failure',
              affectedFiles: [],
              failureReason: err instanceof Error ? err.message : String(err),
            } as TaskResult['trace'],
            escalationReason: err instanceof Error ? err.message : String(err),
          };
          try {
            this.deps.sessionManager.completeTask(sessionId, input.id, failedResult);
            this.deps.sessionManager.recordAssistantTurn(sessionId, input.id, failedResult);
          } catch {
            // Session recording is best-effort during error recovery
          }
          // Emit a manual task:complete so the stream closes cleanly.
          // createSSEStream's auto-close handler fires on the first
          // task:complete seen for this task id, so no risk of a double
          // close if the real pipeline had already emitted one.
          this.deps.bus.emit('task:complete', { result: failedResult });
        });

      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }

    // ── Sync path (default) ──────────────────────────────────
    let result: TaskResult;
    try {
      result = await this.deps.executeTask(input);
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : 'Task execution failed' }, 500);
    }
    this.deps.sessionManager.completeTask(sessionId, input.id, result);
    // Record the assistant turn — for status='input-required' this writes
    // a structured [INPUT-REQUIRED] block that the NEXT call's
    // getPendingClarifications will pick up.
    this.deps.sessionManager.recordAssistantTurn(sessionId, input.id, result);

    // Compute the new pending state AFTER recording. If the task returned
    // input-required, this will be non-empty and mirror
    // result.clarificationNeeded — clients can display either.
    const pendingAfter = this.deps.sessionManager.getPendingClarifications(sessionId);

    return jsonResponse({
      session: {
        id: sessionId,
        pendingClarifications: pendingAfter,
      },
      task: result,
    });
  }

  /**
   * GET /api/v1/sessions/:id/messages
   *
   * Lists the conversation history for a session as an ordered array of
   * entries (user + assistant). Supports `?limit=N` to cap the number of
   * most-recent messages returned (omit for all).
   */
  private handleListSessionMessages(sessionId: string, req: Request): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 0)) : undefined;

    // Use a generous token budget so we return entries verbatim, not the
    // compacted summary. Clients that want compaction should call the
    // separate POST /api/v1/sessions/:id/compact endpoint.
    //
    // `getConversationHistoryDetailed` is a superset of the legacy text
    // view: every field on the old shape is preserved, with optional
    // `thinking`, `toolsUsed`, and `traceSummary` fields added so the
    // chat UI can render historical process cards without re-fetching the
    // trace.
    const history = this.deps.sessionManager.getConversationHistoryDetailed(sessionId, 1_000_000);
    const messages = limit !== undefined ? history.slice(-limit) : history;
    const pendingClarifications = this.deps.sessionManager.getPendingClarifications(sessionId);

    return jsonResponse({
      session: { id: sessionId, pendingClarifications },
      messages,
    });
  }

  /**
   * GET /api/v1/sessions/:id/stream
   *
   * Long-lived SSE stream scoped to a single session. Unlike the per-task
   * stream variant of POST /messages, this stays open across multiple
   * task turns within the session and emits events for every task that
   * runs under `sessionId`. Useful for web/mobile clients that want one
   * persistent connection for all conversation activity.
   *
   * Behavior:
   *   - Returns JSON 404 if the session does not exist (NOT an empty SSE
   *     stream — clients want a clear error signal before they set up
   *     EventSource listeners).
   *   - Emits an initial `session:stream_open` event so clients know
   *     the subscription is live.
   *   - Tracks session task membership via `task:start` events
   *     (filtered by `payload.input.sessionId === sessionId`).
   *   - Forwards per-task events (task:complete, phase:timing,
   *     agent:clarification_requested, etc.) for tasks in the
   *     membership set.
   *   - Emits SSE comment-line heartbeats (`:heartbeat <ts>\n\n`) every
   *     30 seconds to keep idle connections alive.
   *   - Auto-cleanup after 60 minutes safety-net (long-enough for
   *     extended conversations but bounded to prevent bus leaks).
   */
  private handleSessionStream(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);

    // 60-minute safety-net registered inside the stream — cleared on
    // client disconnect so a healthy connection does not leak the timer.
    let trackerSlot: (() => void) | null = null;
    const { stream, cleanup } = createSessionSSEStream(this.deps.bus, sessionId, {
      safetyTimeoutMs: 3_600_000,
      onClose: () => {
        if (trackerSlot) this.openSSECleanups.delete(trackerSlot);
      },
    });
    trackerSlot = cleanup;
    this.openSSECleanups.add(cleanup);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // ── Default session helper (G4) ────────────────────────

  private getOrCreateDefaultSession(): Session {
    if (this.defaultSessionId) {
      const existing = this.deps.sessionManager.get(this.defaultSessionId);
      if (existing) return existing;
    }
    const session = this.deps.sessionManager.create('api');
    this.defaultSessionId = session.id;
    return session;
  }

  // ── Graceful Shutdown (TDD §22.7) ──────────────────────

  async stop(deadlineMs = 30_000): Promise<void> {
    this.shuttingDown = true;
    console.log('[vinyan-api] Shutting down...');

    // 1. Stop accepting — handled by shuttingDown flag (returns 503)

    // 2. Drain in-flight tasks
    if (this.inFlightTasks.size > 0) {
      console.log(`[vinyan-api] Draining ${this.inFlightTasks.size} in-flight tasks...`);
      const drainPromise = Promise.allSettled([...this.inFlightTasks.values()].map((t) => t.promise));
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, deadlineMs));
      await Promise.race([drainPromise, timeout]);
    }

    // 3. Persist sessions
    const suspended = this.deps.sessionManager.suspendAll();
    if (suspended > 0) {
      console.log(`[vinyan-api] Suspended ${suspended} active sessions`);
    }

    // 4. Stop background sweepers and clear pending eviction timers so
    //    the process can exit cleanly under graceful shutdown.
    if (this.rateLimiterPruneInterval) {
      clearInterval(this.rateLimiterPruneInterval);
      this.rateLimiterPruneInterval = null;
    }
    for (const timer of this.asyncResultsEviction.values()) clearTimeout(timer);
    this.asyncResultsEviction.clear();

    // 5. Detach all open SSE bus subscribers BEFORE closing the server.
    //    Without this, listeners outlive the connection because Bun's
    //    forced socket close does not always fire ReadableStream.cancel
    //    synchronously, leaving handlers attached to the bus and
    //    keeping the event loop alive.
    if (this.openSSECleanups.size > 0) {
      console.log(`[vinyan-api] Closing ${this.openSSECleanups.size} open SSE stream(s)...`);
      const cleanups = [...this.openSSECleanups];
      this.openSSECleanups.clear();
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* best-effort */
        }
      }
    }

    // 6. Close any still-open WebSocket clients.
    if (this.wsClients.size > 0) {
      console.log(`[vinyan-api] Closing ${this.wsClients.size} WebSocket client(s)...`);
      for (const client of this.wsClients) {
        try {
          (client.ws as { close?: () => void }).close?.();
        } catch {
          /* best-effort */
        }
      }
      this.wsClients.clear();
    }

    // 7. Force-close any remaining TCP connections. Without `true`,
    //    Bun.serve.stop() waits indefinitely for long-lived SSE/WS to
    //    drain — which they never do on their own — so Ctrl+C appears
    //    to "do nothing".
    this.server?.stop(true);
    this.server = null;

    console.log('[vinyan-api] Shutdown complete');
  }

  getPort(): number {
    return this.config.port;
  }

  isRunning(): boolean {
    return this.server !== null && !this.shuttingDown;
  }
}

// ── Helpers ─────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Derive a short, single-line title from a free-form user message.
 * Used by `handleSessionMessage` to auto-name fresh sessions on the
 * first task. Operators can override the result via PATCH /sessions/:id.
 *
 * Rules:
 *   - Collapse all whitespace (newlines, tabs) into single spaces.
 *   - Drop common imperative prefixes ("please", "help me", etc.) for a
 *     tighter label, but only when they appear at the start.
 *   - Hard cap at 60 characters; cut on a word boundary if possible.
 *   - Returns `null` for empty / whitespace-only input so the caller
 *     can skip the update entirely.
 */
function deriveSessionTitle(content: string): string | null {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  let stripped = collapsed.replace(
    /^(please|pls|kindly|could you|can you|would you|help me|i need to|i want to|let's|lets)\s+/i,
    '',
  );
  if (!stripped) stripped = collapsed;
  // Title-case the first letter for visual polish; do not touch the rest
  // (preserves identifiers, code, etc.).
  stripped = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  const MAX = 60;
  if (stripped.length <= MAX) return stripped;
  const slice = stripped.slice(0, MAX);
  const lastSpace = slice.lastIndexOf(' ');
  // Cut on a word boundary when one is reasonably close to the limit;
  // otherwise hard-cut and append an ellipsis so the truncation is
  // visually obvious.
  if (lastSpace > MAX * 0.6) return `${slice.slice(0, lastSpace)}…`;
  return `${slice}…`;
}

const DEFAULT_TASK_BUDGET = {
  maxTokens: 50_000,
  maxDurationMs: 180_000,
  maxRetries: 3,
} as const;

function buildTaskInput(partial: Partial<TaskInput>, profile?: string): TaskInput {
  return {
    id: partial.id ?? crypto.randomUUID(),
    source: 'api',
    goal: partial.goal ?? '',
    taskType: partial.taskType ?? (partial.targetFiles?.length ? 'code' : 'reasoning'),
    targetFiles: partial.targetFiles,
    constraints: partial.constraints,
    ...(profile !== undefined ? { profile } : partial.profile !== undefined ? { profile: partial.profile } : {}),
    budget: partial.budget ?? DEFAULT_TASK_BUDGET,
    acceptanceCriteria: partial.acceptanceCriteria,
  };
}

/**
 * Resolve the profile for an incoming HTTP request.
 *
 * Precedence: `body.profile` > `X-Vinyan-Profile` header > server default
 * (> `'default'` when the server default is unset). Returns `{ profile }`
 * on success or `{ error }` with a 400-appropriate message on invalid
 * input — callers surface the error as a JSON response and MUST NOT
 * dispatch the task.
 */
export function resolveRequestProfile(
  req: Request,
  body: unknown,
  fallbackDefault?: string,
): { profile: string } | { error: string } {
  // Header (case-insensitive per RFC 7230 — Headers.get handles this).
  const headerValue = req.headers.get('x-vinyan-profile') ?? undefined;
  const bodyValue =
    body !== null && typeof body === 'object' && 'profile' in body
      ? (body as { profile?: unknown }).profile
      : undefined;

  // Body wins over header. Either must pass validation.
  if (bodyValue !== undefined) {
    if (!isValidProfileName(bodyValue)) {
      return { error: `Invalid profile name in body: ${String(bodyValue)}` };
    }
    return { profile: bodyValue };
  }
  if (headerValue !== undefined && headerValue.length > 0) {
    if (!isValidProfileName(headerValue)) {
      return { error: `Invalid profile name in X-Vinyan-Profile header: ${headerValue}` };
    }
    return { profile: headerValue };
  }
  return { profile: fallbackDefault ?? 'default' };
}

/** Extract taskId from API path like /api/v1/tasks/:id */
function extractTaskId(path: string): string | undefined {
  const match = path.match(/^\/api\/v1\/tasks\/([^/]+)/);
  return match?.[1];
}

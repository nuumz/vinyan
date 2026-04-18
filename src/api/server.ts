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

import type { A2AManagerImpl } from '../a2a/a2a-manager.ts';
import { A2ABridge } from '../a2a/bridge.ts';
import type { VinyanBus } from '../core/bus.ts';
import type { RuleStore } from '../db/rule-store.ts';
import type { TraceStore } from '../db/trace-store.ts';
import type { WorkerStore } from '../db/worker-store.ts';
import type { MetricsCollector } from '../observability/metrics.ts';
import { getSystemMetrics } from '../observability/metrics.ts';
import { renderPrometheus } from '../observability/prometheus.ts';
import type { TaskInput, TaskResult } from '../orchestrator/types.ts';
import { createAuthMiddleware, requiresAuth } from '../security/auth.ts';
import type { RunOracleOptions } from '../oracle/runner.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import { classifyEndpoint, RateLimiter } from './rate-limiter.ts';
import { z } from 'zod/v4';
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
  ruleStore?: RuleStore;
  workerStore?: WorkerStore;
  worldGraph?: WorldGraph;
  metricsCollector?: MetricsCollector;
  a2aManager?: A2AManagerImpl;
  /** Oracle runner for WebSocket ECP endpoint (PH5.18). */
  runOracle?: (oracleName: string, hypothesis: unknown, options?: RunOracleOptions) => Promise<unknown>;
  /** Economy stores for /api/v1/economy endpoint. */
  costLedger?: { getAggregatedCost(window: string): { total_usd: number; count: number }; count(): number };
  budgetEnforcer?: { checkBudget(): Array<{ window: string; spent_usd: number; limit_usd: number; utilization_pct: number; enforcement: string; exceeded: boolean }> };
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
}

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
   * Cleanups for currently-open SSE streams. Populated via each SSE
   * handler's `onClose` callback; auto-deregistered when the stream
   * closes. stop() invokes all remaining entries so bus listeners
   * detach deterministically before the TCP listener is torn down.
   */
  private openSSECleanups = new Set<() => void>();
  private shuttingDown = false;
  private a2aBridge: A2ABridge;
  private defaultSessionId: string | null = null;
  private wsClients = new Set<{ ws: unknown; authenticated: boolean }>();
  /** Dedup map: key = "sessionId:content" → timestamp of last submission. */
  private recentMessageDedup = new Map<string, number>();
  /** Async result retention before eviction. Bounded for memory; generous enough for typical polling patterns. */
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
          self.handleWebSocketMessage(ws, typeof message === 'string' ? message : new TextDecoder().decode(message), client);
        },
        close(ws) {
          const client = (ws as unknown as { data: { client: object } }).data?.client;
          if (client) self.wsClients.delete(client as { ws: unknown; authenticated: boolean });
        },
      },
    });

    // Periodic eviction of idle rate-limit buckets so the per-key map
    // does not grow unbounded across long server uptimes. unref() so
    // this sweeper never holds the process alive on its own.
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

    // ── Sessions ──────────────────────────────────────────
    if (method === 'GET' && path === '/api/v1/sessions') {
      return this.handleListSessions();
    }

    if (method === 'POST' && path === '/api/v1/sessions') {
      return this.handleCreateSession(req);
    }

    if (method === 'GET' && path.match(/^\/api\/v1\/sessions\/[^/]+$/)) {
      const sessionId = path.split('/').pop()!;
      return this.handleGetSession(sessionId);
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
      const workers = this.deps.workerStore?.findAll() ?? [];
      return jsonResponse({ workers });
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
      const id = path.split('/').pop()!;
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
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Invalid request: ${parsed.error.message}` } }));
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
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Missing oracle_name or hypothesis' } }),
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
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Oracle runner not configured' } }),
        );
      }
      return;
    }

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } }));
  }

  // ── Task Handlers ───────────────────────────────────────

  // G4: Track tasks in sessions
  private async handleSyncTask(req: Request): Promise<Response> {
    const body = (await req.json()) as Partial<TaskInput>;
    const input = buildTaskInput(body);

    const session = this.getOrCreateDefaultSession();
    this.deps.sessionManager.addTask(session.id, input);

    const result = await this.deps.executeTask(input);

    this.deps.sessionManager.completeTask(session.id, input.id, result);
    return jsonResponse({ result });
  }

  private async handleAsyncTask(req: Request): Promise<Response> {
    const body = (await req.json()) as Partial<TaskInput>;
    const input = buildTaskInput(body);

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
    const tasks: Array<{ taskId: string; status: string; result?: unknown }> = [];
    for (const [id, result] of this.asyncResults) {
      tasks.push({ taskId: id, status: 'completed', result });
    }
    for (const [id] of this.inFlightTasks) {
      tasks.push({ taskId: id, status: 'running' });
    }
    return jsonResponse({ tasks });
  }

  private handleListSessions(): Response {
    const sessions = this.deps.sessionManager?.listSessions() ?? [];
    return jsonResponse({ sessions });
  }

  private handleGlobalSSE(): Response {
    // 60-minute safety-net is registered inside the stream so it
    // clears on client disconnect (via cancel → cleanup → onClose).
    // The external setTimeout pattern it replaces leaked timer
    // handles for the full 60 min on every healthy disconnect.
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
    // Check completed results
    const result = this.asyncResults.get(taskId);
    if (result) {
      return jsonResponse({ taskId, status: 'completed', result });
    }

    // Check in-flight
    if (this.inFlightTasks.has(taskId)) {
      return jsonResponse({ taskId, status: 'running' });
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
      : [
          ...store.findByStatus('active'),
          ...store.findByStatus('probation'),
          ...store.findByStatus('demoted'),
        ];

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

    const statusParam = new URL(req.url).searchParams.get('status') as
      | 'active'
      | 'probation'
      | 'retired'
      | null;

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
    const ledger = this.deps.costLedger as
      | { queryByTimeRange?: (from: number, to: number) => unknown[] }
      | undefined;
    if (!ledger?.queryByTimeRange) return jsonResponse({ entries: [] });
    const limit = Math.min(
      parseInt(new URL(req.url).searchParams.get('limit') ?? '100', 10) || 100,
      500,
    );
    const since = Date.now() - 7 * 24 * 3600 * 1000; // last 7 days
    const all = ledger.queryByTimeRange(since, Date.now()) as Array<{ timestamp: number }>;
    const sorted = [...all].sort((a, b) => b.timestamp - a.timestamp);
    return jsonResponse({ entries: sorted.slice(0, limit), total: all.length });
  }

  private handleGetEngine(id: string): Response {
    const worker = this.deps.workerStore?.findById(id);
    if (!worker) return jsonResponse({ error: `engine '${id}' not found` }, 404);

    const capModel = this.deps.capabilityModel;
    const capabilities = capModel?.getWorkerCapabilities(id) ?? [];

    const trustStore = this.deps.providerTrustStore;
    const providerTrust =
      trustStore && worker.config.modelId
        ? trustStore.getProvider(worker.config.modelId.split('/')[0] ?? worker.config.modelId)
        : null;

    return jsonResponse({ worker, capabilities, providerTrust });
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
    const statusParam = new URL(req.url).searchParams.get('status') as
      | 'pending'
      | 'running'
      | 'done'
      | 'failed'
      | null;
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

    let traces;
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
      const { listPendingProposals, parseProposalFile } = await import(
        '../orchestrator/memory/memory-proposals.ts'
      );
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
      return jsonResponse(
        { error: 'reviewer is required (A1 compliance: audit trail must name a human)' },
        400,
      );
    }

    try {
      const { approveProposal } = await import('../orchestrator/memory/memory-proposals.ts');
      const result = approveProposal(workspace, body.handle, body.reviewer);
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
      recentBrierScores.length > 0
        ? recentBrierScores.reduce((a, b) => a + b, 0) / recentBrierScores.length
        : null;
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
          riskScored.length > 0
            ? riskScored.reduce((acc, t) => acc + (t.riskScore ?? 0), 0) / riskScored.length
            : null,
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

  // ── Session Handlers ────────────────────────────────────

  private async handleCreateSession(req: Request): Promise<Response> {
    const body = (await req.json()) as { source?: string };
    const session = this.deps.sessionManager.create(body.source ?? 'api');
    // G2: Emit session bus event
    this.deps.bus.emit('session:created', { sessionId: session.id, source: body.source ?? 'api' });
    return jsonResponse({ session }, 201);
  }

  private handleGetSession(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    return jsonResponse({ session });
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
   *      message is treated as a clarification answer — each open question
   *      is wrapped into a `CLARIFIED:<q>=><answer>` constraint so the
   *      understanding pipeline sees the user's answer as first-class
   *      grounding (not a fresh intent).
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
    // new user message IS the answer. Wrap each open question as a
    // CLARIFIED:<q>=><answer> constraint so agent-worker-entry's
    // buildInitUserMessage renders them in the "## User Clarifications"
    // section of the next task's init prompt.
    const pendingBefore = this.deps.sessionManager.getPendingClarifications(sessionId);
    const clarificationConstraints = pendingBefore.map((q) => `CLARIFIED:${q}=>${content}`);

    // Record the user turn BEFORE dispatching the task so the
    // conversation history (loaded by core-loop.ts via sessionManager)
    // includes it.
    this.deps.sessionManager.recordUserTurn(sessionId, content);

    // Infer taskType when the client didn't specify: code if targetFiles
    // present, otherwise reasoning (matching chat.ts).
    const inferredType: 'code' | 'reasoning' =
      taskType ?? (targetFiles?.length ? 'code' : 'reasoning');

    const constraints: string[] = [
      ...(showThinking ? ['THINKING:enabled'] : []),
      ...clarificationConstraints,
    ];

    const input: TaskInput = {
      id: crypto.randomUUID(),
      source: 'api',
      goal: content,
      taskType: inferredType,
      sessionId,
      ...(targetFiles?.length ? { targetFiles } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      budget: budget ?? {
        maxTokens: 50_000,
        maxDurationMs: 120_000,
        maxRetries: 3,
      },
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
      // Safety-net (10 min) registered inside the stream. It is
      // cleared in all normal exit paths: auto-close on task:complete,
      // client cancel, or explicit cleanup(). onClose keeps the API
      // tracker in sync so stop() can detach bus listeners.
      let trackerSlot: (() => void) | null = null;
      const { stream: sseStream, cleanup } = createSSEStream(this.deps.bus, input.id, {
        safetyTimeoutMs: 600_000,
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
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Task execution failed' },
        500,
      );
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
    const history = this.deps.sessionManager.getConversationHistory(sessionId, 1_000_000);
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

    // 4. Stop background sweepers and clear pending eviction timers
    //    so the event loop is free to exit.
    if (this.rateLimiterPruneInterval) {
      clearInterval(this.rateLimiterPruneInterval);
      this.rateLimiterPruneInterval = null;
    }
    for (const timer of this.asyncResultsEviction.values()) clearTimeout(timer);
    this.asyncResultsEviction.clear();
    this.recentMessageDedup.clear();

    // 5. Detach bus listeners from all open SSE streams BEFORE closing
    //    the TCP listener. If we rely on Bun's forced connection close
    //    to fire ReadableStream.cancel, listener removal becomes
    //    non-deterministic and the bus can end up holding refs that
    //    keep the event loop alive.
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
    //    Bun.serve.stop() waits for active connections to drain —
    //    long-lived SSE/WS never drain on their own, so the process
    //    would hang indefinitely (root cause of "Ctrl+C does nothing").
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

function buildTaskInput(partial: Partial<TaskInput>): TaskInput {
  return {
    id: partial.id ?? crypto.randomUUID(),
    source: 'api',
    goal: partial.goal ?? '',
    taskType: partial.taskType ?? (partial.targetFiles?.length ? 'code' : 'reasoning'),
    targetFiles: partial.targetFiles,
    constraints: partial.constraints,
    budget: partial.budget ?? {
      maxTokens: 50_000,
      maxDurationMs: 60_000,
      maxRetries: 3,
    },
    acceptanceCriteria: partial.acceptanceCriteria,
  };
}

/** Extract taskId from API path like /api/v1/tasks/:id */
function extractTaskId(path: string): string | undefined {
  const match = path.match(/^\/api\/v1\/tasks\/([^/]+)/);
  return match?.[1];
}

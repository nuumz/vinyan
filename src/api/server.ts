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
import { createSSEStream } from './sse.ts';

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
}

export class VinyanAPIServer {
  private server: BunServer | null = null;
  private auth: ReturnType<typeof createAuthMiddleware>;
  private rateLimiter: RateLimiter;
  private inFlightTasks = new Map<string, { promise: Promise<TaskResult>; cancel?: () => void }>();
  private asyncResults = new Map<string, TaskResult>();
  private shuttingDown = false;
  private a2aBridge: A2ABridge;
  private defaultSessionId: string | null = null;
  private wsClients = new Set<{ ws: unknown; authenticated: boolean }>();

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
    });
  }

  start(): void {
    const self = this;

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.bind,
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

    console.log(`[vinyan-api] Listening on ${this.config.bind}:${this.config.port}`);
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
    // ── Dashboard static files ───────────────────────────
    if (method === 'GET' && (path === '/dashboard' || path.startsWith('/dashboard/'))) {
      return this.serveDashboardFile(path);
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

    // ── Read-only queries ─────────────────────────────────
    if (method === 'GET' && path === '/api/v1/workers') {
      const workers = this.deps.workerStore?.findActive() ?? [];
      return jsonResponse({ workers });
    }

    if (method === 'GET' && path === '/api/v1/rules') {
      const rules = this.deps.ruleStore?.findByStatus('active') ?? [];
      return jsonResponse({ rules });
    }

    if (method === 'GET' && path === '/api/v1/facts') {
      return jsonResponse({ facts: [] }); // WorldGraph query — simplified for now
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

    const promise = this.deps.executeTask(input);
    this.inFlightTasks.set(input.id, { promise });

    promise
      .then((result) => {
        this.deps.sessionManager.completeTask(session.id, input.id, result);
        this.asyncResults.set(input.id, result);
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
    const { stream, cleanup } = createSSEStream(this.deps.bus);

    // Auto-cleanup after 10 minutes
    setTimeout(cleanup, 600_000);

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  private serveDashboardFile(path: string): Response {
    // Default to index.html
    let filePath = path === '/dashboard' || path === '/dashboard/' ? '/dashboard/index.html' : path;

    // Extract relative path within dashboard
    const relative = filePath.replace(/^\/dashboard\//, '');

    // Path traversal protection
    if (relative.includes('..') || relative.startsWith('/')) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }

    const resolved = `${import.meta.dir}/../dashboard/${relative}`;
    const file = Bun.file(resolved);

    // Content-Type mapping
    const ext = relative.split('.').pop() ?? '';
    const contentTypes: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      js: 'application/javascript; charset=utf-8',
      css: 'text/css; charset=utf-8',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
    };

    return new Response(file, {
      headers: { 'Content-Type': contentTypes[ext] ?? 'application/octet-stream' },
    });
  }

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

  private handleSSE(taskId: string): Response {
    const { stream, cleanup } = createSSEStream(this.deps.bus, taskId);

    // Auto-cleanup after 5 minutes
    setTimeout(cleanup, 300_000);

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

    // 4. Close server
    this.server?.stop();
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

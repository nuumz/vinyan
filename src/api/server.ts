/**
 * Vinyan API Server — HTTP API accepting tasks, streaming progress.
 *
 * Uses Bun.serve() — zero dependency. Manual routing.
 * Graceful shutdown per TDD §22.7.
 *
 * Source of truth: vinyan-tdd.md §22
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunServer = any;
import type { VinyanBus } from "../core/bus.ts";
import type { TaskInput, TaskResult } from "../orchestrator/types.ts";
import type { SessionManager, Session, CompactionResult } from "./session-manager.ts";
import { createAuthMiddleware, requiresAuth } from "../security/auth.ts";
import { RateLimiter, classifyEndpoint } from "./rate-limiter.ts";
import { createSSEStream } from "./sse.ts";
import type { TraceStore } from "../db/trace-store.ts";
import type { RuleStore } from "../db/rule-store.ts";
import type { WorkerStore } from "../db/worker-store.ts";
import type { WorldGraph } from "../world-graph/world-graph.ts";
import { A2ABridge } from "../a2a/bridge.ts";

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
}

export class VinyanAPIServer {
  private server: BunServer | null = null;
  private auth: ReturnType<typeof createAuthMiddleware>;
  private rateLimiter: RateLimiter;
  private inFlightTasks = new Map<string, { promise: Promise<TaskResult>; cancel?: () => void }>();
  private asyncResults = new Map<string, TaskResult>();
  private shuttingDown = false;
  private a2aBridge: A2ABridge;

  constructor(
    private config: APIServerConfig,
    private deps: APIServerDeps,
  ) {
    this.auth = createAuthMiddleware(config.tokenPath);
    this.rateLimiter = new RateLimiter();
    this.a2aBridge = new A2ABridge({
      executeTask: deps.executeTask,
      baseUrl: `http://${config.bind}:${config.port}`,
    });
  }

  start(): void {
    const self = this;

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.bind,
      async fetch(req) {
        return self.handleRequest(req);
      },
    });

    console.log(`[vinyan-api] Listening on ${this.config.bind}:${this.config.port}`);
  }

  private async handleRequest(req: Request): Promise<Response> {
    if (this.shuttingDown) {
      return jsonResponse({ error: "Server is shutting down" }, 503);
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Auth check (I15)
    if (this.config.authRequired && requiresAuth(method, path)) {
      const authCtx = this.auth.authenticate(req);
      if (!authCtx.authenticated) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      // Rate limiting
      if (this.config.rateLimitEnabled) {
        const category = classifyEndpoint(method, path);
        if (category) {
          const { allowed, retryAfterSeconds } = this.rateLimiter.check(
            authCtx.apiKey ?? "anonymous",
            category,
          );
          if (!allowed) {
            return jsonResponse(
              { error: "Rate limit exceeded" },
              429,
              { "Retry-After": String(retryAfterSeconds) },
            );
          }
        }
      }
    }

    try {
      return await this.route(method, path, req);
    } catch (err) {
      console.error("[vinyan-api] Unhandled error:", err);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  }

  private async route(method: string, path: string, req: Request): Promise<Response> {
    // ── Health & Metrics ──────────────────────────────────
    if (method === "GET" && path === "/api/v1/health") {
      return jsonResponse({ status: "ok", uptime_ms: process.uptime() * 1000 });
    }

    if (method === "GET" && path === "/api/v1/metrics") {
      return jsonResponse({ tasks_in_flight: this.inFlightTasks.size });
    }

    // ── Tasks ─────────────────────────────────────────────
    if (method === "POST" && path === "/api/v1/tasks") {
      return this.handleSyncTask(req);
    }

    if (method === "POST" && path === "/api/v1/tasks/async") {
      return this.handleAsyncTask(req);
    }

    if (method === "GET" && path.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
      const taskId = path.split("/").pop()!;
      return this.handleGetTask(taskId);
    }

    if (method === "DELETE" && path.match(/^\/api\/v1\/tasks\/[^/]+$/)) {
      const taskId = path.split("/").pop()!;
      return this.handleCancelTask(taskId);
    }

    if (method === "GET" && path.match(/^\/api\/v1\/tasks\/[^/]+\/events$/)) {
      const taskId = path.split("/")[4]!;
      return this.handleSSE(taskId);
    }

    // ── Sessions ──────────────────────────────────────────
    if (method === "POST" && path === "/api/v1/sessions") {
      return this.handleCreateSession(req);
    }

    if (method === "GET" && path.match(/^\/api\/v1\/sessions\/[^/]+$/)) {
      const sessionId = path.split("/").pop()!;
      return this.handleGetSession(sessionId);
    }

    if (method === "POST" && path.match(/^\/api\/v1\/sessions\/[^/]+\/compact$/)) {
      const sessionId = path.split("/")[4]!;
      return this.handleCompactSession(sessionId);
    }

    // ── Read-only queries ─────────────────────────────────
    if (method === "GET" && path === "/api/v1/workers") {
      const workers = this.deps.workerStore?.findActive() ?? [];
      return jsonResponse({ workers });
    }

    if (method === "GET" && path === "/api/v1/rules") {
      const rules = this.deps.ruleStore?.findByStatus("active") ?? [];
      return jsonResponse({ rules });
    }

    if (method === "GET" && path === "/api/v1/facts") {
      return jsonResponse({ facts: [] }); // WorldGraph query — simplified for now
    }

    // ── A2A Protocol (PH5.6) ────────────────────────────────
    if (method === "GET" && path === "/.well-known/agent.json") {
      return jsonResponse(this.a2aBridge.getAgentCard());
    }

    if (method === "POST" && path === "/a2a") {
      return this.handleA2ARequest(req);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  // ── A2A Handler ──────────────────────────────────────────

  private async handleA2ARequest(req: Request): Promise<Response> {
    const body = await req.json();
    const response = await this.a2aBridge.handleRequest(body);
    return jsonResponse(response); // JSON-RPC: errors are in response body, HTTP is always 200
  }

  // ── Task Handlers ───────────────────────────────────────

  private async handleSyncTask(req: Request): Promise<Response> {
    const body = await req.json() as Partial<TaskInput>;
    const input = buildTaskInput(body);

    const result = await this.deps.executeTask(input);
    return jsonResponse({ result });
  }

  private async handleAsyncTask(req: Request): Promise<Response> {
    const body = await req.json() as Partial<TaskInput>;
    const input = buildTaskInput(body);

    const promise = this.deps.executeTask(input);
    this.inFlightTasks.set(input.id, { promise });

    promise.then((result) => {
      this.asyncResults.set(input.id, result);
      this.inFlightTasks.delete(input.id);
    }).catch(() => {
      this.inFlightTasks.delete(input.id);
    });

    return jsonResponse({ taskId: input.id, status: "accepted" }, 202);
  }

  private handleGetTask(taskId: string): Response {
    // Check completed results
    const result = this.asyncResults.get(taskId);
    if (result) {
      return jsonResponse({ taskId, status: "completed", result });
    }

    // Check in-flight
    if (this.inFlightTasks.has(taskId)) {
      return jsonResponse({ taskId, status: "running" });
    }

    return jsonResponse({ error: "Task not found" }, 404);
  }

  private handleCancelTask(taskId: string): Response {
    const inFlight = this.inFlightTasks.get(taskId);
    if (inFlight) {
      inFlight.cancel?.();
      this.inFlightTasks.delete(taskId);
      return jsonResponse({ taskId, status: "cancelled" });
    }
    return jsonResponse({ error: "Task not found or already completed" }, 404);
  }

  private handleSSE(taskId: string): Response {
    const { stream, cleanup } = createSSEStream(this.deps.bus, taskId);

    // Auto-cleanup after 5 minutes
    setTimeout(cleanup, 300_000);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  // ── Session Handlers ────────────────────────────────────

  private async handleCreateSession(req: Request): Promise<Response> {
    const body = await req.json() as { source?: string };
    const session = this.deps.sessionManager.create(body.source ?? "api");
    return jsonResponse({ session }, 201);
  }

  private handleGetSession(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);
    return jsonResponse({ session });
  }

  private handleCompactSession(sessionId: string): Response {
    const session = this.deps.sessionManager.get(sessionId);
    if (!session) return jsonResponse({ error: "Session not found" }, 404);

    const result = this.deps.sessionManager.compact(sessionId);
    return jsonResponse({ compaction: result });
  }

  // ── Graceful Shutdown (TDD §22.7) ──────────────────────

  async stop(deadlineMs = 30_000): Promise<void> {
    this.shuttingDown = true;
    console.log("[vinyan-api] Shutting down...");

    // 1. Stop accepting — handled by shuttingDown flag (returns 503)

    // 2. Drain in-flight tasks
    if (this.inFlightTasks.size > 0) {
      console.log(`[vinyan-api] Draining ${this.inFlightTasks.size} in-flight tasks...`);
      const drainPromise = Promise.allSettled(
        [...this.inFlightTasks.values()].map((t) => t.promise),
      );
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

    console.log("[vinyan-api] Shutdown complete");
  }

  getPort(): number {
    return this.config.port;
  }

  isRunning(): boolean {
    return this.server !== null && !this.shuttingDown;
  }
}

// ── Helpers ─────────────────────────────────────────────────

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function buildTaskInput(partial: Partial<TaskInput>): TaskInput {
  return {
    id: partial.id ?? crypto.randomUUID(),
    source: "api",
    goal: partial.goal ?? "",
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

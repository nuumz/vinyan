/**
 * External Coding CLI HTTP routes — provider-neutral surface for the
 * `ExternalCodingCliController`. Mounts under `/api/v1/coding-cli/*`.
 *
 * Endpoints:
 *   GET  /api/v1/coding-cli/providers                       — capabilities + availability
 *   POST /api/v1/coding-cli/sessions                        — create interactive session
 *   GET  /api/v1/coding-cli/sessions                        — list active sessions
 *   GET  /api/v1/coding-cli/sessions/:id                    — get session detail
 *   POST /api/v1/coding-cli/sessions/:id/message            — send follow-up
 *   POST /api/v1/coding-cli/sessions/:id/approve            — approve pending request
 *   POST /api/v1/coding-cli/sessions/:id/reject             — reject pending request
 *   POST /api/v1/coding-cli/sessions/:id/cancel             — cancel session
 *   GET  /api/v1/coding-cli/sessions/:id/events             — event history (paginated)
 *   POST /api/v1/coding-cli/run                             — headless one-shot run
 */
import { z } from 'zod';
import type { ExternalCodingCliController } from '../orchestrator/external-coding-cli/index.ts';
import { CodingCliTaskSchema, PROVIDER_IDS } from '../orchestrator/external-coding-cli/types.ts';
import type { CodingCliStore } from '../db/coding-cli-store.ts';

export interface CodingCliRouteDeps {
  controller: ExternalCodingCliController;
  store?: CodingCliStore;
}

const SessionRequestSchema = z.object({
  task: CodingCliTaskSchema,
  providerId: z.enum(PROVIDER_IDS).optional(),
  /** When `true`, controller.runHeadless is used instead of starting interactive. */
  headless: z.boolean().default(false),
});

const FollowupMessageSchema = z.object({
  text: z.string().min(1),
});

const ApprovalDecisionSchema = z.object({
  taskId: z.string().min(1),
  requestId: z.string().min(1),
});

const CancelSchema = z.object({
  reason: z.string().optional(),
});

const HeadlessRunSchema = z.object({
  task: CodingCliTaskSchema,
  providerId: z.enum(PROVIDER_IDS).optional(),
});

export async function handleCodingCliRoute(
  method: string,
  path: string,
  req: Request,
  deps: CodingCliRouteDeps,
): Promise<Response | null> {
  if (!path.startsWith('/api/v1/coding-cli')) return null;
  const controller = deps.controller;

  // GET /api/v1/coding-cli/providers
  if (method === 'GET' && path === '/api/v1/coding-cli/providers') {
    const url = new URL(req.url);
    const refresh = url.searchParams.get('refresh') === '1';
    const detections = await controller.detectProviders(refresh);
    return jsonResponse({ providers: detections });
  }

  // POST /api/v1/coding-cli/run  (headless)
  if (method === 'POST' && path === '/api/v1/coding-cli/run') {
    const parsed = await safeParseBody(req, HeadlessRunSchema);
    if ('error' in parsed) return parsed.error;
    try {
      const outcome = await controller.runHeadless(parsed.data.task, parsed.data.providerId);
      return jsonResponse({
        sessionId: outcome.session.id,
        state: outcome.session.state(),
        claim: outcome.claim,
        verification: outcome.verification,
        changedFiles: outcome.session.changedFiles(),
      });
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
  }

  // POST /api/v1/coding-cli/sessions
  if (method === 'POST' && path === '/api/v1/coding-cli/sessions') {
    const parsed = await safeParseBody(req, SessionRequestSchema);
    if ('error' in parsed) return parsed.error;
    const { task, providerId, headless } = parsed.data;
    try {
      if (headless) {
        const outcome = await controller.runHeadless(task, providerId);
        return jsonResponse({
          sessionId: outcome.session.id,
          state: outcome.session.state(),
          claim: outcome.claim,
          verification: outcome.verification,
          mode: 'headless',
        });
      }
      const session = await controller.createSession(task, providerId);
      session.startInteractive();
      return jsonResponse({
        sessionId: session.id,
        state: session.state(),
        providerId: session.adapterId,
        capabilities: session.capabilities,
        mode: 'interactive',
      });
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, 500);
    }
  }

  // GET /api/v1/coding-cli/sessions
  if (method === 'GET' && path === '/api/v1/coding-cli/sessions') {
    const live = controller.listSessions().map((s) => ({
      id: s.id,
      taskId: s.task.taskId,
      providerId: s.adapterId,
      state: s.state(),
      capabilities: s.capabilities,
      filesChanged: s.changedFiles(),
      timings: s.timingsSnapshot(),
    }));
    const persisted = deps.store?.list() ?? [];
    return jsonResponse({ live, persisted });
  }

  const sessionMatch = path.match(/^\/api\/v1\/coding-cli\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    const sub = sessionMatch[2] ?? '';
    const session = controller.getSession(sessionId);

    // GET /api/v1/coding-cli/sessions/:id
    if (method === 'GET' && sub === '') {
      if (!session) {
        const persisted = deps.store?.get(sessionId);
        if (!persisted) return jsonResponse({ error: 'session not found' }, 404);
        return jsonResponse({ session: persisted });
      }
      return jsonResponse({
        id: session.id,
        taskId: session.task.taskId,
        providerId: session.adapterId,
        state: session.state(),
        capabilities: session.capabilities,
        filesChanged: session.changedFiles(),
        commandsRequested: session.commands(),
        result: session.result(),
        timings: session.timingsSnapshot(),
      });
    }

    if (!session && sub !== 'events') {
      return jsonResponse({ error: 'session not found' }, 404);
    }

    // POST .../message
    if (method === 'POST' && sub === 'message') {
      const parsed = await safeParseBody(req, FollowupMessageSchema);
      if ('error' in parsed) return parsed.error;
      const ok = await session!.sendMessage(parsed.data.text);
      return jsonResponse({ delivered: ok });
    }

    // POST .../approve | reject
    if (method === 'POST' && (sub === 'approve' || sub === 'reject')) {
      const parsed = await safeParseBody(req, ApprovalDecisionSchema);
      if ('error' in parsed) return parsed.error;
      const decision: 'approved' | 'rejected' = sub === 'approve' ? 'approved' : 'rejected';
      const ok = controller.resolveApproval(parsed.data.taskId, parsed.data.requestId, decision);
      return jsonResponse({ resolved: ok, decision });
    }

    // POST .../cancel
    if (method === 'POST' && sub === 'cancel') {
      const parsed = await safeParseBody(req, CancelSchema, { allowEmpty: true });
      if ('error' in parsed) return parsed.error;
      const ok = await controller.cancelSession(sessionId, parsed.data?.reason);
      return jsonResponse({ cancelled: ok });
    }

    // GET .../events
    if (method === 'GET' && sub === 'events') {
      if (!deps.store) {
        return jsonResponse({ error: 'event store not configured' }, 503);
      }
      const url = new URL(req.url);
      const since = url.searchParams.get('since');
      const limit = url.searchParams.get('limit');
      const events = deps.store.listEvents(sessionId, {
        since: since ? Number.parseInt(since, 10) : undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
      });
      return jsonResponse({ events });
    }
  }

  return null;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function safeParseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
  options: { allowEmpty?: boolean } = {},
): Promise<{ data: z.infer<T> } | { error: Response }> {
  let body: unknown;
  try {
    const text = await req.text();
    if (!text && options.allowEmpty) {
      const parsed = schema.safeParse({});
      if (!parsed.success) {
        return { error: jsonResponse({ error: 'empty body invalid', issues: parsed.error.issues }, 400) };
      }
      return { data: parsed.data };
    }
    body = text ? JSON.parse(text) : {};
  } catch {
    return { error: jsonResponse({ error: 'invalid JSON body' }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: jsonResponse({ error: 'request validation failed', issues: parsed.error.issues }, 400) };
  }
  return { data: parsed.data };
}

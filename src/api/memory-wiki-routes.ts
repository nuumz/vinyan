/**
 * Memory Wiki HTTP routes — read/write surface mounted under
 * `/api/v1/memory-wiki/*`.
 *
 * Endpoints:
 *   GET  /status                      — counts (sources/pages/lint findings)
 *   GET  /pages?profile=...           — list pages
 *   GET  /pages/:id                   — single page detail (incl. claims, edges)
 *   GET  /graph?center=ID&depth=N     — neighborhood graph
 *   POST /search                      — body { profile, query, types?, ... }
 *   POST /context-pack                — body: ContextPackRequest
 *   POST /ingest                      — body: { kind, body, provenance, ... }
 *   POST /lint                        — trigger lint pass
 *   POST /approve                     — body: { pageId, actor, reason? }   → promote draft → canonical
 *   POST /reject                      — body: { pageId, actor, reason }    → archive
 *
 * Routes are pure HTTP wrappers around the wiki subsystem — no business
 * logic lives here. All validation goes through the underlying writer/
 * retriever zod schemas.
 */
import { z } from 'zod/v4';
import type { MemoryWikiConsolidation } from '../memory/wiki/consolidation.ts';
import type { MemoryWikiIngestor } from '../memory/wiki/ingest.ts';
import type { MemoryWikiLint } from '../memory/wiki/lint.ts';
import type { PageWriter } from '../memory/wiki/page-writer.ts';
import type { MemoryWikiRetriever } from '../memory/wiki/retrieval.ts';
import type { MemoryWikiStore } from '../memory/wiki/store.ts';
import { ContextPackRequestSchema, SourceIngestInputSchema, WikiSearchOptsSchema } from '../memory/wiki/types.ts';

export interface MemoryWikiRouteDeps {
  readonly store: MemoryWikiStore;
  readonly writer: PageWriter;
  readonly retriever: MemoryWikiRetriever;
  readonly ingestor: MemoryWikiIngestor;
  readonly lint?: MemoryWikiLint;
  readonly consolidation?: MemoryWikiConsolidation;
}

const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  opts: WikiSearchOptsSchema,
});

const ApproveRequestSchema = z.object({
  pageId: z.string().min(1),
  actor: z.string().min(1),
  reason: z.string().max(500).optional(),
});

const RejectRequestSchema = z.object({
  pageId: z.string().min(1),
  actor: z.string().min(1),
  reason: z.string().min(1).max(500),
});

const LintRequestSchema = z.object({
  profile: z.string().min(1),
  limit: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
});

const ProfileQuerySchema = z.object({
  profile: z.string().min(1),
  limit: z.coerce.number().int().positive().optional(),
});

export async function handleMemoryWikiRoute(
  method: string,
  path: string,
  req: Request,
  deps: MemoryWikiRouteDeps,
): Promise<Response | null> {
  if (!path.startsWith('/api/v1/memory-wiki')) return null;

  // GET /status
  if (method === 'GET' && path === '/api/v1/memory-wiki/status') {
    const url = new URL(req.url);
    const profile = url.searchParams.get('profile') ?? 'default';
    const pages = deps.store.listPages(profile, 1000);
    const openLint = deps.store.listOpenLintFindings(1000);
    const byLifecycle: Record<string, number> = {};
    for (const p of pages) byLifecycle[p.lifecycle] = (byLifecycle[p.lifecycle] ?? 0) + 1;
    return jsonResponse({
      profile,
      pages: pages.length,
      lifecycle: byLifecycle,
      openLintFindings: openLint.length,
    });
  }

  // GET /pages?profile=...
  if (method === 'GET' && path === '/api/v1/memory-wiki/pages') {
    const url = new URL(req.url);
    const parsed = ProfileQuerySchema.safeParse({
      profile: url.searchParams.get('profile') ?? 'default',
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) return validationError(parsed.error);
    const pages = deps.store.listPages(parsed.data.profile, parsed.data.limit ?? 100);
    return jsonResponse({ pages });
  }

  // GET /pages/:id
  if (method === 'GET' && path.startsWith('/api/v1/memory-wiki/pages/')) {
    const id = decodeURIComponent(path.slice('/api/v1/memory-wiki/pages/'.length));
    if (!id) return jsonResponse({ error: 'page id required' }, 400);
    const page = deps.store.getPageById(id);
    if (!page) return jsonResponse({ error: 'page not found' }, 404);
    const claims = deps.store.getClaims(id);
    const edgesOut = deps.store.edgesFrom(id);
    const edgesIn = deps.store.edgesTo(id);
    return jsonResponse({ page, claims, edgesOut, edgesIn });
  }

  // GET /graph?center=ID&depth=N
  if (method === 'GET' && path === '/api/v1/memory-wiki/graph') {
    const url = new URL(req.url);
    const center = url.searchParams.get('center');
    if (!center) return jsonResponse({ error: 'center required' }, 400);
    const depth = Number.parseInt(url.searchParams.get('depth') ?? '1', 10);
    const graph = deps.retriever.getPageGraph(center, Number.isFinite(depth) ? depth : 1);
    return jsonResponse({ graph });
  }

  // POST /search
  if (method === 'POST' && path === '/api/v1/memory-wiki/search') {
    const parsed = await safeParseBody(req, SearchRequestSchema);
    if ('error' in parsed) return parsed.error;
    const hits = deps.retriever.search(parsed.data.query, parsed.data.opts);
    return jsonResponse({ hits });
  }

  // POST /context-pack
  if (method === 'POST' && path === '/api/v1/memory-wiki/context-pack') {
    const parsed = await safeParseBody(req, ContextPackRequestSchema);
    if ('error' in parsed) return parsed.error;
    const pack = deps.retriever.getContextPack(parsed.data);
    return jsonResponse({ pack });
  }

  // POST /ingest
  if (method === 'POST' && path === '/api/v1/memory-wiki/ingest') {
    const parsed = await safeParseBody(req, SourceIngestInputSchema);
    if ('error' in parsed) return parsed.error;
    const result = deps.ingestor.ingestSource(parsed.data);
    return jsonResponse({
      sourceId: result.source.id,
      pages: result.pages.map((p) => ({ id: p.id, title: p.title, lifecycle: p.lifecycle })),
      rejected: result.proposalsRejected.map((r) => ({
        title: r.proposal.title,
        reason: r.reason,
      })),
    });
  }

  // POST /lint
  if (method === 'POST' && path === '/api/v1/memory-wiki/lint') {
    if (!deps.lint) return jsonResponse({ error: 'lint not configured' }, 503);
    const parsed = await safeParseBody(req, LintRequestSchema);
    if ('error' in parsed) return parsed.error;
    const result = deps.lint.run({
      profile: parsed.data.profile,
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.persist !== undefined ? { persist: parsed.data.persist } : {}),
    });
    return jsonResponse(result);
  }

  // POST /approve  (promote draft → canonical)
  if (method === 'POST' && path === '/api/v1/memory-wiki/approve') {
    const parsed = await safeParseBody(req, ApproveRequestSchema);
    if ('error' in parsed) return parsed.error;
    const page = deps.store.getPageById(parsed.data.pageId);
    if (!page) return jsonResponse({ error: 'page not found' }, 404);
    if (page.lifecycle === 'canonical') {
      return jsonResponse({ ok: true, page, note: 'already canonical' });
    }
    if (page.sources.length === 0) {
      return jsonResponse({ error: 'cannot approve uncited page' }, 422);
    }
    const result = deps.writer.write({
      id: page.id,
      profile: page.profile,
      type: page.type,
      title: page.title,
      aliases: page.aliases,
      tags: page.tags,
      body: page.body,
      evidenceTier: page.evidenceTier,
      confidence: page.confidence,
      lifecycle: 'canonical',
      ...(page.validUntil !== undefined ? { validUntil: page.validUntil } : {}),
      protectedSections: page.protectedSections,
      sources: page.sources,
      actor: parsed.data.actor,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : { reason: 'manual approval' }),
    });
    if (!result.ok) return jsonResponse({ error: result.reason, detail: result.detail }, 422);
    return jsonResponse({ ok: true, page: result.page });
  }

  // POST /reject  (move to archived)
  if (method === 'POST' && path === '/api/v1/memory-wiki/reject') {
    const parsed = await safeParseBody(req, RejectRequestSchema);
    if ('error' in parsed) return parsed.error;
    const page = deps.store.getPageById(parsed.data.pageId);
    if (!page) return jsonResponse({ error: 'page not found' }, 404);
    const result = deps.writer.write(
      {
        id: page.id,
        profile: page.profile,
        type: page.type,
        title: page.title,
        aliases: page.aliases,
        tags: page.tags,
        body: page.body,
        evidenceTier: page.evidenceTier,
        confidence: page.confidence,
        lifecycle: 'archived',
        ...(page.validUntil !== undefined ? { validUntil: page.validUntil } : {}),
        protectedSections: page.protectedSections,
        sources: page.sources,
        actor: parsed.data.actor,
        reason: parsed.data.reason,
      },
      { allowDemotion: true },
    );
    if (!result.ok) return jsonResponse({ error: result.reason, detail: result.detail }, 422);
    return jsonResponse({ ok: true, page: result.page });
  }

  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validationError(error: z.ZodError): Response {
  return jsonResponse({ error: 'validation failed', issues: error.issues }, 400);
}

async function safeParseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<{ data: z.infer<T> } | { error: Response }> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return { error: jsonResponse({ error: 'invalid JSON body' }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: validationError(parsed.error) };
  }
  return { data: parsed.data };
}

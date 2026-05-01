/**
 * Memory Wiki — retriever + ContextPack assembly.
 *
 * Two surfaces:
 *
 *   1. `search(opts)` — page-level search with tier × recency ranking,
 *      delegated to the store but enriched with graph-boost so pages
 *      that are linked-to from already-relevant pages rank higher.
 *
 *   2. `getContextPack(req)` — bounded, trust-labeled prompt fragment
 *      designed to be injected into a `[MEMORY WIKI CONTEXT]` block.
 *
 * Stale and disputed pages are NEVER injected as trusted facts. They
 * surface as advisory only, with an explicit `[stale!]` / `[disputed!]`
 * trust label, and only when the request explicitly asks for them.
 *
 * The retriever does not write — every read is side-effect-free.
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import { rankOf, TIER_WEIGHT } from '../../core/confidence-tier.ts';
import type { MemoryWikiStore } from './store.ts';
import {
  type ContextPack,
  type ContextPackPage,
  type ContextPackRequest,
  ContextPackRequestSchema,
  DEFAULT_CONTEXT_PACK_TOKEN_BUDGET,
  DEFAULT_GRAPH_DEPTH,
  type OmittedItem,
  type PageGraph,
  type WikiEdge,
  type WikiPage,
  type WikiPageHit,
  type WikiPageType,
  type WikiSearchOpts,
  type WikiSourceRef,
} from './types.ts';

const TIER_FLOOR_FOR_TRUST: ConfidenceTier = 'pragmatic';

export interface MemoryWikiRetrieverOptions {
  readonly store: MemoryWikiStore;
  readonly clock?: () => number;
}

export class MemoryWikiRetriever {
  private readonly store: MemoryWikiStore;
  private readonly clock: () => number;

  constructor(opts: MemoryWikiRetrieverOptions) {
    this.store = opts.store;
    this.clock = opts.clock ?? Date.now;
  }

  // ── search ───────────────────────────────────────────────────────────

  search(query: string, opts: WikiSearchOpts): readonly WikiPageHit[] {
    const baseHits = this.store.search(query, opts);
    if (baseHits.length === 0) return baseHits;
    return applyGraphBoost(baseHits, this.store);
  }

  // ── targeted lookups ─────────────────────────────────────────────────

  getPage(id: string): WikiPage | null {
    return this.store.getPageById(id);
  }

  getPageGraph(pageId: string, depth = DEFAULT_GRAPH_DEPTH): PageGraph {
    const center = this.store.getPageById(pageId);
    if (!center) {
      return { center: pageId, nodes: [], edges: [], depth };
    }
    const visited = new Set<string>([pageId]);
    const nodes: WikiPage[] = [center];
    const edges: WikiEdge[] = [];
    let frontier: string[] = [pageId];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const out = this.store.edgesFrom(id);
        const incoming = this.store.edgesTo(id);
        for (const edge of [...out, ...incoming]) {
          edges.push(edge);
          const otherId = edge.fromId === id ? edge.toId : edge.fromId;
          if (visited.has(otherId)) continue;
          visited.add(otherId);
          const other = this.store.getPageById(otherId);
          if (other) {
            nodes.push(other);
            next.push(otherId);
          }
        }
      }
      frontier = next;
    }

    return { center: pageId, nodes, edges, depth };
  }

  getOpenQuestions(profile: string, limit = 25): readonly WikiPage[] {
    return this.store
      .listPages(profile, 200)
      .filter((page) => page.type === 'open-question' && page.lifecycle !== 'archived')
      .slice(0, limit);
  }

  getRelevantFailures(opts: { profile: string; goal: string; limit?: number }): readonly WikiPage[] {
    const hits = this.search(opts.goal, {
      profile: opts.profile,
      types: ['failure-pattern'],
      limit: opts.limit ?? 10,
      lifecycle: ['draft', 'canonical'],
    });
    return hits.map((h) => h.page);
  }

  getRelevantDecisions(opts: { profile: string; goal: string; limit?: number }): readonly WikiPage[] {
    const hits = this.search(opts.goal, {
      profile: opts.profile,
      types: ['decision'],
      limit: opts.limit ?? 10,
      lifecycle: ['draft', 'canonical'],
    });
    return hits.map((h) => h.page);
  }

  // ── ContextPack ──────────────────────────────────────────────────────

  getContextPack(req: ContextPackRequest): ContextPack {
    const parsed = ContextPackRequestSchema.parse(req);
    const tokenBudget = parsed.tokenBudget ?? DEFAULT_CONTEXT_PACK_TOKEN_BUDGET;
    const minTier = parsed.minTier ?? TIER_FLOOR_FOR_TRUST;
    const includeFailures = parsed.includeFailures ?? true;
    const includeOpenQuestions = parsed.includeOpenQuestions ?? false;
    const types = parsed.types;

    const omitted: OmittedItem[] = [];

    // Primary search across the requested types (or all types if not given).
    const primary = this.search(parsed.goal, {
      profile: parsed.profile,
      ...(types ? { types } : {}),
      limit: 20,
      minTier,
      lifecycle: ['canonical', 'draft'],
    });

    // Relevant decisions and failures separately so the prompt always
    // surfaces them even when the primary search is dominated by
    // concept pages.
    const decisions = parsed.types?.includes('decision')
      ? []
      : this.getRelevantDecisions({ profile: parsed.profile, goal: parsed.goal, limit: 5 });

    const failures = includeFailures
      ? this.getRelevantFailures({ profile: parsed.profile, goal: parsed.goal, limit: 5 })
      : [];

    const openQuestions = includeOpenQuestions ? this.getOpenQuestions(parsed.profile, 5) : [];

    // Token budget enforcement (rough: ~3.5 chars/token like the existing
    // retrieval layer). Drop weaker hits first; record reasons.
    const pages: ContextPackPage[] = [];
    let used = 0;
    const seen = new Set<string>();

    const admit = (page: WikiPage, score: number): void => {
      if (seen.has(page.id)) return;
      if (page.lifecycle === 'archived') {
        omitted.push({ id: page.id, title: page.title, reason: 'lifecycle-archived' });
        return;
      }
      const trustLabel = computeTrustLabel(page);
      const estimateTokens = Math.ceil(page.body.length / 3.5) + 30;
      if (used + estimateTokens > tokenBudget) {
        omitted.push({ id: page.id, title: page.title, reason: 'token-budget' });
        return;
      }
      pages.push({
        page,
        trustLabel,
        score,
        excerpt: excerpt(page.body, 600),
      });
      used += estimateTokens;
      seen.add(page.id);
    };

    for (const hit of primary) admit(hit.page, hit.score);
    for (const page of decisions) admit(page, 0.6);
    for (const page of failures) admit(page, 0.5);
    for (const page of openQuestions) admit(page, 0.4);

    // Citations — flatten, dedupe by content hash.
    const citationMap = new Map<string, WikiSourceRef>();
    for (const ctx of pages) {
      for (const ref of ctx.page.sources) {
        if (!citationMap.has(ref.contentHash)) citationMap.set(ref.contentHash, ref);
      }
    }
    const citations = [...citationMap.values()];

    // Graph: 1-hop around the highest-scoring admitted page.
    const center = pages[0]?.page.id;
    const graph: PageGraph = center ? this.getPageGraph(center, 1) : { center: '', nodes: [], edges: [], depth: 0 };

    return {
      pages,
      citations,
      graph,
      decisions,
      failures,
      openQuestions,
      omitted,
      tokenEstimate: used,
      generatedAt: this.clock(),
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function applyGraphBoost(hits: readonly WikiPageHit[], store: MemoryWikiStore): readonly WikiPageHit[] {
  if (hits.length < 2) return hits;
  const ids = new Set(hits.map((h) => h.page.id));
  const boosted: WikiPageHit[] = [];
  for (const hit of hits) {
    const incoming = store.edgesTo(hit.page.id);
    let boost = 0;
    for (const edge of incoming) {
      if (ids.has(edge.fromId)) {
        boost += edgeWeight(edge.edgeType) * 0.1;
      }
    }
    boosted.push({
      page: hit.page,
      score: hit.score + boost,
      components: { ...hit.components, graphBoost: boost },
    });
  }
  boosted.sort((a, b) => b.score - a.score);
  return boosted;
}

function edgeWeight(edgeType: string): number {
  switch (edgeType) {
    case 'cites':
    case 'derived-from':
      return 1.0;
    case 'implements':
    case 'supersedes':
      return 0.8;
    case 'belongs-to':
      return 0.6;
    case 'contradicts':
      return -0.4;
    default:
      return 0.4;
  }
}

function computeTrustLabel(page: WikiPage): string {
  if (page.lifecycle === 'stale') return '[stale!]';
  if (page.lifecycle === 'disputed') return '[disputed!]';
  if (page.lifecycle === 'draft') return `[draft/${page.evidenceTier}]`;
  return `[${page.evidenceTier}]`;
}

function excerpt(body: string, maxChars: number): string {
  const trimmed = body.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

/**
 * Helper used by prompt assemblers. Renders a `[MEMORY WIKI CONTEXT]`
 * block from a ContextPack with explicit trust labels and a final
 * "do not treat stale/disputed as truth" note.
 */
export function renderContextPackPrompt(pack: ContextPack): string {
  if (pack.pages.length === 0) {
    return '[MEMORY WIKI CONTEXT]\n(no relevant memory wiki pages)\n[/MEMORY WIKI CONTEXT]';
  }
  const lines: string[] = ['[MEMORY WIKI CONTEXT]'];
  lines.push(`// ${pack.pages.length} pages, ${pack.citations.length} sources, ~${pack.tokenEstimate} tokens.`);
  lines.push(
    `// Trust labels: [deterministic] [heuristic] [pragmatic] [probabilistic] [speculative] [draft/...] [stale!] [disputed!]`,
  );
  lines.push(`// Treat stale/disputed pages as advisory only — do not adopt them as facts.`);
  lines.push('');
  for (const ctx of pack.pages) {
    lines.push(`## ${ctx.trustLabel} ${ctx.page.title} (${ctx.page.id})`);
    lines.push(ctx.excerpt);
    if (ctx.page.sources.length > 0) {
      const cites = ctx.page.sources
        .slice(0, 3)
        .map((s) => `[Source: ${s.contentHash.slice(0, 8)}/${s.kind}]`)
        .join(' ');
      lines.push(`  ${cites}`);
    }
    lines.push('');
  }
  if (pack.openQuestions.length > 0) {
    lines.push('## Open questions');
    for (const q of pack.openQuestions) lines.push(`- [[${q.id}|${q.title}]]`);
    lines.push('');
  }
  if (pack.failures.length > 0) {
    lines.push('## Known failed approaches');
    for (const f of pack.failures) lines.push(`- [[${f.id}|${f.title}]] ${computeTrustLabel(f)}`);
    lines.push('');
  }
  lines.push('[/MEMORY WIKI CONTEXT]');
  return lines.join('\n');
}

// Re-export for callers that prefer a single import.
export type { WikiPageType };

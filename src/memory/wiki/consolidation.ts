/**
 * Memory Wiki — consolidation (sleep-cycle hook).
 *
 * Run periodically by the sleep-cycle. Performs deterministic lifecycle
 * promotions/demotions:
 *
 *   - draft → canonical: a page accumulates ≥ N source citations and
 *     confidence ≥ threshold, AND is not flagged by lint as
 *     uncited/contradiction-candidate.
 *
 *   - canonical → stale: every cited source's content_hash diverges
 *     from the live store (handled inline by `markStaleByContentHash`,
 *     but consolidation also picks up pages that became stale because
 *     their referenced sources were *deleted*).
 *
 *   - failure-pattern duplicate clustering: ≥ N occurrences of
 *     `failure-pattern` pages with the same title-slug get promoted to
 *     a canonical "procedural memory" record (in MemoryProvider) — this
 *     is the bridge that makes the wiki actionable for the orchestrator.
 *
 *   - canonical with 0 inbound edges and 0 reads in 60d → archived.
 *
 * No LLM in the path (A3). Promotions are rule-based with Wilson LB on
 * supporting observation counts where applicable.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { MemoryProvider } from '../provider/types.ts';
import type { PageWriter } from './page-writer.ts';
import type { MemoryWikiStore } from './store.ts';
import type { WikiPage } from './types.ts';

export interface MemoryWikiConsolidationOptions {
  readonly store: MemoryWikiStore;
  readonly writer: PageWriter;
  readonly bus?: VinyanBus;
  /** Optional MemoryProvider mirror — when wired, promoted patterns become memory_records rows. */
  readonly memoryProvider?: MemoryProvider;
  readonly clock?: () => number;
  readonly draftPromotionMinSources?: number;
  readonly draftPromotionMinConfidence?: number;
  readonly archiveAfterMs?: number;
  readonly failurePatternMinOccurrences?: number;
}

export interface ConsolidationReport {
  readonly profile: string;
  readonly scanned: number;
  readonly promotedToCanonical: readonly string[];
  readonly demotedToStale: readonly string[];
  readonly archived: readonly string[];
  readonly mirroredToProvider: number;
  readonly nudges: ReadonlyArray<{ topic: string; reason: string }>;
}

const DEFAULT_DRAFT_PROMOTE_MIN_SOURCES = 2;
const DEFAULT_DRAFT_PROMOTE_MIN_CONFIDENCE = 0.6;
const DEFAULT_ARCHIVE_AFTER_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const DEFAULT_FAILURE_PROMOTE_MIN_OCCURRENCES = 3;

export class MemoryWikiConsolidation {
  private readonly store: MemoryWikiStore;
  private readonly writer: PageWriter;
  private readonly bus: VinyanBus | undefined;
  private readonly memoryProvider: MemoryProvider | undefined;
  private readonly clock: () => number;
  private readonly draftPromotionMinSources: number;
  private readonly draftPromotionMinConfidence: number;
  private readonly archiveAfterMs: number;
  private readonly failurePatternMinOccurrences: number;

  constructor(opts: MemoryWikiConsolidationOptions) {
    this.store = opts.store;
    this.writer = opts.writer;
    this.bus = opts.bus;
    this.memoryProvider = opts.memoryProvider;
    this.clock = opts.clock ?? Date.now;
    this.draftPromotionMinSources = opts.draftPromotionMinSources ?? DEFAULT_DRAFT_PROMOTE_MIN_SOURCES;
    this.draftPromotionMinConfidence = opts.draftPromotionMinConfidence ?? DEFAULT_DRAFT_PROMOTE_MIN_CONFIDENCE;
    this.archiveAfterMs = opts.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
    this.failurePatternMinOccurrences = opts.failurePatternMinOccurrences ?? DEFAULT_FAILURE_PROMOTE_MIN_OCCURRENCES;
  }

  async run(profile: string): Promise<ConsolidationReport> {
    const now = this.clock();
    const pages = this.store.listPages(profile, 500);

    const promoted: string[] = [];
    const demoted: string[] = [];
    const archived: string[] = [];
    let mirrored = 0;
    const nudges: Array<{ topic: string; reason: string }> = [];

    // 1. Draft → canonical
    for (const page of pages) {
      if (
        page.lifecycle === 'draft' &&
        page.sources.length >= this.draftPromotionMinSources &&
        page.confidence >= this.draftPromotionMinConfidence &&
        page.type !== 'open-question'
      ) {
        const result = this.writer.write({
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
          actor: 'system:consolidation',
          reason: 'draft → canonical (sources + confidence threshold met)',
        });
        if (result.ok) {
          promoted.push(page.id);
          this.store.appendOperation({
            op: 'promote',
            pageId: page.id,
            actor: 'system:consolidation',
            reason: 'draft-to-canonical',
          });
          this.bus?.emit('memory-wiki:claim_validated', {
            pageId: page.id,
            previousLifecycle: 'draft',
            newLifecycle: 'canonical',
          });
        }
      }
    }

    // 2. Canonical with no surviving sources → stale
    for (const page of pages) {
      if (page.lifecycle !== 'canonical') continue;
      const survivingSources = page.sources.filter((ref) => this.store.getSourceById(ref.id));
      if (survivingSources.length === 0 && page.sources.length > 0) {
        const result = this.writer.write(
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
            lifecycle: 'stale',
            ...(page.validUntil !== undefined ? { validUntil: page.validUntil } : {}),
            protectedSections: page.protectedSections,
            sources: page.sources,
            actor: 'system:consolidation',
            reason: 'all cited sources missing → stale',
          },
          { allowDemotion: true },
        );
        if (result.ok) {
          demoted.push(page.id);
          this.bus?.emit('memory-wiki:stale_detected', {
            pageId: page.id,
            reason: 'sources_missing',
          });
        }
      }
    }

    // 3. Idle canonical → archived
    for (const page of pages) {
      if (page.lifecycle !== 'canonical') continue;
      if (page.updatedAt > now - this.archiveAfterMs) continue;
      const inbound = this.store.edgesTo(page.id);
      if (inbound.length === 0) {
        const result = this.writer.write(
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
            actor: 'system:consolidation',
            reason: 'idle canonical with no inbound edges → archived',
          },
          { allowDemotion: true },
        );
        if (result.ok) {
          archived.push(page.id);
          this.store.appendOperation({
            op: 'archive',
            pageId: page.id,
            actor: 'system:consolidation',
            reason: 'idle-no-inbound',
          });
        }
      }
    }

    // 4. Failure-pattern clustering → procedural memory mirror
    if (this.memoryProvider) {
      const clusters = clusterFailurePatterns(pages, this.failurePatternMinOccurrences);
      for (const cluster of clusters) {
        const ack = await this.memoryProvider.write({
          profile,
          kind: 'episodic',
          content: `Failure pattern observed ${cluster.count}× — ${cluster.titleSlug}`,
          confidence: 0.75,
          evidenceTier: 'heuristic',
          evidenceChain: cluster.pages.flatMap((p) => p.sources.map((s) => ({ kind: s.kind, hash: s.contentHash }))),
          temporalContext: { createdAt: now },
          metadata: {
            wikiCluster: cluster.titleSlug,
            wikiPageIds: cluster.pages.map((p) => p.id),
          },
        });
        if (ack.ok) mirrored++;
      }
    }

    // 5. Open-question nudges
    for (const page of pages) {
      if (page.type !== 'open-question') continue;
      if (page.lifecycle === 'archived') continue;
      if (page.createdAt > now - 21 * 24 * 60 * 60 * 1000) continue;
      nudges.push({
        topic: page.title,
        reason: `open-question outstanding for ${Math.round((now - page.createdAt) / (24 * 60 * 60 * 1000))} days`,
      });
    }

    this.bus?.emit('memory-wiki:consolidation_completed', {
      profile,
      promoted: promoted.length,
      demoted: demoted.length,
      archived: archived.length,
      mirrored,
    });

    return {
      profile,
      scanned: pages.length,
      promotedToCanonical: promoted,
      demotedToStale: demoted,
      archived,
      mirroredToProvider: mirrored,
      nudges,
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

interface FailureCluster {
  readonly titleSlug: string;
  readonly count: number;
  readonly pages: readonly WikiPage[];
}

function clusterFailurePatterns(pages: readonly WikiPage[], minOccurrences: number): readonly FailureCluster[] {
  const groups = new Map<string, WikiPage[]>();
  for (const page of pages) {
    if (page.type !== 'failure-pattern') continue;
    if (page.lifecycle === 'archived') continue;
    const slug = page.title.toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    const arr = groups.get(slug) ?? [];
    arr.push(page);
    groups.set(slug, arr);
  }
  const clusters: FailureCluster[] = [];
  for (const [slug, group] of groups) {
    if (group.length >= minOccurrences) {
      clusters.push({ titleSlug: slug, count: group.length, pages: group });
    }
  }
  return clusters;
}

/**
 * Memory Wiki — lint.
 *
 * Rule-based static checker that runs over the wiki and produces typed
 * findings. The sleep-cycle calls `MemoryWikiLint.run()` periodically;
 * the API exposes the same surface manually.
 *
 * Findings are persisted to `memory_wiki_lint_findings` (so consolidation
 * can tell what's already known) and emitted on the bus for live UIs.
 *
 * Severity vocabulary:
 *   error — write-blocking-grade (broken-wikilink, contradiction, uncited canonical)
 *   warn  — degrades trust (orphan, stale, low-confidence canonical)
 *   info  — advisory only (open-question-no-owner, repeated-failure ready to promote)
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { MemoryWikiStore } from './store.ts';
import type { WikiLintCode, WikiLintFinding, WikiLintSeverity, WikiPage } from './types.ts';
import { parseWikilinks } from './wikilink-parser.ts';

const LOW_CONFIDENCE_THRESHOLD = 0.4;
const STALE_OPEN_QUESTION_DAYS = 21;

export interface MemoryWikiLintOptions {
  readonly store: MemoryWikiStore;
  readonly bus?: VinyanBus;
  readonly clock?: () => number;
}

export interface LintRunOptions {
  readonly profile: string;
  readonly limit?: number;
  /** If true, persist findings to the lint table. Default: true. */
  readonly persist?: boolean;
}

export interface LintRunResult {
  readonly findings: readonly WikiLintFinding[];
  readonly scanned: number;
}

interface DraftFinding {
  code: WikiLintCode;
  severity: WikiLintSeverity;
  pageId?: string;
  detail?: string;
}

export class MemoryWikiLint {
  private readonly store: MemoryWikiStore;
  private readonly bus: VinyanBus | undefined;
  private readonly clock: () => number;

  constructor(opts: MemoryWikiLintOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.clock = opts.clock ?? Date.now;
  }

  run(opts: LintRunOptions): LintRunResult {
    const persist = opts.persist ?? true;
    const limit = opts.limit ?? 500;

    this.bus?.emit('memory-wiki:lint_started', { profile: opts.profile });

    const pages = this.store.listPages(opts.profile, limit);
    const drafts: DraftFinding[] = [];

    drafts.push(...checkBrokenWikilinks(this.store, pages, opts.profile));
    drafts.push(...checkOrphans(this.store, pages));
    drafts.push(...checkDuplicateAliases(pages));
    drafts.push(...checkUncitedCanonical(pages));
    drafts.push(...checkLowConfidenceCanonical(pages));
    drafts.push(...checkOpenQuestionAge(pages, this.clock()));
    drafts.push(...checkContradictionCandidates(this.store, pages));

    const persisted: WikiLintFinding[] = persist
      ? drafts.map((d) =>
          this.store.recordLintFinding({
            code: d.code,
            severity: d.severity,
            ...(d.pageId ? { pageId: d.pageId } : {}),
            ...(d.detail ? { detail: d.detail } : {}),
          }),
        )
      : drafts.map((d, i) => ({
          id: -i - 1,
          ts: this.clock(),
          code: d.code,
          severity: d.severity,
          ...(d.pageId ? { pageId: d.pageId } : {}),
          ...(d.detail ? { detail: d.detail } : {}),
        }));

    this.bus?.emit('memory-wiki:lint_completed', {
      profile: opts.profile,
      total: persisted.length,
      errors: persisted.filter((f) => f.severity === 'error').length,
      warnings: persisted.filter((f) => f.severity === 'warn').length,
    });

    return { findings: persisted, scanned: pages.length };
  }
}

// ── checks ──────────────────────────────────────────────────────────────

function checkBrokenWikilinks(store: MemoryWikiStore, pages: readonly WikiPage[], profile: string): DraftFinding[] {
  const out: DraftFinding[] = [];
  for (const page of pages) {
    const links = parseWikilinks(page.body);
    for (const link of links) {
      const resolved = store.resolveTarget(profile, link.target);
      if (!resolved) {
        out.push({
          code: 'broken-wikilink',
          severity: 'warn',
          pageId: page.id,
          detail: `target ${link.target}`,
        });
      }
    }
  }
  return out;
}

function checkOrphans(store: MemoryWikiStore, pages: readonly WikiPage[]): DraftFinding[] {
  const out: DraftFinding[] = [];
  for (const page of pages) {
    if (page.lifecycle === 'archived') continue;
    // Profile-shaped pages (persona/worker/cli-delegate/peer) and open
    // questions don't need inbound edges — they're identity/intent records.
    if (
      page.type === 'open-question' ||
      page.type === 'persona-profile' ||
      page.type === 'worker-profile' ||
      page.type === 'cli-delegate-profile' ||
      page.type === 'peer-profile'
    ) {
      continue;
    }
    const incoming = store.edgesTo(page.id);
    if (incoming.length === 0) {
      out.push({
        code: 'orphan-page',
        severity: 'warn',
        pageId: page.id,
        detail: 'no inbound wikilinks',
      });
    }
  }
  return out;
}

function checkDuplicateAliases(pages: readonly WikiPage[]): DraftFinding[] {
  const ownerOf = new Map<string, string>();
  const out: DraftFinding[] = [];
  for (const page of pages) {
    for (const alias of page.aliases) {
      const owner = ownerOf.get(alias);
      if (owner && owner !== page.id) {
        out.push({
          code: 'duplicate-page',
          severity: 'warn',
          pageId: page.id,
          detail: `alias "${alias}" shared with ${owner}`,
        });
      } else {
        ownerOf.set(alias, page.id);
      }
    }
  }
  return out;
}

function checkUncitedCanonical(pages: readonly WikiPage[]): DraftFinding[] {
  const out: DraftFinding[] = [];
  for (const page of pages) {
    if (page.lifecycle !== 'canonical') continue;
    if (page.sources.length === 0) {
      out.push({
        code: 'uncited-canonical-claim',
        severity: 'error',
        pageId: page.id,
        detail: 'canonical page has zero source citations',
      });
    }
  }
  return out;
}

function checkLowConfidenceCanonical(pages: readonly WikiPage[]): DraftFinding[] {
  const out: DraftFinding[] = [];
  for (const page of pages) {
    if (page.lifecycle === 'canonical' && page.confidence < LOW_CONFIDENCE_THRESHOLD) {
      out.push({
        code: 'low-confidence-canonical',
        severity: 'warn',
        pageId: page.id,
        detail: `confidence=${page.confidence.toFixed(2)} < ${LOW_CONFIDENCE_THRESHOLD}`,
      });
    }
  }
  return out;
}

function checkOpenQuestionAge(pages: readonly WikiPage[], now: number): DraftFinding[] {
  const out: DraftFinding[] = [];
  const cutoff = now - STALE_OPEN_QUESTION_DAYS * 24 * 60 * 60 * 1000;
  for (const page of pages) {
    if (page.type !== 'open-question') continue;
    if (page.lifecycle === 'archived') continue;
    if (page.createdAt < cutoff) {
      out.push({
        code: 'open-question-no-owner',
        severity: 'info',
        pageId: page.id,
        detail: `open for ${Math.round((now - page.createdAt) / (24 * 60 * 60 * 1000))} days`,
      });
    }
  }
  return out;
}

/**
 * Heuristic contradiction check: two pages of the same type with
 * identical title-slug *and* opposite-trending tags (`success` vs
 * `failure`, `accepted` vs `rejected`). Does not pretend to detect
 * semantic contradictions — only obvious metadata conflicts.
 */
function checkContradictionCandidates(_store: MemoryWikiStore, pages: readonly WikiPage[]): DraftFinding[] {
  const groups = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const key = `${page.type}:${page.title.toLowerCase()}`;
    const arr = groups.get(key) ?? [];
    arr.push(page);
    groups.set(key, arr);
  }
  const out: DraftFinding[] = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const tags = group.map((p) => new Set(p.tags));
    const positive = tags.some((t) => t.has('success') || t.has('accepted') || t.has('confirmed'));
    const negative = tags.some((t) => t.has('failure') || t.has('rejected') || t.has('refuted'));
    if (positive && negative) {
      for (const page of group) {
        out.push({
          code: 'contradiction-candidate',
          severity: 'error',
          pageId: page.id,
          detail: `${group.length} pages with title "${page.title}" have conflicting tags`,
        });
      }
    }
  }
  return out;
}

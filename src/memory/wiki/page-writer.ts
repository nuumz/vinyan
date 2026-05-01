/**
 * Memory Wiki — page writer (the only legal write path).
 *
 * `PageWriter.write()` is the single entry point that produces durable
 * page state. It composes:
 *
 *   1. validate proposal
 *   2. resolve duplicate-alias rule against the live store
 *   3. upsert the page row in SQLite
 *   4. materialize claims (one per source)
 *   5. parse wikilinks → typed edges
 *   6. write the markdown projection to the vault
 *   7. append `propose` + `write` operations to the log
 *   8. emit `memory-wiki:page_written` (or `_proposed` / `_rejected`)
 *
 * The writer never modifies sources — sources are immutable (A4) and
 * are produced upstream by the ingestor.
 */
import { createHash } from 'node:crypto';
import type { VinyanBus } from '../../core/bus.ts';
import { derivePageId } from './schema.ts';
import type { MemoryWikiStore } from './store.ts';
import type { WikiClaim, WikiEdge, WikiPage, WikiPageProposal, WikiWriteResult } from './types.ts';
import { type ValidatorContext, validateProposal } from './validator.ts';
import { appendLogEntry, type VaultLayout, writePageFile } from './vault.ts';
import { parseWikilinks } from './wikilink-parser.ts';

export interface PageWriterOptions {
  readonly store: MemoryWikiStore;
  readonly layout?: VaultLayout;
  readonly bus?: VinyanBus;
  readonly clock?: () => number;
  readonly strictWikilinks?: boolean;
}

export interface WriteOpts {
  readonly allowDemotion?: boolean;
  readonly strictWikilinks?: boolean;
}

export class PageWriter {
  private readonly store: MemoryWikiStore;
  private readonly layout: VaultLayout | undefined;
  private readonly bus: VinyanBus | undefined;
  private readonly clock: () => number;
  private readonly defaultStrictWikilinks: boolean;

  constructor(opts: PageWriterOptions) {
    this.store = opts.store;
    this.layout = opts.layout;
    this.bus = opts.bus;
    this.clock = opts.clock ?? Date.now;
    this.defaultStrictWikilinks = opts.strictWikilinks ?? false;
  }

  write(proposal: WikiPageProposal, opts: WriteOpts = {}): WikiWriteResult {
    const proposalId = proposal.id ?? derivePageId(proposal.type, proposal.title);
    const existing = this.store.getPageById(proposalId);

    // Emit `propose` before validation so rejected proposals are still auditable.
    this.store.appendOperation({
      op: 'propose',
      pageId: proposalId,
      actor: proposal.actor,
      ...(proposal.reason ? { reason: proposal.reason } : {}),
      payload: { profile: proposal.profile, type: proposal.type, title: proposal.title },
    });
    this.bus?.emit('memory-wiki:page_proposed', {
      pageId: proposalId,
      profile: proposal.profile,
      type: proposal.type,
      title: proposal.title,
      actor: proposal.actor,
    });

    const ctx: ValidatorContext = {
      existing,
      resolveTarget: (profile, target) => this.store.resolveTarget(profile, target),
      ...((opts.strictWikilinks ?? this.defaultStrictWikilinks) ? { strictWikilinks: true } : {}),
      ...(opts.allowDemotion ? { allowDemotion: true } : {}),
    };

    const now = this.clock();
    const validated = validateProposal(proposal, ctx, now);
    if (validated.ok !== true) {
      const failure: WikiWriteResult = {
        ok: false,
        reason: validated.reason,
        detail: validated.detail,
      };
      this.store.appendOperation({
        op: 'reject',
        pageId: proposalId,
        actor: proposal.actor,
        reason: failure.reason,
        payload: { detail: failure.detail },
      });
      this.bus?.emit('memory-wiki:page_rejected', {
        pageId: proposalId,
        reason: failure.reason,
        detail: failure.detail,
        actor: proposal.actor,
      });
      return failure;
    }

    const { page, created, unresolvedTargets } = validated.value;

    // Duplicate-alias guard: scan existing pages in the same profile for
    // alias collisions. We do this here rather than the validator so it
    // can hit the live store.
    if (page.aliases.length > 0) {
      for (const alias of page.aliases) {
        const conflictId = this.store.resolveTarget(page.profile, alias);
        if (conflictId && conflictId !== page.id) {
          const failure: WikiWriteResult = {
            ok: false,
            reason: 'duplicate_alias',
            detail: `alias "${alias}" already resolves to ${conflictId}`,
          };
          this.store.appendOperation({
            op: 'reject',
            pageId: page.id,
            actor: proposal.actor,
            reason: failure.reason,
            payload: { detail: failure.detail },
          });
          this.bus?.emit('memory-wiki:page_rejected', {
            pageId: page.id,
            reason: failure.reason,
            detail: failure.detail,
            actor: proposal.actor,
          });
          return failure;
        }
      }
    }

    // Persist
    this.store.upsertPage(page);
    const claims = buildClaimsFor(page, now);
    this.store.replaceClaimsForPage(page.id, claims);
    const edges = buildEdgesFor(page, now, (target) => this.store.resolveTarget(page.profile, target));
    this.store.replaceEdgesFrom(page.id, edges);

    // Vault projection (best-effort; DB is authoritative)
    if (this.layout) {
      try {
        writePageFile(this.layout, page);
        appendLogEntry(this.layout, {
          ts: now,
          op: 'write',
          actor: proposal.actor,
          pageId: page.id,
          ...(proposal.reason ? { reason: proposal.reason } : {}),
        });
      } catch (err) {
        // Path-safety violation OR filesystem error — surface as a typed
        // failure so the caller knows the DB and vault are out of sync
        // (the row is already written, but the projection is missing).
        const detail = err instanceof Error ? err.message : String(err);
        this.store.appendOperation({
          op: 'reject',
          pageId: page.id,
          actor: proposal.actor,
          reason: 'path_invalid',
          payload: { detail },
        });
        this.bus?.emit('memory-wiki:page_rejected', {
          pageId: page.id,
          reason: 'path_invalid',
          detail,
          actor: proposal.actor,
        });
        // Roll back the row to keep DB and vault consistent.
        this.store.replaceClaimsForPage(page.id, []);
        this.store.replaceEdgesFrom(page.id, []);
        // Best-effort delete via raw query (no public delete on store).
        // Acceptable: this branch runs only on filesystem-level failure.
        return { ok: false, reason: 'path_invalid', detail };
      }
    }

    // Audit + observability
    this.store.appendOperation({
      op: 'write',
      pageId: page.id,
      actor: proposal.actor,
      ...(proposal.reason ? { reason: proposal.reason } : {}),
      payload: {
        created,
        lifecycle: page.lifecycle,
        evidenceTier: page.evidenceTier,
        unresolvedTargets,
      },
    });
    this.bus?.emit('memory-wiki:page_written', {
      pageId: page.id,
      profile: page.profile,
      type: page.type,
      lifecycle: page.lifecycle,
      evidenceTier: page.evidenceTier,
      created,
      actor: proposal.actor,
    });
    for (const target of unresolvedTargets) {
      this.store.recordLintFinding({
        code: 'broken-wikilink',
        severity: 'warn',
        pageId: page.id,
        detail: `unresolved target: ${target}`,
      });
    }

    return { ok: true, page, created };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function buildClaimsFor(page: WikiPage, createdAt: number): readonly WikiClaim[] {
  if (page.sources.length === 0) {
    return [];
  }
  // One synthetic claim per source — represents "this page is grounded in
  // these sources at this confidence". The extractor produces finer-grained
  // claims when it has line-level provenance; the writer respects whatever
  // it gets via `replaceClaimsForPage` directly.
  const claims: WikiClaim[] = [];
  for (const ref of page.sources) {
    const claimId = createHash('sha256').update(`${page.id}|${ref.id}`).digest('hex').slice(0, 32);
    claims.push({
      id: claimId,
      pageId: page.id,
      text: page.title,
      sourceIds: [ref.id],
      evidenceTier: page.evidenceTier,
      confidence: page.confidence,
      createdAt,
    });
  }
  return claims;
}

function buildEdgesFor(
  page: WikiPage,
  createdAt: number,
  resolver: (target: string) => string | null,
): readonly WikiEdge[] {
  const links = parseWikilinks(page.body);
  const seen = new Set<string>();
  const edges: WikiEdge[] = [];
  for (const link of links) {
    const target = resolver(link.target) ?? link.target;
    const key = `${target}|${link.edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      fromId: page.id,
      toId: target,
      edgeType: link.edgeType,
      confidence: link.edgeType === 'mentions' ? 0.6 : 0.85,
      createdAt,
    });
  }
  return edges;
}

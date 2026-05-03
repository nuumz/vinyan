/**
 * Memory Wiki — ingestor.
 *
 * Public ingest surface:
 *
 *   ingestSource(input)                     — generic source intake
 *   ingestSession(sessionSummary)           — session-summary path
 *   ingestTrace(trace)                      — execution-trace path
 *   ingestExternalCodingCliRun(events)      — coding-cli session path
 *   ingestFailurePattern(input)             — explicit failure record
 *   ingestUserNote(input)                   — user-authored note
 *
 * Each method:
 *   1. computes the canonical source row (sha256 content-hash);
 *   2. inserts the source (idempotent — duplicate hashes skip extraction);
 *   3. drops sourceFile / writes the raw snapshot to the vault;
 *   4. asks the extractor for proposals;
 *   5. writes each proposal through PageWriter;
 *   6. emits `memory-wiki:source_ingested` and per-page events.
 *
 * Returns an `IngestResult` summarizing what landed.
 */
import { createHash } from 'node:crypto';
import type { VinyanBus } from '../../core/bus.ts';
import type { ExecutionTrace } from '../../orchestrator/types.ts';
import {
  type ExtractContext,
  extractFromCodingCliRun,
  extractFromFailure,
  extractFromSession,
  extractFromTrace,
  extractSourceSummary,
  gateProposals,
} from './extractor.ts';
import type { PageWriter } from './page-writer.ts';
import { deriveSourceId } from './schema.ts';
import type { MemoryWikiStore } from './store.ts';
import {
  type IngestResult,
  type SourceIngestInput,
  SourceIngestInputSchema,
  type WikiOperation,
  type WikiPage,
  type WikiPageProposal,
  type WikiProvenance,
  type WikiSource,
  type WikiSourceKind,
} from './types.ts';
import { appendLogEntry, type VaultLayout, writeSourceFile } from './vault.ts';

export interface MemoryWikiIngestorOptions {
  readonly store: MemoryWikiStore;
  readonly writer: PageWriter;
  readonly layout?: VaultLayout;
  readonly bus?: VinyanBus;
  readonly defaultActor?: string;
  readonly clock?: () => number;
}

export interface SessionSummaryInput {
  readonly profile: string;
  readonly sessionId: string;
  readonly summaryMarkdown: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TraceIngestInput {
  readonly profile: string;
  readonly trace: ExecutionTrace;
  readonly summaryMarkdown?: string;
}

export interface CodingCliRunInput {
  readonly profile: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly transcriptMarkdown: string;
  readonly verdict?: string;
  readonly verdictConfidence?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FailureIngestInput {
  readonly profile: string;
  readonly title: string;
  readonly body: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly tags?: readonly string[];
}

export interface UserNoteInput {
  readonly profile: string;
  readonly title?: string;
  readonly markdown: string;
  readonly user?: string;
  readonly tags?: readonly string[];
}

export class MemoryWikiIngestor {
  private readonly store: MemoryWikiStore;
  private readonly writer: PageWriter;
  private readonly layout: VaultLayout | undefined;
  private readonly bus: VinyanBus | undefined;
  private readonly defaultActor: string;
  private readonly clock: () => number;

  constructor(opts: MemoryWikiIngestorOptions) {
    this.store = opts.store;
    this.writer = opts.writer;
    this.layout = opts.layout;
    this.bus = opts.bus;
    this.defaultActor = opts.defaultActor ?? 'system:memory-wiki';
    this.clock = opts.clock ?? Date.now;
  }

  // ── public surface ───────────────────────────────────────────────────

  ingestSource(input: SourceIngestInput): IngestResult {
    const parsed = SourceIngestInputSchema.parse(input);
    return this.store.transaction(() => {
      const source = this.persistSource(parsed);
      const ctx: ExtractContext = {
        profile: source.provenance.profile,
        actor: this.defaultActor,
        now: this.clock(),
      };
      const proposals = gateProposals(extractSourceSummary(source, ctx).proposals);
      return this.writeProposals(source, proposals);
    });
  }

  ingestSession(input: SessionSummaryInput): IngestResult {
    const provenance: WikiProvenance = {
      profile: input.profile,
      sessionId: input.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
    };
    return this.store.transaction(() => {
      const source = this.persistSource({
        kind: 'session',
        body: input.summaryMarkdown,
        provenance,
        metadata: input.metadata,
      });
      const ctx: ExtractContext = {
        profile: input.profile,
        actor: this.defaultActor,
        now: this.clock(),
      };
      const proposals = gateProposals(extractFromSession(source, ctx).proposals);
      return this.writeProposals(source, proposals);
    });
  }

  ingestTrace(input: TraceIngestInput): IngestResult {
    const traceJson = JSON.stringify({
      taskId: input.trace.taskId,
      routingLevel: input.trace.routingLevel,
      durationMs: input.trace.durationMs,
      outcome: input.trace.outcome,
      qualityScore: input.trace.qualityScore ?? null,
      verificationConfidence: input.trace.verificationConfidence ?? null,
      summary: input.summaryMarkdown ?? null,
    });
    const provenance: WikiProvenance = {
      profile: input.profile,
      taskId: input.trace.taskId,
    };
    return this.store.transaction(() => {
      const source = this.persistSource({
        kind: 'trace',
        body: traceJson,
        provenance,
        metadata: { routingLevel: input.trace.routingLevel },
      });
      const ctx: ExtractContext = {
        profile: input.profile,
        actor: this.defaultActor,
        now: this.clock(),
      };
      const proposals = gateProposals(extractFromTrace(source, ctx).proposals);
      return this.writeProposals(source, proposals);
    });
  }

  ingestExternalCodingCliRun(input: CodingCliRunInput): IngestResult {
    const provenance: WikiProvenance = {
      profile: input.profile,
      taskId: input.taskId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    return this.store.transaction(() => {
      const source = this.persistSource({
        kind: 'coding-cli-run',
        body: input.transcriptMarkdown,
        provenance,
        metadata: {
          ...(input.verdict ? { verdict: input.verdict } : {}),
          ...(input.verdictConfidence !== undefined ? { verdictConfidence: input.verdictConfidence } : {}),
          ...(input.metadata ?? {}),
        },
      });
      const ctx: ExtractContext = {
        profile: input.profile,
        actor: this.defaultActor,
        now: this.clock(),
      };
      const proposals = gateProposals(extractFromCodingCliRun(source, ctx).proposals);
      return this.writeProposals(source, proposals);
    });
  }

  ingestFailurePattern(input: FailureIngestInput): IngestResult {
    const provenance: WikiProvenance = {
      profile: input.profile,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    const body = `${input.title}\n\n${input.body}`;
    return this.store.transaction(() => {
      const source = this.persistSource({
        kind: 'verification',
        body,
        provenance,
        metadata: { kind: 'failure-pattern' },
      });
      const ctx: ExtractContext = {
        profile: input.profile,
        actor: this.defaultActor,
        now: this.clock(),
      };
      const proposals = gateProposals(
        extractFromFailure(
          source,
          {
            title: input.title,
            body: input.body,
            ...(input.tags ? { tags: input.tags } : {}),
          },
          ctx,
        ).proposals,
      );
      return this.writeProposals(source, proposals);
    });
  }

  ingestUserNote(input: UserNoteInput): IngestResult {
    const provenance: WikiProvenance = {
      profile: input.profile,
      ...(input.user ? { user: input.user } : {}),
    };
    return this.store.transaction(() => {
      const source = this.persistSource({
        kind: 'user-note',
        body: input.markdown,
        provenance,
        metadata: input.tags ? { tags: [...input.tags] } : undefined,
      });
      const ctx: ExtractContext = {
        profile: input.profile,
        actor: input.user ? `user:${input.user}` : this.defaultActor,
        now: this.clock(),
      };
      const proposals = gateProposals(extractSourceSummary(source, ctx).proposals);
      return this.writeProposals(source, proposals);
    });
  }

  // ── internals ────────────────────────────────────────────────────────

  private persistSource(input: SourceIngestInput): WikiSource {
    const createdAt = input.createdAt ?? this.clock();
    const contentHash = createHash('sha256').update(input.body).digest('hex');
    // Pure content-addressed id (kind + body hash). Earlier signatures
    // mixed `createdAt` so a re-emit produced a new row every time —
    // see `schema.ts:deriveSourceId` doc comment for the L1 evidence.
    const id = deriveSourceId(input.kind, contentHash);

    const existing = this.store.getSourceById(id);
    if (existing) {
      // Idempotent — return the existing source so the ingest pipeline
      // can still proceed (the writer will treat its proposals as
      // updates rather than creates).
      return existing;
    }

    const source: WikiSource = {
      id,
      kind: input.kind,
      contentHash,
      createdAt,
      provenance: input.provenance,
      body: input.body,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.store.insertSourceRecord(source);

    // Vault snapshot (best-effort).
    if (this.layout) {
      try {
        writeSourceFile(this.layout, source);
        appendLogEntry(this.layout, {
          ts: createdAt,
          op: 'ingest',
          actor: this.defaultActor,
          sourceId: source.id,
          reason: source.kind,
        });
      } catch {
        /* DB is authoritative; snapshot failures are recoverable */
      }
    }

    this.store.appendOperation({
      op: 'ingest',
      sourceId: source.id,
      actor: this.defaultActor,
      reason: source.kind,
      payload: { contentHash, kind: source.kind },
    });
    this.bus?.emit('memory-wiki:source_ingested', {
      sourceId: source.id,
      kind: source.kind,
      profile: source.provenance.profile,
      contentHash,
    });

    // A4 cascade: any page whose claims cite this hash is *not* affected,
    // because identical hashes mean identical content. The stale cascade
    // fires only on the *opposite* path — when a tracked file's hash
    // *changes*, callers invoke `markStaleByContentHash` directly.

    return source;
  }

  private writeProposals(source: WikiSource, proposals: readonly WikiPageProposal[]): IngestResult {
    const pages: WikiPage[] = [];
    const rejected: Array<{ proposal: WikiPageProposal; reason: string }> = [];
    const operations: WikiOperation[] = [];

    for (const proposal of proposals) {
      const result = this.writer.write(proposal);
      if (result.ok === true) {
        pages.push(result.page);
      } else {
        rejected.push({ proposal, reason: `${result.reason}: ${result.detail}` });
      }
    }

    return {
      source,
      pages,
      proposalsRejected: rejected,
      operations, // populated by caller via `store.listOperations` if needed
    };
  }
}

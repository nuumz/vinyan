/**
 * Context retriever — hybrid recency + semantic + pins + summary.
 *
 * Plan commit E.
 *
 * Layers (dedup by turn id):
 *   1. recency    — newest N turns, always included
 *   2. semantic   — top-K cosine matches via sqlite-vec
 *   3. pins       — exact turns referenced by @file / #task / @turn: tokens
 *   4. summary    — rule-based compaction of the remainder (A3-safe)
 *
 * Safety rails:
 *   - sqlite-vec missing → semantic layer skipped, warned once
 *   - NullEmbeddingProvider → semantic layer skipped
 *   - dimension mismatch → semantic layer skipped
 *   - pins that don't resolve → still surfaced in `extractedPins`
 */

import type { Database } from 'bun:sqlite';
import type { SessionStore } from '../db/session-store.ts';
import type { Turn } from '../orchestrator/types.ts';
import {
  cosineSimilarity,
  embeddingToBuffer,
  type EmbeddingProvider,
} from './embedding-provider.ts';
import { extractPins, type SymbolicPin } from './symbolic-pins.ts';
import { summarizeTurns, type LadderSummary } from './summary-ladder.ts';

export interface ContextBundle {
  recent: Turn[];
  semantic: Turn[];
  pins: Turn[];
  summary: LadderSummary | null;
  extractedPins: SymbolicPin[];
  metadata: RetrievalMetadata;
}

export interface RetrievalMetadata {
  totalTurns: number;
  recencyCount: number;
  semanticHits: number;
  pinCount: number;
  summarizedTurns: number;
  tokenEstimate: number;
  semanticEnabled: boolean;
  semanticSkipReason?: string;
}

export interface RetrieverOptions {
  recencyWindow: number;
  semanticTopK: number;
  maxTokens: number;
  semanticThreshold: number;
}

const DEFAULT_OPTIONS: RetrieverOptions = {
  recencyWindow: 6,
  semanticTopK: 5,
  maxTokens: 4000,
  semanticThreshold: 0.45,
};

function estimateTurnTokens(turn: Turn): number {
  let chars = 0;
  for (const block of turn.blocks) {
    if (block.type === 'text') chars += block.text.length;
    else if (block.type === 'thinking') chars += block.thinking.length;
    else if (block.type === 'tool_use') chars += 32 + JSON.stringify(block.input).length;
    else if (block.type === 'tool_result') chars += 32 + block.content.length;
  }
  return Math.ceil(chars / 3.5);
}

function flattenVisibleText(turn: Turn): string {
  const parts: string[] = [];
  for (const block of turn.blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(`[tool:${block.name}]`);
    else if (block.type === 'tool_result') parts.push(block.content);
  }
  return parts.join(' ');
}

export class ContextRetriever {
  private readonly opts: RetrieverOptions;
  private readonly vecAvailable: boolean;
  private semanticWarned = false;

  constructor(
    private readonly db: Database,
    private readonly sessionStore: SessionStore,
    private readonly embeddings: EmbeddingProvider,
    options: Partial<RetrieverOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.vecAvailable = this.probeVec();
  }

  private probeVec(): boolean {
    try {
      const row = this.db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='turn_embeddings'",
        )
        .get();
      return !!row;
    } catch {
      return false;
    }
  }

  async indexTurn(turn: Turn): Promise<void> {
    if (!this.vecAvailable) return;
    if (!this.embeddings.active) return;

    try {
      const text = flattenVisibleText(turn);
      if (text.trim().length === 0) return;
      const [vector] = await this.embeddings.embed([text]);
      if (!vector) return;
      if (vector.length !== this.embeddings.dimension) {
        console.warn(
          `[vinyan] retriever.indexTurn: dimension mismatch (${vector.length} vs ${this.embeddings.dimension})`,
        );
        return;
      }
      const buf = embeddingToBuffer(vector);
      this.db.run(
        'INSERT OR REPLACE INTO turn_embeddings (turn_id, embedding) VALUES (?, ?)',
        [turn.id, buf],
      );
      this.db.run(
        `INSERT OR REPLACE INTO turn_embedding_meta (turn_id, model_id, dimension, indexed_at)
         VALUES (?, ?, ?, ?)`,
        [turn.id, this.embeddings.id, this.embeddings.dimension, Date.now()],
      );
    } catch (err) {
      console.warn(`[vinyan] retriever.indexTurn failed: ${String(err)}`);
    }
  }

  async retrieve(sessionId: string, userMessage: string): Promise<ContextBundle> {
    const totalTurns = this.sessionStore.countTurns(sessionId);

    const recent = this.sessionStore.getRecentTurns(sessionId, this.opts.recencyWindow);
    const recentIds = new Set(recent.map((t) => t.id));

    const { semantic, skipReason } = await this.semanticLayer(
      sessionId,
      userMessage,
      recentIds,
    );

    const extractedPins = extractPins(userMessage);
    const pins = this.resolvePins(
      sessionId,
      extractedPins,
      recentIds,
      new Set(semantic.map((t) => t.id)),
    );

    const heldIds = new Set<string>([
      ...recentIds,
      ...semantic.map((t) => t.id),
      ...pins.map((t) => t.id),
    ]);
    const summary = this.buildSummary(sessionId, heldIds, totalTurns);

    const { held: enforcedSemantic, dropped } = this.enforceBudget(
      recent,
      semantic,
      pins,
      summary,
    );

    const tokenEstimate =
      [...recent, ...enforcedSemantic, ...pins].reduce(
        (n, t) => n + estimateTurnTokens(t),
        0,
      ) + (summary ? Math.ceil(summary.text.length / 3.5) : 0);

    const finalSummary = dropped.length > 0
      ? mergeSummaryWithDropped(summary, dropped)
      : summary;

    return {
      recent,
      semantic: enforcedSemantic,
      pins,
      summary: finalSummary,
      extractedPins,
      metadata: {
        totalTurns,
        recencyCount: recent.length,
        semanticHits: enforcedSemantic.length,
        pinCount: pins.length,
        summarizedTurns: finalSummary?.summarizedTurns ?? 0,
        tokenEstimate,
        semanticEnabled: this.vecAvailable && this.embeddings.active,
        semanticSkipReason: skipReason,
      },
    };
  }

  private async semanticLayer(
    sessionId: string,
    userMessage: string,
    recentIds: Set<string>,
  ): Promise<{ semantic: Turn[]; skipReason?: string }> {
    if (!this.vecAvailable) {
      this.warnSemanticOnce('sqlite-vec extension not loaded');
      return { semantic: [], skipReason: 'sqlite-vec-unavailable' };
    }
    if (!this.embeddings.active) {
      this.warnSemanticOnce(`embedding provider inactive (${this.embeddings.id})`);
      return { semantic: [], skipReason: 'null-embedding-provider' };
    }

    let query: Float32Array;
    try {
      const [q] = await this.embeddings.embed([userMessage]);
      if (!q) return { semantic: [], skipReason: 'embed-empty-result' };
      query = q;
    } catch (err) {
      console.warn(`[vinyan] retriever.semantic embed failed: ${String(err)}`);
      return { semantic: [], skipReason: `embed-error: ${String(err).slice(0, 80)}` };
    }

    if (query.length !== this.embeddings.dimension) {
      return { semantic: [], skipReason: 'dimension-mismatch' };
    }

    try {
      const hits = this.db
        .query(
          `SELECT te.turn_id, vec_distance_cosine(te.embedding, ?) AS distance
           FROM turn_embeddings te
           JOIN session_turns st ON st.id = te.turn_id
           WHERE st.session_id = ?
           ORDER BY distance ASC
           LIMIT ?`,
        )
        .all(embeddingToBuffer(query), sessionId, this.opts.semanticTopK * 3) as Array<{
        turn_id: string;
        distance: number;
      }>;

      const admitted: Turn[] = [];
      for (const { turn_id, distance } of hits) {
        if (recentIds.has(turn_id)) continue;
        const similarity = 1 - distance;
        if (similarity < this.opts.semanticThreshold) continue;
        const turn = this.sessionStore.getTurn(turn_id);
        if (turn) admitted.push(turn);
        if (admitted.length >= this.opts.semanticTopK) break;
      }
      return { semantic: admitted };
    } catch (err) {
      console.warn(`[vinyan] retriever.semantic query failed: ${String(err)}`);
      return { semantic: [], skipReason: `query-error: ${String(err).slice(0, 80)}` };
    }
  }

  private warnSemanticOnce(reason: string): void {
    if (this.semanticWarned) return;
    this.semanticWarned = true;
    console.warn(`[vinyan] retriever: semantic recall disabled — ${reason}`);
  }

  private resolvePins(
    sessionId: string,
    pins: SymbolicPin[],
    recentIds: Set<string>,
    semanticIds: Set<string>,
  ): Turn[] {
    if (pins.length === 0) return [];
    const resolved: Turn[] = [];
    const seen = new Set<string>();

    for (const pin of pins) {
      if (pin.kind === 'turn') {
        const turn = this.sessionStore.getTurn(pin.value);
        if (!turn || turn.sessionId !== sessionId) continue;
        if (seen.has(turn.id) || recentIds.has(turn.id) || semanticIds.has(turn.id)) continue;
        resolved.push(turn);
        seen.add(turn.id);
      }
    }
    return resolved;
  }

  private buildSummary(
    sessionId: string,
    heldIds: Set<string>,
    totalTurns: number,
  ): LadderSummary | null {
    if (totalTurns <= heldIds.size) return null;
    const all = this.sessionStore.getTurns(sessionId);
    const untouched = all.filter((t) => !heldIds.has(t.id));
    return summarizeTurns(untouched);
  }

  private enforceBudget(
    recent: Turn[],
    semantic: Turn[],
    pins: Turn[],
    summary: LadderSummary | null,
  ): { held: Turn[]; dropped: Turn[] } {
    const held = [...semantic];
    const dropped: Turn[] = [];
    const budget =
      this.opts.maxTokens -
      recent.reduce((n, t) => n + estimateTurnTokens(t), 0) -
      pins.reduce((n, t) => n + estimateTurnTokens(t), 0) -
      (summary ? Math.ceil(summary.text.length / 3.5) : 0);

    while (
      held.length > 0 &&
      held.reduce((n, t) => n + estimateTurnTokens(t), 0) > budget
    ) {
      const turn = held.pop();
      if (turn) dropped.push(turn);
    }
    return { held, dropped };
  }
}

function mergeSummaryWithDropped(
  summary: LadderSummary | null,
  dropped: readonly Turn[],
): LadderSummary | null {
  const extra = summarizeTurns(dropped);
  if (!summary) return extra;
  if (!extra) return summary;
  return {
    text: `${summary.text}\n[DROPPED (budget): ${extra.summarizedTurns} turns] ${extra.text}`,
    summarizedTurns: summary.summarizedTurns + extra.summarizedTurns,
    filesDiscussed: Array.from(
      new Set([...summary.filesDiscussed, ...extra.filesDiscussed]),
    ).slice(0, 10),
    openClarifications: [...summary.openClarifications, ...extra.openClarifications],
    resolvedClarifications: [
      ...summary.resolvedClarifications,
      ...extra.resolvedClarifications,
    ],
    // Phase 1 port: concatenate KEY-DECISION lines; order is
    // summary-first then dropped-batch since summary was built from the
    // older span. No re-ranking across the boundary.
    decisionLines: [...summary.decisionLines, ...extra.decisionLines],
  };
}

// Re-export so downstream callers don't need separate imports
export { cosineSimilarity } from './embedding-provider.ts';

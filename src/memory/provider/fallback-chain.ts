/**
 * MemoryFallbackChain — primary + ordered fallback providers (W1 PR #2 / P2).
 *
 * Purpose:
 *   - Reads (`search`) fall through on primary error to the next provider
 *     in order until one returns. This is the tier-aware safety net that
 *     lets a failing plugin degrade to `default` rather than taking the
 *     agent offline (Decision 22).
 *
 *   - Writes go to the primary only — they do NOT fall through on primary
 *     failure (prevents data drift between providers). During a short
 *     `shadowWriteMs` window, writes also dual-write to each fallback so a
 *     new primary can warm up without losing data (w1-contracts §5).
 *
 *   - `invalidate`, `consolidate`, `healthCheck` broadcast to every
 *     provider and aggregate — health returns the worst.
 *
 * Axiom anchors:
 *   A3 — ordering + fallthrough are rule-based; no LLM in the chain's
 *        decision path.
 *   A5 — never lose a deterministic datum when a probabilistic plugin
 *        takes over (shadow-write window + primary-only write semantics).
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import type {
  ConsolidationReport,
  HealthReport,
  MemoryHit,
  MemoryProvider,
  MemoryRecord,
  SearchOpts,
  WriteAck,
} from './types.ts';

// ── Options ────────────────────────────────────────────────────────────

export interface FallbackChainOptions {
  readonly primary: MemoryProvider;
  readonly fallbacks: readonly MemoryProvider[];
  /**
   * For how long (ms from construction) writes shadow to fallbacks. Default
   * 0 = no shadow. Wall-clock, not per-write.
   */
  readonly shadowWriteMs?: number;
  /** Injection for tests. */
  readonly clock?: () => number;
}

// ── Chain ───────────────────────────────────────────────────────────────

export class MemoryFallbackChain implements MemoryProvider {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly tierSupport: readonly ConfidenceTier[];

  private readonly primary: MemoryProvider;
  private readonly fallbacks: readonly MemoryProvider[];
  private readonly shadowWriteMs: number;
  private readonly clock: () => number;
  private readonly constructedAt: number;

  constructor(opts: FallbackChainOptions) {
    this.primary = opts.primary;
    this.fallbacks = [...opts.fallbacks];
    this.shadowWriteMs = opts.shadowWriteMs ?? 0;
    this.clock = opts.clock ?? Date.now;
    this.constructedAt = this.clock();

    this.id = `vinyan.fallback[${[opts.primary.id, ...this.fallbacks.map((p) => p.id)].join(',')}]`;
    // Capability surface is the union — any call site needing a capability
    // checks this union, and we walk the chain at call time.
    const capSet = new Set<string>([...opts.primary.capabilities]);
    for (const p of opts.fallbacks) for (const c of p.capabilities) capSet.add(c);
    this.capabilities = [...capSet];
    // Tier support is the union — a chain can serve any tier supported
    // anywhere in the chain.
    const tierSet = new Set<ConfidenceTier>([...opts.primary.tierSupport]);
    for (const p of opts.fallbacks) for (const t of p.tierSupport) tierSet.add(t);
    this.tierSupport = [...tierSet];
  }

  // ── write ────────────────────────────────────────────────────────────

  async write(record: Omit<MemoryRecord, 'id'>): Promise<WriteAck> {
    const ack = await this.primary.write(record);
    if (!ack.ok) return ack; // never fall through on write failure (A5)

    // Shadow window: also write to every fallback, best-effort.
    if (this.inShadowWindow()) {
      for (const fb of this.fallbacks) {
        try {
          await fb.write(record);
        } catch {
          // Shadow writes never break the primary path.
        }
      }
    }
    return ack;
  }

  // ── search ───────────────────────────────────────────────────────────

  async search(query: string, opts: SearchOpts): Promise<readonly MemoryHit[]> {
    const providers = [this.primary, ...this.fallbacks];
    let lastError: unknown = null;
    for (const p of providers) {
      try {
        return await p.search(query, opts);
      } catch (err) {
        lastError = err;
        // Fall through to next provider.
      }
    }
    // All providers errored — return empty and let callers treat it as a
    // cache miss. We do not re-throw: callers expect an array.
    void lastError;
    return [];
  }

  // ── invalidate / consolidate / health ────────────────────────────────

  async invalidate(contentHash: string): Promise<{ readonly removed: number }> {
    let removed = 0;
    for (const p of [this.primary, ...this.fallbacks]) {
      try {
        const r = await p.invalidate(contentHash);
        removed += r.removed;
      } catch {
        // Ignore — a failing provider does not block the others.
      }
    }
    return { removed };
  }

  async consolidate(): Promise<ConsolidationReport> {
    // Aggregate the primary's report only — fallbacks are read-only safety
    // nets once the shadow window closes and should not drive consolidation.
    try {
      return await this.primary.consolidate();
    } catch {
      return {
        scanned: 0,
        promoted: 0,
        demoted: 0,
        invalidated: 0,
        lowConfidenceFlagged: [],
        nudges: [],
      };
    }
  }

  async healthCheck(): Promise<HealthReport> {
    const reports: HealthReport[] = [];
    for (const p of [this.primary, ...this.fallbacks]) {
      try {
        reports.push(await p.healthCheck());
      } catch (err) {
        reports.push({
          ok: false,
          latencyMs: 0,
          notes: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Worst-of: ok only when ALL report ok; take max latency; concatenate
    // notes so operators can see which provider is sick.
    const allOk = reports.every((r) => r.ok);
    const latencyMs = reports.reduce((acc, r) => Math.max(acc, r.latencyMs), 0);
    const sickNotes = reports
      .filter((r) => !r.ok && r.notes)
      .map((r) => r.notes as string)
      .join('; ');
    return {
      ok: allOk,
      latencyMs,
      ...(sickNotes ? { notes: sickNotes } : {}),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────

  private inShadowWindow(): boolean {
    if (this.shadowWriteMs <= 0) return false;
    return this.clock() - this.constructedAt < this.shadowWriteMs;
  }
}

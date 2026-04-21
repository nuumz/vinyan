/**
 * MemoryFallbackChain — behavior tests.
 *
 * Covers the primary-first read/write semantics + shadow-write window +
 * health aggregation rules. Uses hand-rolled MemoryProvider stubs to isolate
 * chain behavior from storage concerns.
 */
import { describe, expect, it } from 'bun:test';
import type { ConfidenceTier } from '../../../src/core/confidence-tier.ts';
import { MemoryFallbackChain } from '../../../src/memory/provider/fallback-chain.ts';
import type {
  ConsolidationReport,
  HealthReport,
  MemoryHit,
  MemoryProvider,
  MemoryRecord,
  SearchOpts,
  WriteAck,
} from '../../../src/memory/provider/types.ts';

// ── Stubs ───────────────────────────────────────────────────────────────

class StubProvider implements MemoryProvider {
  readonly id: string;
  readonly capabilities: readonly string[] = ['stub'];
  readonly tierSupport: readonly ConfidenceTier[] = ['deterministic', 'heuristic'];
  writes: Array<Omit<MemoryRecord, 'id'>> = [];
  hitsQueue: readonly MemoryHit[] = [];
  searchError: Error | null = null;
  writeError: Error | null = null;
  writeAck: WriteAck | null = null;
  invalidateRemoved = 0;
  health: HealthReport = { ok: true, latencyMs: 1 };
  healthThrow: Error | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async write(record: Omit<MemoryRecord, 'id'>): Promise<WriteAck> {
    if (this.writeError) throw this.writeError;
    this.writes.push(record);
    if (this.writeAck) return this.writeAck;
    return { ok: true, id: `id-${this.writes.length}`, tier: record.evidenceTier };
  }

  async search(_q: string, _opts: SearchOpts): Promise<readonly MemoryHit[]> {
    if (this.searchError) throw this.searchError;
    return this.hitsQueue;
  }

  async invalidate(_hash: string): Promise<{ readonly removed: number }> {
    return { removed: this.invalidateRemoved };
  }

  async consolidate(): Promise<ConsolidationReport> {
    return {
      scanned: 0,
      promoted: 0,
      demoted: 0,
      invalidated: 0,
      lowConfidenceFlagged: [],
      nudges: [],
    };
  }

  async healthCheck(): Promise<HealthReport> {
    if (this.healthThrow) throw this.healthThrow;
    return this.health;
  }
}

function sampleRecord(): Omit<MemoryRecord, 'id'> {
  return {
    profile: 'default',
    kind: 'fact',
    content: 'alpha',
    confidence: 0.5,
    evidenceTier: 'heuristic',
    evidenceChain: [],
    temporalContext: { createdAt: 1_700_000_000_000 },
  };
}

function sampleHit(id: string): MemoryHit {
  return {
    record: {
      id,
      profile: 'default',
      kind: 'fact',
      content: `c-${id}`,
      confidence: 0.5,
      evidenceTier: 'heuristic',
      evidenceChain: [],
      temporalContext: { createdAt: 1_700_000_000_000 },
    },
    score: 0.8,
    components: { similarity: 0.7, tierWeight: 0.7, recency: 0.9, predErrorPenalty: 0 },
  };
}

// ── Search fallthrough ──────────────────────────────────────────────────

describe('MemoryFallbackChain — search', () => {
  it('returns the primary result on happy path', async () => {
    const primary = new StubProvider('p');
    primary.hitsQueue = [sampleHit('from-primary')];
    const backup = new StubProvider('b');
    backup.hitsQueue = [sampleHit('from-backup')];
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup] });
    const hits = await chain.search('x', { profile: 'default' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.id).toBe('from-primary');
  });

  it('falls through to fallback when primary throws', async () => {
    const primary = new StubProvider('p');
    primary.searchError = new Error('primary down');
    const backup = new StubProvider('b');
    backup.hitsQueue = [sampleHit('from-backup')];
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup] });
    const hits = await chain.search('x', { profile: 'default' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.id).toBe('from-backup');
  });

  it('falls through multiple fallbacks in order', async () => {
    const primary = new StubProvider('p');
    primary.searchError = new Error('boom');
    const backup1 = new StubProvider('b1');
    backup1.searchError = new Error('also boom');
    const backup2 = new StubProvider('b2');
    backup2.hitsQueue = [sampleHit('from-b2')];
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup1, backup2] });
    const hits = await chain.search('x', { profile: 'default' });
    expect(hits.map((h) => h.record.id)).toEqual(['from-b2']);
  });

  it('returns empty (no throw) when every provider errors', async () => {
    const a = new StubProvider('a');
    a.searchError = new Error('a');
    const b = new StubProvider('b');
    b.searchError = new Error('b');
    const chain = new MemoryFallbackChain({ primary: a, fallbacks: [b] });
    const hits = await chain.search('x', { profile: 'default' });
    expect(hits).toEqual([]);
  });
});

// ── Write semantics ─────────────────────────────────────────────────────

describe('MemoryFallbackChain — write', () => {
  it('writes only to primary by default (no shadow window)', async () => {
    const primary = new StubProvider('p');
    const backup = new StubProvider('b');
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup] });
    const ack = await chain.write(sampleRecord());
    expect(ack.ok).toBe(true);
    expect(primary.writes.length).toBe(1);
    expect(backup.writes.length).toBe(0);
  });

  it('returns primary failure without falling through (no data drift)', async () => {
    const primary = new StubProvider('p');
    primary.writeAck = { ok: false, reason: 'schema_invalid', detail: 'bad' };
    const backup = new StubProvider('b');
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup] });
    const ack = await chain.write(sampleRecord());
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toBe('schema_invalid');
    expect(backup.writes.length).toBe(0);
  });

  it('shadow-writes to fallbacks within the configured window', async () => {
    let t = 1_000;
    const primary = new StubProvider('p');
    const backup = new StubProvider('b');
    const chain = new MemoryFallbackChain({
      primary,
      fallbacks: [backup],
      shadowWriteMs: 500,
      clock: () => t,
    });
    // Inside window
    await chain.write(sampleRecord());
    expect(backup.writes.length).toBe(1);
    // Still inside window
    t = 1_400;
    await chain.write(sampleRecord());
    expect(backup.writes.length).toBe(2);
    // After window
    t = 1_600;
    await chain.write(sampleRecord());
    expect(backup.writes.length).toBe(2);
    // Primary got every write.
    expect(primary.writes.length).toBe(3);
  });

  it('shadow-write failure does not break the primary path', async () => {
    const t = 1_000;
    const primary = new StubProvider('p');
    const backup = new StubProvider('b');
    backup.writeError = new Error('shadow down');
    const chain = new MemoryFallbackChain({
      primary,
      fallbacks: [backup],
      shadowWriteMs: 5_000,
      clock: () => t,
    });
    const ack = await chain.write(sampleRecord());
    expect(ack.ok).toBe(true);
    expect(primary.writes.length).toBe(1);
    expect(backup.writes.length).toBe(0); // threw before append
  });
});

// ── Health / invalidate ─────────────────────────────────────────────────

describe('MemoryFallbackChain — healthCheck', () => {
  it('returns ok only when every provider reports ok', async () => {
    const primary = new StubProvider('p');
    primary.health = { ok: true, latencyMs: 2 };
    const backup = new StubProvider('b');
    backup.health = { ok: false, latencyMs: 50, notes: 'replica lag' };
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup] });
    const health = await chain.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.latencyMs).toBe(50);
    expect(health.notes).toContain('replica lag');
  });

  it('aggregates latency as max', async () => {
    const a = new StubProvider('a');
    a.health = { ok: true, latencyMs: 3 };
    const b = new StubProvider('b');
    b.health = { ok: true, latencyMs: 11 };
    const chain = new MemoryFallbackChain({ primary: a, fallbacks: [b] });
    const health = await chain.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBe(11);
  });

  it('absorbs a thrown healthCheck and continues', async () => {
    const primary = new StubProvider('p');
    primary.healthThrow = new Error('crashed');
    const backup = new StubProvider('b');
    backup.health = { ok: true, latencyMs: 1 };
    const chain = new MemoryFallbackChain({ primary, fallbacks: [backup] });
    const health = await chain.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.notes).toContain('crashed');
  });
});

describe('MemoryFallbackChain — invalidate', () => {
  it('sums removed counts across every provider', async () => {
    const a = new StubProvider('a');
    a.invalidateRemoved = 2;
    const b = new StubProvider('b');
    b.invalidateRemoved = 3;
    const chain = new MemoryFallbackChain({ primary: a, fallbacks: [b] });
    const { removed } = await chain.invalidate('x');
    expect(removed).toBe(5);
  });
});

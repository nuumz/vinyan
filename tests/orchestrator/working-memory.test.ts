import { describe, expect, test } from 'bun:test';
import {
  MAX_FAILED_APPROACHES,
  MAX_HYPOTHESES,
  MAX_SCOPED_FACTS,
  MAX_UNCERTAINTIES,
  WorkingMemory,
} from '../../src/orchestrator/working-memory.ts';
import type { WorkingMemoryState } from '../../src/orchestrator/types.ts';

describe('WorkingMemory', () => {
  test('recordFailedApproach adds to snapshot', () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach('inline function', 'type: TS2322 type mismatch');
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(1);
    expect(snap.failedApproaches[0]!.approach).toBe('inline function');
    expect(snap.failedApproaches[0]!.oracleVerdict).toBe('type: TS2322 type mismatch');
    expect(snap.failedApproaches[0]!.timestamp).toBeGreaterThan(0);
  });

  test('addHypothesis adds to snapshot', () => {
    const wm = new WorkingMemory();
    wm.addHypothesis('extract to utility', 0.7, 'self-model');
    const snap = wm.getSnapshot();
    expect(snap.activeHypotheses).toHaveLength(1);
    expect(snap.activeHypotheses[0]!.hypothesis).toBe('extract to utility');
    expect(snap.activeHypotheses[0]!.confidence).toBe(0.7);
  });

  test('addUncertainty adds to snapshot', () => {
    const wm = new WorkingMemory();
    wm.addUncertainty('test coverage', 0.3, 'run tests first');
    const snap = wm.getSnapshot();
    expect(snap.unresolvedUncertainties).toHaveLength(1);
    expect(snap.unresolvedUncertainties[0]!.area).toBe('test coverage');
  });

  test('addScopedFact adds to snapshot', () => {
    const wm = new WorkingMemory();
    wm.addScopedFact('src/foo.ts', 'type-check', true, 'abc123');
    const snap = wm.getSnapshot();
    expect(snap.scopedFacts).toHaveLength(1);
    expect(snap.scopedFacts[0]!.verified).toBe(true);
  });

  test('getSnapshot returns deep copy (mutation safety)', () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach('approach A', 'failed');
    const snap1 = wm.getSnapshot();
    snap1.failedApproaches.push({ approach: 'mutated', oracleVerdict: 'x', timestamp: 0 });
    const snap2 = wm.getSnapshot();
    expect(snap2.failedApproaches).toHaveLength(1); // original unaffected
  });

  test('multiple failed approaches accumulate in order', () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach('approach A', 'reason A');
    wm.recordFailedApproach('approach B', 'reason B');
    wm.recordFailedApproach('approach C', 'reason C');
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(3);
    expect(snap.failedApproaches[0]!.approach).toBe('approach A');
    expect(snap.failedApproaches[2]!.approach).toBe('approach C');
  });

  // ── Bounded eviction tests ─────────────────────────────────────────────────

  test(`failedApproaches: evicts lowest confidence at cap (MAX=${MAX_FAILED_APPROACHES})`, () => {
    const wm = new WorkingMemory();
    for (let i = 0; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(`approach-${i}`, `verdict-${i}`, (i + 1) * 0.05);
    }
    expect(wm.getSnapshot().failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);

    // Adding the 21st entry evicts approach-0 (lowest confidence = 0.05)
    wm.recordFailedApproach('approach-new', 'verdict-new', 0.9);
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);
    const names = snap.failedApproaches.map((f) => f.approach);
    expect(names).not.toContain('approach-0');
    expect(names).toContain('approach-new');
  });

  test(`activeHypotheses: evicts lowest confidence at cap (MAX=${MAX_HYPOTHESES})`, () => {
    const wm = new WorkingMemory();
    // Fill with confidences 0.1 through 1.0
    for (let i = 0; i < MAX_HYPOTHESES; i++) {
      wm.addHypothesis(`hypothesis-${i}`, (i + 1) * 0.1, 'llm');
    }
    expect(wm.getSnapshot().activeHypotheses).toHaveLength(MAX_HYPOTHESES);

    // hypothesis-0 has confidence 0.1 — should be evicted
    wm.addHypothesis('hypothesis-new', 0.95, 'llm');
    const snap = wm.getSnapshot();
    expect(snap.activeHypotheses).toHaveLength(MAX_HYPOTHESES);
    const names = snap.activeHypotheses.map((h) => h.hypothesis);
    expect(names).not.toContain('hypothesis-0');
    expect(names).toContain('hypothesis-new');
  });

  test(`unresolvedUncertainties: FIFO eviction at cap (MAX=${MAX_UNCERTAINTIES})`, () => {
    const wm = new WorkingMemory();
    for (let i = 0; i < MAX_UNCERTAINTIES; i++) {
      wm.addUncertainty(`area-${i}`, 0.5, 'investigate');
    }
    expect(wm.getSnapshot().unresolvedUncertainties).toHaveLength(MAX_UNCERTAINTIES);

    // Adding the 11th entry evicts area-0 (oldest)
    wm.addUncertainty('area-new', 0.3, 'retry');
    const snap = wm.getSnapshot();
    expect(snap.unresolvedUncertainties).toHaveLength(MAX_UNCERTAINTIES);
    expect(snap.unresolvedUncertainties[0]!.area).toBe('area-1');
    expect(snap.unresolvedUncertainties[MAX_UNCERTAINTIES - 1]!.area).toBe('area-new');
  });

  test(`scopedFacts: FIFO eviction at cap (MAX=${MAX_SCOPED_FACTS})`, () => {
    const wm = new WorkingMemory();
    for (let i = 0; i < MAX_SCOPED_FACTS; i++) {
      wm.addScopedFact(`src/file-${i}.ts`, '*.ts', true, `hash-${i}`);
    }
    expect(wm.getSnapshot().scopedFacts).toHaveLength(MAX_SCOPED_FACTS);

    // Adding the 51st entry evicts file-0 (oldest)
    wm.addScopedFact('src/file-new.ts', '*.ts', false, 'hash-new');
    const snap = wm.getSnapshot();
    expect(snap.scopedFacts).toHaveLength(MAX_SCOPED_FACTS);
    expect(snap.scopedFacts[0]!.target).toBe('src/file-1.ts');
    expect(snap.scopedFacts[MAX_SCOPED_FACTS - 1]!.target).toBe('src/file-new.ts');
  });

  test('confidence-based eviction always keeps higher confidence hypotheses', () => {
    const wm = new WorkingMemory();
    // Add 9 high-confidence hypotheses and 1 low-confidence
    for (let i = 0; i < 9; i++) {
      wm.addHypothesis(`high-${i}`, 0.9, 'llm');
    }
    wm.addHypothesis('low-conf', 0.1, 'llm');
    expect(wm.getSnapshot().activeHypotheses).toHaveLength(MAX_HYPOTHESES);

    // Adding another high-confidence entry must evict "low-conf"
    wm.addHypothesis('newer-high', 0.85, 'llm');
    const snap = wm.getSnapshot();
    const names = snap.activeHypotheses.map((h) => h.hypothesis);
    expect(names).not.toContain('low-conf');
    expect(names).toContain('newer-high');
    snap.activeHypotheses.forEach((h) => expect(h.confidence).toBeGreaterThanOrEqual(0.85));
  });

  test('getSnapshot returns deep copy — field mutation does not affect internal state', () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach('original', 'oracle-rejected');

    const snap1 = wm.getSnapshot();
    snap1.failedApproaches[0]!.approach = 'mutated';
    snap1.failedApproaches.push({ approach: 'injected', oracleVerdict: 'none', timestamp: 0 });

    const snap2 = wm.getSnapshot();
    expect(snap2.failedApproaches).toHaveLength(1);
    expect(snap2.failedApproaches[0]!.approach).toBe('original');
  });

  // ── EO #8: Confidence-Aware Retry ──────────────────────────────────────────

  test('recordFailedApproach stores verdictConfidence and failureOracle', () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach('bad approach', 'type error', 0.85, 'type');
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches[0]!.verdictConfidence).toBe(0.85);
    expect(snap.failedApproaches[0]!.failureOracle).toBe('type');
  });

  test('eviction removes lowest confidence approach instead of oldest', () => {
    const wm = new WorkingMemory();
    // Fill to capacity: first entry has low confidence, rest have high
    wm.recordFailedApproach('low-conf', 'verdict-low', 0.1, 'ast');
    for (let i = 1; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(`high-conf-${i}`, `verdict-${i}`, 0.9, 'test');
    }
    expect(wm.getSnapshot().failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);

    // Trigger eviction — low-conf (0.1) should be evicted, not the oldest high-conf
    wm.recordFailedApproach('new-entry', 'verdict-new', 0.8, 'lint');
    const snap = wm.getSnapshot();
    const names = snap.failedApproaches.map((f) => f.approach);
    expect(names).not.toContain('low-conf');
    expect(names).toContain('new-entry');
  });

  test('undefined confidence treated as 0.5 (neutral) for eviction priority', () => {
    const wm = new WorkingMemory();
    // Entry without confidence (undefined → 0.5 neutral for eviction)
    wm.recordFailedApproach('no-conf', 'verdict-none');
    // Entry with low explicit confidence — should be evicted before no-conf
    wm.recordFailedApproach('low-conf', 'verdict-low', 0.1);
    for (let i = 2; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(`with-conf-${i}`, `verdict-${i}`, 0.7);
    }
    expect(wm.getSnapshot().failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);

    // Trigger eviction — low-conf (0.1) should be evicted before no-conf (0.5)
    wm.recordFailedApproach('trigger', 'verdict-trigger', 0.6);
    const snap = wm.getSnapshot();
    const names = snap.failedApproaches.map((f) => f.approach);
    expect(names).not.toContain('low-conf');
    expect(names).toContain('no-conf'); // undefined treated as 0.5, kept over 0.1
    expect(names).toContain('trigger');
  });

  test('backwards compatible: old 2-arg calls still work', () => {
    const wm = new WorkingMemory();
    wm.recordFailedApproach('legacy-call', 'some verdict');
    const snap = wm.getSnapshot();
    expect(snap.failedApproaches).toHaveLength(1);
    expect(snap.failedApproaches[0]!.approach).toBe('legacy-call');
    expect(snap.failedApproaches[0]!.verdictConfidence).toBeUndefined();
    expect(snap.failedApproaches[0]!.failureOracle).toBeUndefined();
  });

  test('eviction picks correct minimum when confidences are mixed', () => {
    const wm = new WorkingMemory();
    const confidences = [0.5, 0.3, 0.8, 0.1, 0.6, 0.9, 0.4, 0.7, 0.2, 0.95,
      0.55, 0.35, 0.85, 0.15, 0.65, 0.88, 0.45, 0.75, 0.25, 0.92];
    for (let i = 0; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(`approach-${i}`, `verdict-${i}`, confidences[i]);
    }

    // approach-3 has confidence 0.1 (lowest) — should be evicted
    wm.recordFailedApproach('newcomer', 'verdict-new', 0.5);
    const snap = wm.getSnapshot();
    const names = snap.failedApproaches.map((f) => f.approach);
    expect(names).not.toContain('approach-3');
    expect(names).toContain('newcomer');
    expect(snap.failedApproaches).toHaveLength(MAX_FAILED_APPROACHES);
  });

  // ── Wave 1 gap fix: idempotent hydration flags ──────────────────────
  test('session hydration flag defaults to false', () => {
    const wm = new WorkingMemory();
    expect(wm.isSessionHydrated()).toBe(false);
  });

  test('markSessionHydrated flips the flag', () => {
    const wm = new WorkingMemory();
    wm.markSessionHydrated();
    expect(wm.isSessionHydrated()).toBe(true);
  });

  test('cross-task loaded flag defaults to false', () => {
    const wm = new WorkingMemory();
    expect(wm.isCrossTaskLoaded()).toBe(false);
  });

  test('markCrossTaskLoaded flips the flag', () => {
    const wm = new WorkingMemory();
    wm.markCrossTaskLoaded();
    expect(wm.isCrossTaskLoaded()).toBe(true);
  });

  test('flags are independent', () => {
    const wm = new WorkingMemory();
    wm.markSessionHydrated();
    expect(wm.isSessionHydrated()).toBe(true);
    expect(wm.isCrossTaskLoaded()).toBe(false);
  });

  // ── A5/A7 evidence-chain preservation on eviction ───────────────────
  // Regression guard: the archiver is called with the FULL entry
  // (approach + oracleVerdict + verdictConfidence + failureOracle +
  // classifiedFailures) BEFORE the entry is removed from working memory.
  // No evidence is orphaned from its verdict during eviction.

  test('archiver receives full entry (approach + verdict + evidence) BEFORE eviction', () => {
    const archived: Array<WorkingMemoryState['failedApproaches'][number]> = [];
    const wm = new WorkingMemory({ archiver: (e) => archived.push(e) });

    // Fill to cap with low-confidence entries, each carrying structured
    // failure evidence. The next insertion must evict the lowest-confidence
    // entry and hand its COMPLETE payload (including classifiedFailures)
    // to the archiver — no silent loss of the forensic trail.
    for (let i = 0; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(
        `approach-${i}`,
        `verdict-${i}`,
        0.5,
        'type',
        [
          {
            category: 'type-error',
            file: `src/f${i}.ts`,
            line: i + 1,
            message: `msg-${i}`,
            severity: 'error',
          },
        ],
      );
    }
    // Insert one more with lower confidence — the EVICTED entry is NOT
    // this new one (it has min-confidence amongst pre-existing = the
    // first one at 0.5), the archiver gets that full entry.
    wm.recordFailedApproach('pushes-eviction', 'v', 0.4, 'ast');

    expect(archived.length).toBe(1);
    const evicted = archived[0]!;
    // Evidence chain travels WITH the verdict.
    expect(evicted.approach).toMatch(/approach-/);
    expect(evicted.oracleVerdict).toMatch(/verdict-/);
    expect(evicted.failureOracle).toBe('type');
    expect(evicted.verdictConfidence).toBe(0.5);
    expect(evicted.classifiedFailures).toBeDefined();
    expect(evicted.classifiedFailures!.length).toBe(1);
    expect(evicted.classifiedFailures![0]!.category).toBe('type-error');
    expect(evicted.classifiedFailures![0]!.file).toMatch(/^src\/f/);
  });

  test('archiver not invoked when eviction does NOT occur (below cap)', () => {
    const archived: unknown[] = [];
    const wm = new WorkingMemory({ archiver: (e) => archived.push(e) });
    wm.recordFailedApproach('a', 'v', 0.5);
    expect(archived.length).toBe(0);
  });

  test('archiver throwing does not block eviction (best-effort)', () => {
    const wm = new WorkingMemory({
      archiver: () => {
        throw new Error('storage offline');
      },
    });
    for (let i = 0; i < MAX_FAILED_APPROACHES; i++) {
      wm.recordFailedApproach(`a-${i}`, 'v', 0.5);
    }
    // Should not throw — the eviction path tolerates archiver failures.
    expect(() => wm.recordFailedApproach('post', 'v', 0.4)).not.toThrow();
    expect(wm.getSnapshot().failedApproaches.length).toBe(MAX_FAILED_APPROACHES);
  });
});

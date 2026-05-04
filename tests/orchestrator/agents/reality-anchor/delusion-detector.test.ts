/**
 * Tests for `detectDelusions` — Phase C2 reality-anchor.
 *
 * Behavior-only: every assertion exercises the pure function and verifies
 * the documented contract.
 *
 * Coverage:
 *   - empty inputs: kind 'consistent', rate 0, attenuation 1
 *   - single stale citation: kind 'delusion', rate matches, attenuation < 1
 *   - matching citation: kind 'consistent' even though we checked
 *   - out-of-scope (currentFileHashes missing factId): NOT counted as stale
 *   - latest-per-fact dedup: persona cited fact twice, only newer used
 *   - mixed: some stale, some consistent, some out-of-scope
 *   - attenuation floor 0.5 (severe delusion can't fully collapse confidence)
 *   - attenuateForDelusion helper composes correctly with confidence
 *   - determinism: same input → same output (A8 replay)
 */
import { describe, expect, test } from 'bun:test';
import type { PersonaFactCitationRecord } from '../../../../src/db/persona-fact-citations-store.ts';
import {
  attenuateForDelusion,
  detectDelusions,
} from '../../../../src/orchestrator/agents/reality-anchor/delusion-detector.ts';

function makeCitation(overrides: Partial<PersonaFactCitationRecord> = {}): PersonaFactCitationRecord {
  return {
    personaId: 'researcher',
    factId: 'src/x.ts',
    citedAtHash: 'h-cited',
    citedAtTs: 1000,
    taskId: 't-1',
    phase: 'verify',
    claimExcerpt: 'a claim',
    ...overrides,
  };
}

describe('detectDelusions — empty / consistent paths', () => {
  test('no citations + empty hash map → consistent, rate 0', () => {
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => [],
      currentFileHashes: new Map(),
    });
    expect(result.kind).toBe('consistent');
    expect(result.falsified).toEqual([]);
    expect(result.scopedCount).toBe(0);
    expect(result.delusionRate).toBe(0);
    expect(result.attenuation).toBe(1);
  });

  test('single citation matching current hash → consistent, rate 0', () => {
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => [makeCitation({ factId: 'a', citedAtHash: 'h1' })],
      currentFileHashes: new Map([['a', 'h1']]),
    });
    expect(result.kind).toBe('consistent');
    expect(result.scopedCount).toBe(1);
    expect(result.delusionRate).toBe(0);
    expect(result.attenuation).toBe(1);
  });

  test('citation OUT OF SCOPE (factId not in currentFileHashes) → not counted', () => {
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => [makeCitation({ factId: 'gone', citedAtHash: 'h1' })],
      currentFileHashes: new Map(), // empty — gone is out of scope
    });
    expect(result.kind).toBe('consistent');
    expect(result.scopedCount).toBe(0);
    expect(result.delusionRate).toBe(0);
    // Out-of-scope is the documented "skip", not "stale" — checked next cycle.
    expect(result.falsified).toEqual([]);
  });
});

describe('detectDelusions — stale paths', () => {
  test('one stale citation → kind delusion, attenuation matches formula', () => {
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => [makeCitation({ factId: 'a', citedAtHash: 'h-old' })],
      currentFileHashes: new Map([['a', 'h-NEW']]),
    });
    expect(result.kind).toBe('delusion');
    expect(result.falsified).toHaveLength(1);
    expect(result.falsified[0]?.factId).toBe('a');
    expect(result.falsified[0]?.citedAtHash).toBe('h-old');
    expect(result.falsified[0]?.currentHash).toBe('h-NEW');
    expect(result.scopedCount).toBe(1);
    expect(result.delusionRate).toBe(1);
    expect(result.attenuation).toBe(0.5); // floor
  });

  test('1 of 5 stale → rate 0.2, attenuation 0.8', () => {
    const cites: PersonaFactCitationRecord[] = [
      makeCitation({ factId: 'a', citedAtHash: 'h-old' }),
      makeCitation({ factId: 'b', citedAtHash: 'h2' }),
      makeCitation({ factId: 'c', citedAtHash: 'h3' }),
      makeCitation({ factId: 'd', citedAtHash: 'h4' }),
      makeCitation({ factId: 'e', citedAtHash: 'h5' }),
    ];
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => cites,
      currentFileHashes: new Map([
        ['a', 'h-NEW'],
        ['b', 'h2'],
        ['c', 'h3'],
        ['d', 'h4'],
        ['e', 'h5'],
      ]),
    });
    expect(result.kind).toBe('delusion');
    expect(result.falsified).toHaveLength(1);
    expect(result.scopedCount).toBe(5);
    expect(result.delusionRate).toBeCloseTo(0.2, 5);
    expect(result.attenuation).toBeCloseTo(0.8, 5);
  });

  test('attenuation floor: every citation stale still bottoms at 0.5', () => {
    const cites: PersonaFactCitationRecord[] = [
      makeCitation({ factId: 'a', citedAtHash: 'old' }),
      makeCitation({ factId: 'b', citedAtHash: 'old' }),
      makeCitation({ factId: 'c', citedAtHash: 'old' }),
    ];
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => cites,
      currentFileHashes: new Map([
        ['a', 'new'],
        ['b', 'new'],
        ['c', 'new'],
      ]),
    });
    expect(result.delusionRate).toBe(1);
    expect(result.attenuation).toBe(0.5);
  });
});

describe('detectDelusions — latest-per-fact dedup', () => {
  test('persona cited same fact twice — only LATEST citation used', () => {
    // listForPersona returns newest-first; the detector dedupes by first-seen.
    const cites: PersonaFactCitationRecord[] = [
      makeCitation({ factId: 'a', citedAtHash: 'h-LATEST', citedAtTs: 2000 }),
      makeCitation({ factId: 'a', citedAtHash: 'h-old', citedAtTs: 1000 }),
    ];
    // Current hash matches the LATEST citation → consistent.
    const a = detectDelusions({
      personaId: 'p',
      recentCitations: () => cites,
      currentFileHashes: new Map([['a', 'h-LATEST']]),
    });
    expect(a.kind).toBe('consistent');
    expect(a.scopedCount).toBe(1);

    // Current hash matches only the OLDER citation → still stale (latest wins).
    const b = detectDelusions({
      personaId: 'p',
      recentCitations: () => cites,
      currentFileHashes: new Map([['a', 'h-old']]),
    });
    expect(b.kind).toBe('delusion');
    expect(b.falsified[0]?.citedAtHash).toBe('h-LATEST');
  });

  test('different facts not collapsed by dedup', () => {
    const cites: PersonaFactCitationRecord[] = [
      makeCitation({ factId: 'a', citedAtHash: 'h-a' }),
      makeCitation({ factId: 'b', citedAtHash: 'h-b' }),
    ];
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => cites,
      currentFileHashes: new Map([
        ['a', 'h-a'],
        ['b', 'h-b'],
      ]),
    });
    expect(result.scopedCount).toBe(2);
  });
});

describe('detectDelusions — mixed scoping', () => {
  test('consistent + stale + out-of-scope coexist correctly', () => {
    const cites: PersonaFactCitationRecord[] = [
      makeCitation({ factId: 'consistent', citedAtHash: 'h1' }),
      makeCitation({ factId: 'stale', citedAtHash: 'h-old' }),
      makeCitation({ factId: 'out-of-scope', citedAtHash: 'h-historical' }),
    ];
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => cites,
      currentFileHashes: new Map([
        ['consistent', 'h1'],
        ['stale', 'h-NEW'],
        // 'out-of-scope' deliberately absent
      ]),
    });
    expect(result.kind).toBe('delusion');
    expect(result.falsified).toHaveLength(1);
    expect(result.falsified[0]?.factId).toBe('stale');
    expect(result.scopedCount).toBe(2);
    expect(result.delusionRate).toBeCloseTo(0.5, 5);
    expect(result.attenuation).toBe(0.5); // 1 - 0.5 = 0.5, hits floor
  });
});

describe('attenuateForDelusion — helper composition', () => {
  test('consistent kind passes confidence through unchanged', () => {
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => [],
      currentFileHashes: new Map(),
    });
    expect(attenuateForDelusion(0.85, result)).toBe(0.85);
  });

  test('delusion kind multiplies by attenuation', () => {
    const result = detectDelusions({
      personaId: 'p',
      recentCitations: () => [makeCitation({ citedAtHash: 'old' })],
      currentFileHashes: new Map([['src/x.ts', 'NEW']]),
    });
    expect(result.attenuation).toBe(0.5);
    expect(attenuateForDelusion(0.8, result)).toBeCloseTo(0.4, 5);
  });
});

describe('detectDelusions — determinism (A8 replay)', () => {
  test('same input produces identical output', () => {
    const inputBuilder = () => ({
      personaId: 'p',
      recentCitations: (): PersonaFactCitationRecord[] => [
        makeCitation({ factId: 'a', citedAtHash: 'old' }),
        makeCitation({ factId: 'b', citedAtHash: 'h2' }),
      ],
      currentFileHashes: new Map([
        ['a', 'NEW'],
        ['b', 'h2'],
      ]),
    });
    const r1 = detectDelusions(inputBuilder());
    const r2 = detectDelusions(inputBuilder());
    expect(r1).toEqual(r2);
  });
});

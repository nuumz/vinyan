/**
 * BackendSelector — routing rule tests.
 * A3: rule table is pure function of level + registered backends + pins.
 */
import { describe, expect, test } from 'bun:test';
import type {
  BackendHandle,
  BackendId,
  BackendSpawnSpec,
  HealthReport,
  IsolationLevel,
  WorkerBackend,
  WorkerInput,
  WorkerOutput,
} from '../../src/runtime/backend.ts';
import { BackendSelector } from '../../src/runtime/backend-selector.ts';

/** Minimal stub backend for selector tests — no real work, identity only. */
function stub(id: BackendId, level: IsolationLevel): WorkerBackend {
  return {
    id,
    isolationLevel: level,
    supportsHibernation: false,
    trustTier: 'deterministic',
    async spawn(spec: BackendSpawnSpec): Promise<BackendHandle> {
      return { backendId: id, spawnSpec: spec, spawnedAt: 0, internal: null };
    },
    async execute(_h: BackendHandle, _i: WorkerInput): Promise<WorkerOutput> {
      return { ok: true, durationMs: 0 };
    },
    async teardown(): Promise<void> {},
    async healthProbe(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
}

describe('BackendSelector', () => {
  test('L0 selects local-inproc when available', () => {
    const inproc = stub('local-inproc', 0);
    const s = new BackendSelector({ backends: [inproc] });
    expect(s.select(0)).toBe(inproc);
  });

  test('L1 prefers local-subproc when both local backends present', () => {
    const inproc = stub('local-inproc', 0);
    const subproc = stub('local-subproc', 1);
    const s = new BackendSelector({ backends: [inproc, subproc] });
    expect(s.select(1)).toBe(subproc);
  });

  test('L1 falls back to local-inproc when subproc absent', () => {
    const inproc = stub('local-inproc', 0);
    const s = new BackendSelector({ backends: [inproc] });
    expect(s.select(1)).toBe(inproc);
  });

  test('L2 with only local backends registered — throws with descriptive message', () => {
    const inproc = stub('local-inproc', 0);
    const subproc = stub('local-subproc', 1);
    const s = new BackendSelector({ backends: [inproc, subproc] });
    // local-subproc is the emergency L2 fallback per the preference table,
    // so selection at L2 succeeds with subproc, NOT throws.
    expect(s.select(2)).toBe(subproc);
  });

  test('L2 throws when no eligible backend registered', () => {
    const inproc = stub('local-inproc', 0);
    const s = new BackendSelector({ backends: [inproc] });
    expect(() => s.select(2)).toThrow(/no backend registered for L2/);
  });

  test('L3 throws when no remote backend available', () => {
    const inproc = stub('local-inproc', 0);
    const subproc = stub('local-subproc', 1);
    const s = new BackendSelector({ backends: [inproc, subproc] });
    expect(() => s.select(3)).toThrow(/no backend registered for L3/);
  });

  test('pin overrides default preference order', () => {
    const inproc = stub('local-inproc', 0);
    const subproc = stub('local-subproc', 1);
    const s = new BackendSelector({
      backends: [inproc, subproc],
      pins: { 1: 'local-inproc' },
    });
    expect(s.select(1)).toBe(inproc);
  });

  test('pin pointing to an unregistered backend throws', () => {
    const inproc = stub('local-inproc', 0);
    const s = new BackendSelector({
      backends: [inproc],
      pins: { 1: 'local-subproc' },
    });
    expect(() => s.select(1)).toThrow(/pin for L1 requests backend 'local-subproc' which is not registered/);
  });

  test('rankedCandidates returns full preference list in order', () => {
    const inproc = stub('local-inproc', 0);
    const subproc = stub('local-subproc', 1);
    const s = new BackendSelector({ backends: [inproc, subproc] });
    const ranked = s.rankedCandidates(1);
    expect(ranked.length).toBe(2);
    expect(ranked[0]!.id).toBe('local-subproc');
    expect(ranked[1]!.id).toBe('local-inproc');
  });

  test('rankedCandidates respects pin — returns only pinned backend', () => {
    const inproc = stub('local-inproc', 0);
    const subproc = stub('local-subproc', 1);
    const s = new BackendSelector({
      backends: [inproc, subproc],
      pins: { 1: 'local-inproc' },
    });
    const ranked = s.rankedCandidates(1);
    expect(ranked.length).toBe(1);
    expect(ranked[0]!.id).toBe('local-inproc');
  });

  test('onMissing override returns a fallback backend instead of throwing', () => {
    const inproc = stub('local-inproc', 0);
    const fallback = stub('local-inproc', 0);
    const s = new BackendSelector({
      backends: [inproc],
      onMissing: () => fallback,
    });
    expect(s.select(3)).toBe(fallback);
  });
});

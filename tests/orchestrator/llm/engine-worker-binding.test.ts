/**
 * Engine ↔ Worker id binding helpers.
 *
 * Pins the round-trip invariant — every workerId built by
 * `workerIdForEngine` must reverse exactly via `engineIdFromWorker`. The
 * production duplicate-rows incident was caused by a caller that did the
 * round-trip manually with a slightly different rule (`startsWith('worker-')`
 * vs `slice(7)` mismatch); centralising the helpers and pinning them here
 * prevents that class of bug.
 */
import { describe, expect, it } from 'bun:test';
import {
  engineIdFromWorker,
  WORKER_ID_PREFIX,
  workerIdForEngine,
} from '../../../src/orchestrator/llm/engine-worker-binding.ts';

describe('workerIdForEngine / engineIdFromWorker', () => {
  it('round-trips simple ids', () => {
    expect(engineIdFromWorker(workerIdForEngine('foo'))).toBe('foo');
  });

  it('round-trips slash-bearing engine ids (the production case)', () => {
    const id = 'openrouter/balanced/anthropic/claude-sonnet-4.6';
    expect(engineIdFromWorker(workerIdForEngine(id))).toBe(id);
  });

  it('engineIdFromWorker is the identity when prefix absent', () => {
    expect(engineIdFromWorker('plain-id')).toBe('plain-id');
    expect(engineIdFromWorker('openrouter/fast/x')).toBe('openrouter/fast/x');
  });

  it('workerIdForEngine prepends the canonical prefix', () => {
    expect(workerIdForEngine('foo').startsWith(WORKER_ID_PREFIX)).toBe(true);
  });

  it('does NOT double-prefix an already-prefixed id (caller responsibility)', () => {
    // The helper does a literal prepend — callers are expected to pass
    // engine ids, not worker ids. This test documents the contract.
    const doubled = workerIdForEngine(workerIdForEngine('foo'));
    expect(doubled).toBe(`${WORKER_ID_PREFIX}${WORKER_ID_PREFIX}foo`);
    // engineIdFromWorker still strips one layer — matches production
    // semantics of "remove at most one prefix".
    expect(engineIdFromWorker(doubled)).toBe(`${WORKER_ID_PREFIX}foo`);
  });
});

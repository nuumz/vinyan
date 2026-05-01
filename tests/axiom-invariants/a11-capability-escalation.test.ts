/**
 * A11 — Capability Escalation invariant (proposed RFC, not yet load-bearing).
 *
 * The artifact-commit gate emits `commit:capability_escalation_evaluated`
 * post-preflight, pre-write. Today the decision is always 'allow' — the
 * stub event is the seam for future enforcement: workers/peers with
 * sustained Wilson-LB ≥ 0.99 over N>1000 traces of task class C may
 * receive direct-mutate permission within C, audited per mutation,
 * revoked on any error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { commitArtifacts } from '../../src/orchestrator/worker/artifact-commit.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vinyan-a11-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('A11 — Capability Escalation (RFC stub)', () => {
  test('emits commit:capability_escalation_evaluated when bus + taskId + actor are wired', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const events: VinyanBusEvents['commit:capability_escalation_evaluated'][] = [];
    bus.on('commit:capability_escalation_evaluated', (p) => events.push(p));

    const result = commitArtifacts(
      tmp,
      [{ path: 'src/foo.ts', content: 'export const x = 1;' }],
      { bus, taskId: 'a11-task', actor: 'worker-1' },
    );
    expect(result.applied.length).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0]?.taskId).toBe('a11-task');
    expect(events[0]?.actor).toBe('worker-1');
    expect(events[0]?.targets).toContain('src/foo.ts');
    // Stub: decision is always 'allow' — enforcement is future work.
    expect(events[0]?.decision).toBe('allow');
  });

  test('legacy callers (no opts) still work — no event, no behavior change', () => {
    const result = commitArtifacts(tmp, [
      { path: 'src/bar.ts', content: 'export const y = 2;' },
    ]);
    expect(result.applied.length).toBe(1);
  });
});

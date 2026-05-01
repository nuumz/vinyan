/**
 * A12 — Hot-Reload Protocol invariant (proposed RFC, not yet load-bearing).
 *
 * The plugin loader emits `module:hot_reload_candidate` when the entry
 * file's mtime is newer than the cached load mtime. Today this is
 * informational; the supervisor (`vinyan serve --watch`) performs the
 * actual restart. Future hot-reload protocol attaches here.
 *
 * The contract verified here: shape of the emitted event when triggered
 * synthetically. End-to-end mtime detection runs in
 * `tests/plugin/loader.test.ts` (existing) so we don't duplicate the
 * filesystem dance.
 */
import { describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

describe('A12 — Hot-Reload Protocol (RFC stub)', () => {
  test('event shape carries moduleId, detectedAt, reason', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const captured: VinyanBusEvents['module:hot_reload_candidate'][] = [];
    bus.on('module:hot_reload_candidate', (p) => captured.push(p));

    bus.emit('module:hot_reload_candidate', {
      moduleId: 'plugin.test',
      detectedAt: 1_700_000_000_000,
      reason: 'mtime newer than load mtime',
    });
    expect(captured.length).toBe(1);
    expect(captured[0]?.moduleId).toBe('plugin.test');
    expect(captured[0]?.detectedAt).toBe(1_700_000_000_000);
    expect(captured[0]?.reason).toContain('mtime');
  });
});

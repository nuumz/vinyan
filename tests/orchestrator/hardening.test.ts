/**
 * Phase 6.5 Hardening Tests — stale overlay cleanup, semaphore, bus events.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { cleanupStaleOverlays } from '../../src/orchestrator/factory.ts';
import { Semaphore } from '../../src/orchestrator/worker/worker-pool.ts';

// ── cleanupStaleOverlays ──────────────────────────────────────────

describe('cleanupStaleOverlays', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = join(tmpdir(), `vinyan-test-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpWorkspace, '.vinyan', 'sessions'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpWorkspace, { recursive: true, force: true }); } catch {}
  });

  it('removes old directories beyond maxAge', () => {
    const oldDir = join(tmpWorkspace, '.vinyan', 'sessions', 'old-session-1');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'overlay.json'), '{}');

    // Set mtime to 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(oldDir, threeHoursAgo, threeHoursAgo);

    const cleaned = cleanupStaleOverlays(tmpWorkspace, 7_200_000); // 2h
    expect(cleaned).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
  });

  it('skips recent directories', () => {
    const recentDir = join(tmpWorkspace, '.vinyan', 'sessions', 'recent-session');
    mkdirSync(recentDir, { recursive: true });
    writeFileSync(join(recentDir, 'overlay.json'), '{}');

    const cleaned = cleanupStaleOverlays(tmpWorkspace, 7_200_000);
    expect(cleaned).toBe(0);
    expect(existsSync(recentDir)).toBe(true);
  });

  it('returns 0 when sessions directory does not exist', () => {
    const emptyWorkspace = join(tmpdir(), `vinyan-test-empty-${Date.now()}`);
    const cleaned = cleanupStaleOverlays(emptyWorkspace);
    expect(cleaned).toBe(0);
  });

  it('handles mixed old and recent directories', () => {
    const oldDir = join(tmpWorkspace, '.vinyan', 'sessions', 'old');
    const recentDir = join(tmpWorkspace, '.vinyan', 'sessions', 'recent');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(recentDir, { recursive: true });

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(oldDir, threeHoursAgo, threeHoursAgo);

    const cleaned = cleanupStaleOverlays(tmpWorkspace, 7_200_000);
    expect(cleaned).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(recentDir)).toBe(true);
  });
});

// ── Semaphore ─────────────────────────────────────────────────────

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions', async () => {
    const sem = new Semaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.activeCount).toBe(3);

    // 4th should block
    let fourthResolved = false;
    const fourthPromise = sem.acquire().then(() => { fourthResolved = true; });

    // Give microtask a chance to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(fourthResolved).toBe(false);

    // Release one — 4th should unblock
    sem.release();
    await fourthPromise;
    expect(fourthResolved).toBe(true);
    expect(sem.activeCount).toBe(3);

    // Cleanup
    sem.release();
    sem.release();
    sem.release();
  });

  it('unblocks waiters in FIFO order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => { order.push(1); });
    const p2 = sem.acquire().then(() => { order.push(2); });
    const p3 = sem.acquire().then(() => { order.push(3); });

    // Release 3 times to let all through
    sem.release(); // unblocks p1
    await p1;
    sem.release(); // unblocks p2
    await p2;
    sem.release(); // unblocks p3
    await p3;

    expect(order).toEqual([1, 2, 3]);

    // Cleanup
    sem.release();
    sem.release();
    sem.release();
  });

  it('tracks activeCount correctly through acquire/release cycles', async () => {
    const sem = new Semaphore(2);
    expect(sem.activeCount).toBe(0);

    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    await sem.acquire();
    expect(sem.activeCount).toBe(2);

    sem.release();
    expect(sem.activeCount).toBe(1);

    sem.release();
    expect(sem.activeCount).toBe(0);
  });
});

// ── Bus events (integration-style: verify emit calls) ──────────────

describe('agent:* bus events', () => {
  it('VinyanBusEvents includes agent event types', async () => {
    const { createBus } = await import('../../src/core/bus.ts');
    const bus = createBus();

    const events: string[] = [];
    bus.on('agent:session_start', (p) => events.push(`start:${p.taskId}`));
    bus.on('agent:session_end', (p) => events.push(`end:${p.taskId}:${p.outcome}`));
    bus.on('agent:turn_complete', (p) => events.push(`turn:${p.taskId}:${p.turnId}`));
    bus.on('agent:tool_executed', (p) => events.push(`tool:${p.toolName}:${p.isError}`));

    bus.emit('agent:session_start', {
      taskId: 't1',
      routingLevel: 2,
      budget: { maxTokens: 1000, maxTurns: 10, contextWindow: 128000 },
    });
    bus.emit('agent:turn_complete', {
      taskId: 't1',
      turnId: 'turn-1',
      tokensConsumed: 500,
      turnsRemaining: 9,
    });
    bus.emit('agent:tool_executed', {
      taskId: 't1',
      turnId: 'turn-1',
      toolName: 'file_read',
      durationMs: 50,
      isError: false,
    });
    bus.emit('agent:session_end', {
      taskId: 't1',
      outcome: 'completed',
      tokensConsumed: 1000,
      turnsUsed: 3,
      durationMs: 5000,
    });

    expect(events).toEqual([
      'start:t1',
      'turn:t1:turn-1',
      'tool:file_read:false',
      'end:t1:completed',
    ]);
  });
});

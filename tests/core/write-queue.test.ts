/**
 * B1: WriteQueue tests — generic write-behind queue for µs persistence.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WriteQueue } from '../../src/core/write-queue.ts';

describe('WriteQueue', () => {
  let flushed: number[][];
  let queue: WriteQueue<number>;

  beforeEach(() => {
    flushed = [];
    queue = new WriteQueue<number>((batch) => {
      flushed.push([...batch]);
    }, { flushIntervalMs: 50, maxBatchSize: 5 });
  });

  afterEach(() => {
    queue.stop();
  });

  // =========================================================================
  // Enqueue — synchronous, µs cost
  // =========================================================================

  test('enqueue is synchronous — returns immediately', () => {
    const start = Bun.nanoseconds();
    queue.enqueue(1);
    const elapsed = Bun.nanoseconds() - start;

    // Should be well under 1ms (1,000,000ns)
    expect(elapsed).toBeLessThan(1_000_000);
    expect(queue.pending).toBe(1);
  });

  test('pending count tracks queue size', () => {
    expect(queue.pending).toBe(0);
    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.pending).toBe(2);
  });

  // =========================================================================
  // Flush — manual
  // =========================================================================

  test('flush() drains all pending items', async () => {
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    await queue.flush();

    expect(queue.pending).toBe(0);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([1, 2, 3]);
  });

  test('flush() with empty queue is a no-op', async () => {
    await queue.flush();
    expect(flushed).toHaveLength(0);
  });

  test('flush() batches by maxBatchSize', async () => {
    for (let i = 0; i < 12; i++) {
      queue.enqueue(i);
    }

    // Auto-flush may have triggered at items 5 and 10
    await queue.flush();

    const totalFlushed = flushed.reduce((acc, batch) => acc + batch.length, 0);
    expect(totalFlushed).toBe(12);
    expect(queue.pending).toBe(0);

    // Each batch should be <= maxBatchSize (5)
    for (const batch of flushed) {
      expect(batch.length).toBeLessThanOrEqual(5);
    }
  });

  // =========================================================================
  // Auto-flush at maxBatchSize
  // =========================================================================

  test('auto-flushes when reaching maxBatchSize', async () => {
    // Enqueue exactly maxBatchSize (5) items
    for (let i = 0; i < 5; i++) {
      queue.enqueue(i);
    }

    // Give async auto-flush a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    // Should have auto-flushed
    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed[0]).toEqual([0, 1, 2, 3, 4]);
  });

  // =========================================================================
  // Timer-based periodic flush
  // =========================================================================

  test('start() creates periodic flush', async () => {
    queue.enqueue(1);
    queue.start();

    // Wait for flush interval (50ms) + margin
    await new Promise((r) => setTimeout(r, 80));

    expect(flushed.length).toBeGreaterThanOrEqual(1);
    expect(flushed[0]).toContain(1);

    queue.stop();
  });

  test('start() is idempotent', () => {
    queue.start();
    queue.start(); // Should not create duplicate timers
    queue.stop();
  });

  test('stop() clears the timer', async () => {
    queue.start();
    queue.stop();

    queue.enqueue(42);
    await new Promise((r) => setTimeout(r, 80));

    // Timer stopped — no periodic flush should have occurred
    // (auto-flush at maxBatchSize is separate)
    expect(queue.pending).toBe(1); // Still pending
  });

  // =========================================================================
  // Async onFlush callback
  // =========================================================================

  test('handles async onFlush callback', async () => {
    const asyncFlushed: number[][] = [];
    const asyncQueue = new WriteQueue<number>(
      async (batch) => {
        await new Promise((r) => setTimeout(r, 5));
        asyncFlushed.push([...batch]);
      },
      { maxBatchSize: 10 },
    );

    asyncQueue.enqueue(1);
    asyncQueue.enqueue(2);
    await asyncQueue.flush();

    expect(asyncFlushed).toHaveLength(1);
    expect(asyncFlushed[0]).toEqual([1, 2]);
  });

  // =========================================================================
  // Ordering
  // =========================================================================

  test('flush preserves enqueue order', async () => {
    for (let i = 0; i < 4; i++) {
      queue.enqueue(i);
    }

    await queue.flush();
    expect(flushed[0]).toEqual([0, 1, 2, 3]);
  });

  // =========================================================================
  // Graceful shutdown pattern
  // =========================================================================

  test('shutdown: stop + flush drains everything', async () => {
    queue.start();

    for (let i = 0; i < 3; i++) {
      queue.enqueue(i);
    }

    queue.stop();
    await queue.flush();

    expect(queue.pending).toBe(0);
    const totalFlushed = flushed.reduce((acc, batch) => acc + batch.length, 0);
    expect(totalFlushed).toBe(3);
  });
});

/**
 * Per-key async mutex — serializes operations sharing a key.
 *
 * Used by the JsonlAppender so each session's appends run sequentially
 * even when the caller dispatches them concurrently. Replaces the
 * `MAX(seq)+1` race on `session_turns` (today's implicit single-writer
 * assumption in `src/db/session-store.ts:660`).
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /** Run `fn` exclusively for `key`. Returns its result. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      key,
      previous.then(() => next),
    );
    try {
      await previous;
      return await fn();
    } finally {
      release();
      // Drop the entry once nothing is queued behind us so the map does
      // not grow unbounded. We can only safely delete when our promise
      // is still the tail; otherwise a newer caller is queued behind us.
      if (this.tails.get(key) === previous.then(() => next)) {
        this.tails.delete(key);
      }
    }
  }
}

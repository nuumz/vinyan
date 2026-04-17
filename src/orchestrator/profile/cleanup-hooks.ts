/**
 * CleanupHookRegistry — fire-and-forget cleanup callbacks for profile transitions.
 *
 * Book-integration Wave 4.3 lineage: every ephemeral isolation mechanism
 * (worktrees, tmp dirs, scratch DBs, cached credentials) needs a cleanup
 * stage when a profile transitions to `demoted` or `retired`. Extracted from
 * the original WorkerLifecycle so it can be reused by any
 * `ProfileLifecycle` kind without baking cleanup into the FSM.
 *
 * Hooks are best-effort — a throwing hook is logged and ignored so cleanup
 * failures can never block the lifecycle transition or corrupt the store.
 */

export type CleanupReason = 'demoted' | 'retired';
export type CleanupHook = (id: string, reason: CleanupReason) => Promise<void> | void;

export class CleanupHookRegistry {
  private hooks: CleanupHook[] = [];

  /** Register a cleanup hook. Returns an unsubscribe function. */
  onCleanup(hook: CleanupHook): () => void {
    this.hooks.push(hook);
    return () => {
      const idx = this.hooks.indexOf(hook);
      if (idx >= 0) this.hooks.splice(idx, 1);
    };
  }

  /** Run every registered hook. Errors are swallowed (best-effort). */
  async run(id: string, reason: CleanupReason): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(id, reason);
      } catch (err) {
        console.warn(
          `[cleanup-hooks] hook threw for id=${id} reason=${reason}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /** How many hooks are registered (observability/tests). */
  get size(): number {
    return this.hooks.length;
  }
}

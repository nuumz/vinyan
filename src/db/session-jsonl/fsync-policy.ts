/**
 * Fsync policy for JSONL appends.
 *
 * Controls how aggressively we durability-flush each line. Approved
 * default per the migration plan is `durable`: per-line fdatasync for
 * critical kinds, OS-flush for the rest.
 *
 * Override at runtime via `VINYAN_JSONL_FSYNC=durable|batched|none`.
 */

export type FsyncMode = 'durable' | 'batched' | 'none';

/** Kinds that always fsync under `durable` policy. */
export const CRITICAL_KINDS: ReadonlySet<string> = new Set([
  'turn.appended',
  'turn.cancelled',
  'task.status.changed',
  'session.compacted',
  'session.purged',
  'session.created',
  'session.deleted',
]);

export interface FsyncPolicy {
  mode: FsyncMode;
  /** When true, the appender must call fdatasync after this line. */
  shouldFsync(kind: string): boolean;
}

export function resolveFsyncMode(env: NodeJS.ProcessEnv = process.env): FsyncMode {
  const raw = (env['VINYAN_JSONL_FSYNC'] ?? 'durable').toLowerCase();
  if (raw === 'durable' || raw === 'batched' || raw === 'none') return raw;
  return 'durable';
}

export function makeFsyncPolicy(mode: FsyncMode = resolveFsyncMode()): FsyncPolicy {
  return {
    mode,
    shouldFsync(kind: string): boolean {
      if (mode === 'none') return false;
      if (mode === 'batched') return false; // batched flusher handles it; appender does not fsync inline
      return CRITICAL_KINDS.has(kind);
    },
  };
}

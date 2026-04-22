/**
 * BackendSelector — deterministic (A3) routing from an isolation level to
 * the WorkerBackend implementation that will execute the task.
 *
 * Rule table:
 *   L0 → [local-inproc]
 *   L1 → [local-subproc, local-inproc]   (inproc is legacy fallback only)
 *   L2 → [docker, ssh, local-subproc]    (subproc fallback when no container)
 *   L3 → [modal, daytona, docker]        (remote first, container degrade)
 *
 * `pins` lets a caller override this table per-level (e.g. force L1 to stay
 * in-process during a smoke test). `onMissing` is the escape hatch when no
 * registered backend satisfies the requested level — default is to throw so
 * silent fall-through to the legacy path is impossible.
 */

import type { BackendId, IsolationLevel, WorkerBackend } from './backend.ts';

/** Preference order per level. Earlier entries win when multiple backends register. */
const LEVEL_PREFERENCES: Record<IsolationLevel, readonly BackendId[]> = {
  0: ['local-inproc'],
  1: ['local-subproc', 'local-inproc'],
  2: ['docker', 'ssh', 'local-subproc'],
  3: ['modal', 'daytona', 'docker'],
};

export interface BackendSelectorOptions {
  readonly backends: ReadonlyArray<WorkerBackend>;
  /** Explicit pin of a level to a specific backend id. Overrides the default table. */
  readonly pins?: Partial<Record<IsolationLevel, BackendId>>;
  /** Hook called when no backend matches. Default implementation throws. */
  readonly onMissing?: (level: IsolationLevel) => WorkerBackend;
}

export class BackendSelector {
  private readonly byId: ReadonlyMap<BackendId, WorkerBackend>;
  private readonly pins: Partial<Record<IsolationLevel, BackendId>>;
  private readonly onMissing: (level: IsolationLevel) => WorkerBackend;

  constructor(opts: BackendSelectorOptions) {
    const map = new Map<BackendId, WorkerBackend>();
    for (const b of opts.backends) {
      map.set(b.id, b);
    }
    this.byId = map;
    this.pins = opts.pins ?? {};
    this.onMissing =
      opts.onMissing ??
      ((level) => {
        const preference = LEVEL_PREFERENCES[level].join(', ');
        const registered = Array.from(this.byId.keys()).join(', ') || '(none)';
        throw new Error(
          `BackendSelector: no backend registered for L${level}. ` +
            `Preference order: [${preference}]. Registered: [${registered}].`,
        );
      });
  }

  /**
   * Pick the backend that will execute this level. Respects pins first,
   * then walks the default preference list and returns the first match.
   */
  select(level: IsolationLevel): WorkerBackend {
    const pin = this.pins[level];
    if (pin) {
      const pinned = this.byId.get(pin);
      if (pinned) return pinned;
      throw new Error(
        `BackendSelector: pin for L${level} requests backend '${pin}' which is not registered.`,
      );
    }
    for (const id of LEVEL_PREFERENCES[level]) {
      const b = this.byId.get(id);
      if (b) return b;
    }
    return this.onMissing(level);
  }

  /**
   * For observability / tests — return the full ranked list the selector
   * would try for this level, in preference order. Useful when debugging
   * "why did the selector pick X?" without re-running execute().
   */
  rankedCandidates(level: IsolationLevel): readonly WorkerBackend[] {
    const pin = this.pins[level];
    if (pin) {
      const pinned = this.byId.get(pin);
      return pinned ? [pinned] : [];
    }
    const out: WorkerBackend[] = [];
    for (const id of LEVEL_PREFERENCES[level]) {
      const b = this.byId.get(id);
      if (b) out.push(b);
    }
    return out;
  }
}

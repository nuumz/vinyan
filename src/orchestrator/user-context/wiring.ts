/**
 * Wiring helper for the P3 USER.md dialectic observer.
 *
 * `setupUserMdObserver` builds a ready-to-use `UserMdObserver` + `UserMdStore`
 * pair from a raw `Database` handle. The factory (coordinator pass) calls
 * this once per profile and then hands the observer to whichever component
 * owns user-turn processing (currently `SessionManager`, see
 * `src/api/session-manager.ts`).
 *
 * Keeping this thin wrapper separate from the core observer logic lets us
 * unit-test the observer without dragging the factory into tests, and lets
 * the factory add plumbing (profile resolver, per-request DI) without
 * touching observer semantics.
 */
import type { Database } from 'bun:sqlite';

import { UserMdStore } from '../../db/user-md-store.ts';

import type { DialecticDeps } from './dialectic.ts';
import { UserMdObserver } from './observer.ts';

export interface SetupUserMdObserverOptions {
  readonly db: Database;
  readonly profile: string;
  readonly critic?: DialecticDeps['critic'];
  readonly thresholds?: {
    readonly windowSize?: number;
    readonly revisionThreshold?: number;
    readonly flipThreshold?: number;
  };
  /** Injected clock; defaults to `Date.now`. */
  readonly clock?: () => number;
}

export interface UserMdObserverHandle {
  readonly observer: UserMdObserver;
  readonly store: UserMdStore;
}

/**
 * Build a `UserMdObserver` + `UserMdStore` handle for the given profile.
 * The factory calls this once per active profile and threads the resulting
 * `observer` into whichever turn-processing component should own it.
 */
export function setupUserMdObserver(opts: SetupUserMdObserverOptions): UserMdObserverHandle {
  const store = new UserMdStore(opts.db);
  const observer = new UserMdObserver({
    store,
    profile: opts.profile,
    ...(opts.clock !== undefined && { clock: opts.clock }),
    ...(opts.critic !== undefined && { critic: opts.critic }),
    ...(opts.thresholds?.windowSize !== undefined && { windowSize: opts.thresholds.windowSize }),
    ...(opts.thresholds?.revisionThreshold !== undefined && {
      revisionThreshold: opts.thresholds.revisionThreshold,
    }),
    ...(opts.thresholds?.flipThreshold !== undefined && { flipThreshold: opts.thresholds.flipThreshold }),
  });
  return { observer, store };
}

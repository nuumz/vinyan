/**
 * WorkerBackend — the runtime abstraction that plugs different execution
 * environments (in-process, subprocess, container, SSH, cloud) under a single
 * contract. See Decision 5 in docs/architecture/decisions.md for the
 * progressive-isolation rationale; this file is the constitutional interface
 * that statement defines.
 *
 * Axiom anchors:
 *   A3 — Selector (src/runtime/backend-selector.ts) routes purely by level
 *        and declared backends; no LLM is in the decision path.
 *   A5 — Each backend advertises a `trustTier` (deterministic / heuristic /
 *        probabilistic / speculative) so consumers can weight results.
 *   A6 — Progressive isolation: L0 = in-proc (read-only trust), L1 =
 *        subprocess, L2 = container (follow-up), L3 = remote (follow-up).
 *
 * MVP scope (W3 P3): only LocalInprocBackend + LocalSubprocBackend ship.
 * Remote placeholders ('docker' | 'ssh' | 'modal' | 'daytona') are in the
 * BackendId union so configuration and selector wiring lands now — their
 * implementations are follow-up PRs.
 */

import type { ConfidenceTier } from '../core/confidence-tier.ts';

export type BackendId =
  | 'local-inproc'
  | 'local-subproc'
  /** Placeholder — not implemented in MVP. */
  | 'docker'
  /** Placeholder — not implemented in MVP. */
  | 'ssh'
  /** Placeholder — not implemented in MVP. */
  | 'modal'
  /** Placeholder — not implemented in MVP. */
  | 'daytona';

/**
 * Backend isolation level. Mirrors the orchestrator routing level but is
 * declared separately so non-routing consumers (e.g. a scheduled snapshot
 * worker) can pick a backend without going through the risk router.
 */
export type IsolationLevel = 0 | 1 | 2 | 3;

export interface BackendSpawnSpec {
  readonly taskId: string;
  readonly routingLevel: IsolationLevel;
  readonly workspace: { readonly host: string; readonly readonly: boolean };
  readonly networkPolicy: 'deny-all' | 'egress-proxy-only' | 'open';
  readonly resourceLimits: {
    readonly cpuMs: number;
    readonly memMB: number;
    readonly fdMax: number;
  };
  readonly credentials?: {
    /** Unix socket path to the LLM proxy. Never raw API keys at the backend layer. */
    readonly llmProxySocket?: string;
  };
  /**
   * K1.2 AgentContract propagated in-band. Structural `unknown` so the
   * runtime package doesn't pull the full contract module — backends that
   * need it (LocalSubprocBackend) forward it opaquely via env/stdin.
   */
  readonly agentContract?: unknown;
  /** Structured log sink from the orchestrator. */
  readonly log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    meta?: Record<string, unknown>,
  ) => void;
}

export interface BackendHandle {
  readonly backendId: BackendId;
  readonly spawnSpec: BackendSpawnSpec;
  readonly spawnedAt: number;
  /** Opaque state owned by the backend (subprocess ref, VM id, handle pointer). */
  readonly internal: unknown;
}

export interface WorkerInput {
  readonly taskId: string;
  readonly prompt: string;
  readonly tools?: readonly unknown[];
  readonly maxTurns?: number;
  readonly budget?: { tokens: number; timeMs: number };
  /** Free-form payload forwarded to the worker — backend-specific fields live here. */
  readonly payload?: Record<string, unknown>;
}

export interface WorkerOutput {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly tokensUsed?: number;
  /** Subprocess exit code when applicable; undefined for in-proc. */
  readonly exitCode?: number;
}

export interface HibernationToken {
  readonly backendId: BackendId;
  readonly snapshotId: string;
  readonly worldgraphEpoch: number;
  readonly wallClockDriftBudgetMs: number;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly notes?: string;
}

/**
 * The runtime-agnostic worker lifecycle interface. Implementations wrap one
 * execution environment and expose the five-step loop: spawn → execute →
 * (healthProbe)? → teardown, with optional hibernate/wake for cheap restart
 * (follow-up).
 */
export interface WorkerBackend {
  readonly id: BackendId;
  readonly isolationLevel: IsolationLevel;
  readonly supportsHibernation: boolean;
  /**
   * Trust tier this backend provides (A5). Local backends are deterministic
   * because their behavior is fully reproducible from the same input;
   * remote / network-backed backends start as heuristic / probabilistic
   * until they accumulate prediction-error history that lets us promote
   * them.
   */
  readonly trustTier: ConfidenceTier;

  spawn(spec: BackendSpawnSpec): Promise<BackendHandle>;
  execute(handle: BackendHandle, input: WorkerInput): Promise<WorkerOutput>;
  teardown(handle: BackendHandle): Promise<void>;
  healthProbe(handle: BackendHandle): Promise<HealthReport>;
  hibernate?(handle: BackendHandle): Promise<HibernationToken>;
  wake?(token: HibernationToken): Promise<BackendHandle>;
}

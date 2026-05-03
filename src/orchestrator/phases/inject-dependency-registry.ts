/**
 * Injection-dependency registry — bus-subscribed in-memory index of
 * cot-inject decision rows targeting each sub-task.
 *
 * Why this exists (instead of querying the durable event log directly):
 * the task-event-recorder buffers writes (250ms idle flush + buffer-
 * limit flush). When `collaboration-block` emits the inject decision
 * and then dispatches the sub-task synchronously, the sub-task's
 * verifier may run BEFORE the recorder's flush timer fires — so a
 * `taskEventStore.listForTask(parentId)` lookup at verify time can
 * return zero rows even though the inject did happen. A bus-subscribed
 * in-memory map sidesteps the race because the bus is FIFO sync; the
 * registry sees the audit:entry the moment it is emitted, before
 * `runCollaborationBlock`'s `await deps.executeTask(subInput)` even
 * starts.
 *
 * The registry is intentionally scoped to one OrchestratorDeps lifetime
 * (set up at factory time, detached at shutdown). It does NOT survive
 * restarts; cross-restart replay is the durable log's job. For the
 * verdict-discount use case the in-memory window is sufficient because
 * the inject and the verdict happen in the same orchestrator run.
 *
 * Axiom alignment:
 *   A1 — Reads only the decision row's metadata (ruleId, verdict
 *        shape, subTaskId). Never consumes thought content; the
 *        verifier remains generation-blind.
 *   A3 — Pure function over bus order. Same emit sequence → same
 *        index. Determinism guaranteed by the bus's FIFO contract.
 *   A8 — Indexes durable decision rows; replay can rebuild the same
 *        index from the persisted log via the same predicate. The
 *        registry does NOT introduce new state, only accelerates the
 *        synchronous read.
 *   A9 — Throwing handlers are caught by the bus. Memory-bounded by
 *        the per-task lifetime AND a hard cap on tracked entries so
 *        a runaway emitter cannot OOM the orchestrator.
 */

import type { VinyanBus } from '../../core/bus.ts';
import { COT_INJECT_RULE_ID } from './injected-prior-discount.ts';

/** Entry surfaced for verdict-discount lookups. */
export interface InjectDependencyEntry {
  /** Target sub-task id whose generation consumed the inject. */
  subTaskId: string;
  /** Number of thoughts injected (parsed from the verdict shape). */
  injectCount: number;
  /** Source thought ids (extracted from evidenceRefs). */
  sourceThoughtIds: readonly string[];
  /**
   * Sub-task id that emitted the source thoughts. Derived from the
   * thought-id index at indexing time. Used by `computeDepth` to walk
   * the dependency chain back to the originating round. Absent when
   * the thought was not seen on the bus by this registry instance
   * (e.g., emitted before registry started, or emitted in another
   * orchestrator process); chain walking stops at that boundary.
   */
  sourceTaskId?: string;
  /** Decision row's wrapper id — for downstream tracing. */
  decisionEntryId: string;
  /** Wall-clock when the row was indexed. */
  ts: number;
}

export interface InjectDependencyRegistry {
  /** Return entries targeting `subTaskId`, oldest first. Empty array if none. */
  lookup(subTaskId: string): readonly InjectDependencyEntry[];
  /**
   * Walk the dependency chain back from `subTaskId` and return the max
   * depth observed across all entries. Depth meaning:
   *   - 0  ⇒ no inject targets this task; verdict confidence unchanged.
   *   - 1  ⇒ this task consumed a round's reasoning whose source had no
   *          prior dependency.
   *   - N  ⇒ chain of N dependent rounds back from this task.
   * Capped at `MAX_DEPTH` so a malformed cycle cannot trap the verifier.
   * Cycle detection: visited set; if a sub-task appears twice we stop.
   */
  computeDepth(subTaskId: string): number;
  /** Detach the bus subscription and clear state. */
  detach(): void;
}

const MAX_TRACKED = 10_000;
/**
 * Bounds the recursive chain walk in `computeDepth`. A typical L1
 * debate has rebuttal rounds ≤ 6 (hard cap in collaboration-block);
 * 5 is more than enough for honest depth, prevents accidental
 * runaway from a malformed inject chain.
 */
export const MAX_INJECT_CHAIN_DEPTH = 5;

/**
 * Build the registry. Subscribes to `audit:entry` and indexes:
 *   - `kind:'thought'` rows: id → taskId mapping (used by inject
 *     indexing to derive `sourceTaskId` for chain walking).
 *   - `kind:'decision'` with `ruleId:'collab-cot-inject-v1'` and
 *     `verdict.startsWith('cot-inject:')`: the actual dependency edge.
 * Skip rows with verdict starting `cot-skip:` — only successful injects
 * create a verdict-confidence dependency.
 *
 * Order invariant (FIFO bus): thoughts are emitted by the round-N
 * sub-task BEFORE the orchestrator emits the round-N+1 inject decision
 * referencing them. The handler therefore has thought→taskId in its
 * map before processing the inject row that needs to dereference it.
 */
export function createInjectDependencyRegistry(bus: VinyanBus): InjectDependencyRegistry {
  const bySubTask = new Map<string, InjectDependencyEntry[]>();
  /** Thought id → taskId of the audit:entry that emitted it. */
  const thoughtTaskIdById = new Map<string, string>();
  let trackedCount = 0;

  const handler = (entry: unknown) => {
    if (trackedCount >= MAX_TRACKED) return; // A9 hard cap
    const e = entry as {
      kind?: string;
      ruleId?: string;
      verdict?: string;
      subTaskId?: string;
      taskId?: string;
      id?: string;
      ts?: number;
      evidenceRefs?: ReadonlyArray<{ type?: string; eventId?: string }>;
    };
    // First pass: capture thought provenance so subsequent inject
    // decisions can resolve `sourceTaskId` from their evidenceRefs.
    if (e.kind === 'thought' && typeof e.id === 'string' && typeof e.taskId === 'string') {
      thoughtTaskIdById.set(e.id, e.taskId);
      return;
    }
    if (e.kind !== 'decision' || e.ruleId !== COT_INJECT_RULE_ID) return;
    if (typeof e.subTaskId !== 'string' || e.subTaskId.length === 0) return;
    const verdict = typeof e.verdict === 'string' ? e.verdict : '';
    if (!verdict.startsWith('cot-inject:')) return;
    const injectCount = Number.parseInt(verdict.slice('cot-inject:'.length), 10);
    if (!Number.isFinite(injectCount) || injectCount <= 0) return;
    const sourceThoughtIds: string[] = [];
    if (Array.isArray(e.evidenceRefs)) {
      for (const ref of e.evidenceRefs) {
        if (ref?.type === 'event' && typeof ref.eventId === 'string') {
          sourceThoughtIds.push(ref.eventId);
        }
      }
    }
    // Resolve sourceTaskId via the first source thought (all thoughts
    // in one inject originate from the same round-N sub-task by
    // `collaboration-block` invariant; using the first id is sufficient).
    const sourceTaskId = sourceThoughtIds.length > 0 ? thoughtTaskIdById.get(sourceThoughtIds[0]!) : undefined;
    const out: InjectDependencyEntry = {
      subTaskId: e.subTaskId,
      injectCount,
      sourceThoughtIds,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      decisionEntryId: typeof e.id === 'string' ? e.id : '',
      ts: typeof e.ts === 'number' ? e.ts : Date.now(),
    };
    const list = bySubTask.get(e.subTaskId) ?? [];
    list.push(out);
    bySubTask.set(e.subTaskId, list);
    trackedCount++;
  };

  const unsubscribe = bus.on('audit:entry', handler);

  function computeDepthInner(subTaskId: string, visited: Set<string>, remaining: number): number {
    if (remaining <= 0) return 0;
    if (visited.has(subTaskId)) return 0; // cycle guard
    const entries = bySubTask.get(subTaskId) ?? [];
    if (entries.length === 0) return 0;
    visited.add(subTaskId);
    let maxChild = 0;
    for (const entry of entries) {
      if (!entry.sourceTaskId) continue; // unknown source — chain stops here
      const childDepth = computeDepthInner(entry.sourceTaskId, visited, remaining - 1);
      if (childDepth > maxChild) maxChild = childDepth;
    }
    visited.delete(subTaskId);
    return 1 + maxChild;
  }

  return {
    lookup(subTaskId: string): readonly InjectDependencyEntry[] {
      return bySubTask.get(subTaskId) ?? [];
    },
    computeDepth(subTaskId: string): number {
      return computeDepthInner(subTaskId, new Set(), MAX_INJECT_CHAIN_DEPTH);
    },
    detach(): void {
      try {
        unsubscribe();
      } catch {
        /* best-effort */
      }
      bySubTask.clear();
      thoughtTaskIdById.clear();
      trackedCount = 0;
    },
  };
}

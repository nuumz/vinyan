/**
 * Concurrent Dispatcher — K2.3 parallel multi-task dispatch.
 *
 * Dispatches multiple tasks concurrently through the core loop,
 * using file locks to prevent write conflicts and TaskQueue for
 * bounded concurrency.
 *
 * Book-integration Wave 2.2: adds a pre-computed merge-conflict graph
 * (see docs/architecture/book-integration-overview.md). Instead of the
 * round-based lazy-retry loop, the dispatcher now builds the full
 * conflict graph up front, partitions tasks into mutually-exclusive
 * "conflict groups", and dispatches each group as an ordered chain
 * while different groups run in parallel. This keeps A3 intact
 * (scheduling is pure, deterministic graph coloring on file
 * membership) and gives operators a single concrete object they can
 * inspect via `computeConflictPlan()` before tasks ever run.
 *
 * A3 compliant: all scheduling decisions are deterministic/rule-based.
 * A6 compliant: each task gets its own AgentContract.
 */

import type { VinyanBus } from '../core/bus.ts';
import type { TaskQueue } from './task-queue.ts';
import type { TaskInput, TaskResult } from './types.ts';
import { AdvisoryFileLock } from './agent/file-lock.ts';

// ── Conflict graph ──────────────────────────────────────────────────

/**
 * A set of tasks that pairwise share at least one mutated file. Every
 * task inside a group must run sequentially with respect to the others
 * in the group, because any pair could write to the same file.
 * Different groups have *disjoint* file sets and can run fully in
 * parallel.
 */
export interface ConflictGroup {
  /** Deterministic id (`group-0`, `group-1`, …) derived from input order. */
  id: string;
  /** Task ids belonging to this group, in original submission order. */
  taskIds: string[];
  /** Union of all files any task in this group touches — for diagnostics. */
  files: string[];
}

export interface ConflictPlan {
  /** Non-empty groups — each is a serial chain. */
  groups: ConflictGroup[];
  /** Tasks that touch zero files; they can run fully in parallel. */
  fileFree: string[];
  /**
   * Adjacency list from task id → task ids it conflicts with.
   * Exposed for tooling (TUI, tests) that wants to render the raw graph
   * before the dispatcher collapses it into groups.
   */
  adjacency: Map<string, Set<string>>;
}

/**
 * Pure function that takes a list of tasks and returns the conflict plan.
 * Complexity: O(n·f²) where f is the average files-per-task — negligible
 * for realistic batch sizes.
 *
 * Two tasks conflict iff their `targetFiles` sets intersect.
 */
export function computeConflictPlan(tasks: ReadonlyArray<TaskInput>): ConflictPlan {
  const adjacency = new Map<string, Set<string>>();
  for (const t of tasks) adjacency.set(t.id, new Set());

  // Build the adjacency list. We index tasks by every file they touch so
  // we only compare tasks that share at least one file.
  //
  // Deep-audit #2 (2026-04-15): dedupe per-task files before indexing.
  // Without this, a caller accidentally passing `targetFiles: ['a.ts',
  // 'a.ts']` would create a self-edge in adjacency (t1 → t1) because
  // the second occurrence of 'a.ts' finds t1 already in the bucket.
  // Self-edges are benign for union-find but leak a surprising state
  // to any consumer reading `plan.adjacency`. Set-based dedupe is
  // cheap and eliminates the class of bugs.
  const fileIndex = new Map<string, string[]>();
  const fileFree: string[] = [];
  for (const t of tasks) {
    const uniqueFiles = Array.from(new Set(t.targetFiles ?? []));
    if (uniqueFiles.length === 0) {
      fileFree.push(t.id);
      continue;
    }
    for (const f of uniqueFiles) {
      let bucket = fileIndex.get(f);
      if (!bucket) {
        bucket = [];
        fileIndex.set(f, bucket);
      }
      for (const other of bucket) {
        adjacency.get(t.id)!.add(other);
        adjacency.get(other)!.add(t.id);
      }
      bucket.push(t.id);
    }
  }

  // Union-find on the adjacency list to collapse transitive conflicts
  // into conflict groups. Two tasks are in the same group if there's any
  // path of conflicts linking them — required because A→B and B→C means
  // A and C can't run in parallel even though they don't directly share
  // files (B would deadlock them).
  const parent = new Map<string, string>();
  for (const t of tasks) parent.set(t.id, t.id);
  const find = (x: string): string => {
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [id, neighbors] of adjacency) {
    for (const n of neighbors) union(id, n);
  }

  // Collect groups, preserving submission order within each group so
  // reproducibility is independent of Map iteration order.
  const rootToMembers = new Map<string, string[]>();
  for (const t of tasks) {
    if ((t.targetFiles ?? []).length === 0) continue; // fileFree handled below
    const root = find(t.id);
    let members = rootToMembers.get(root);
    if (!members) {
      members = [];
      rootToMembers.set(root, members);
    }
    members.push(t.id);
  }

  const groups: ConflictGroup[] = [];
  let groupIndex = 0;
  for (const members of rootToMembers.values()) {
    // Only emit a serial group when there's more than one member or the
    // single member has files; single file-touching tasks are not
    // conflicted but still need to go through the group machinery so
    // their file lock is respected.
    const fileSet = new Set<string>();
    for (const id of members) {
      const task = tasks.find((t) => t.id === id);
      for (const f of task?.targetFiles ?? []) fileSet.add(f);
    }
    groups.push({
      id: `group-${groupIndex++}`,
      taskIds: members,
      files: [...fileSet],
    });
  }

  return { groups, fileFree, adjacency };
}

export interface ConcurrentDispatcherConfig {
  taskQueue: TaskQueue;
  executeTask: (input: TaskInput) => Promise<TaskResult>;
  bus?: VinyanBus;
}

/**
 * Book-integration Wave 4.1: per-call dispatch options.
 *
 * `canaryFirst` asks the dispatcher to run the first eligible task
 * alone, wait for its verdict, and only fan out the remaining tasks
 * if the canary `status === 'completed'`. This mitigates the
 * "error() bug" failure pattern from Ch12/Ch14 where a systematic
 * mistake is applied to N files in parallel before anyone runs the
 * output. See docs/architecture/book-integration-design.md §8.1.
 *
 * Opt-in per call — the default behavior (empty options) is
 * byte-for-byte identical to the pre-W4.1 path.
 */
export interface DispatchOptions {
  canaryFirst?: boolean;
}

export interface ConcurrentDispatcher {
  dispatch(tasks: TaskInput[], options?: DispatchOptions): Promise<TaskResult[]>;
  getActiveCount(): number;
}

/**
 * Wave 4.1: marker string inserted into the synthetic `notes` of a
 * TaskResult that was cancelled by a failing canary. Consumers that
 * want to distinguish "real failure" from "skipped because canary
 * failed" should grep this prefix. Exported for test assertions.
 */
export const CANARY_ABORTED_NOTE_PREFIX = 'canary-aborted:';

export class DefaultConcurrentDispatcher implements ConcurrentDispatcher {
  private taskQueue: TaskQueue;
  private executeTask: (input: TaskInput) => Promise<TaskResult>;
  private fileLock = new AdvisoryFileLock();
  private bus?: VinyanBus;

  constructor(config: ConcurrentDispatcherConfig) {
    this.taskQueue = config.taskQueue;
    this.executeTask = config.executeTask;
    this.bus = config.bus;
  }

  /**
   * Dispatch tasks concurrently using a pre-computed conflict plan.
   *
   * Plan shape (see `computeConflictPlan`):
   *   - file-free tasks dispatched as one parallel wave
   *   - each conflict group dispatched as a serial chain
   *   - different conflict groups run in parallel
   *
   * The earlier lazy-retry loop has been removed — it worked, but it
   * obscured the real coordination structure behind repeated lock
   * attempts. With the plan, operators can inspect the full schedule
   * before anything runs (via `computeConflictPlan(tasks)` called
   * directly) and dashboards can render a static graph view.
   */
  async dispatch(tasks: TaskInput[], options: DispatchOptions = {}): Promise<TaskResult[]> {
    if (tasks.length === 0) return [];
    if (tasks.length === 1) return [await this.executeSingle(tasks[0]!)];

    const plan = computeConflictPlan(tasks);
    // Surface the plan on the bus so dashboards can record the
    // scheduling decision at dispatch time — before any work runs.
    this.bus?.emit('dag:executed', {
      taskId: `batch-${tasks.length}`,
      nodes: tasks.length,
      parallel: plan.groups.length > 1 || plan.fileFree.length > 1,
      fileConflicts: plan.groups.reduce((acc, g) => acc + Math.max(0, g.taskIds.length - 1), 0),
    });

    const results = new Map<string, TaskResult>();
    const byId = new Map(tasks.map((t) => [t.id, t] as const));

    // ── Wave 4.1: canary-first mode ────────────────────────────────
    // Pick a canary (first file-free OR first singleton group in
    // submission order) and run it alone before the rest. If the
    // canary doesn't cleanly complete, synthesize aborted results for
    // every remaining task and return without running them. This is a
    // pure A3 rule — the canary pick is deterministic and there is no
    // LLM in the selection path.
    if (options.canaryFirst) {
      const canaryTaskId = this.pickCanary(tasks, plan);
      if (canaryTaskId) {
        const canaryTask = byId.get(canaryTaskId)!;
        const canaryResult = await this.executeSingle(canaryTask);
        results.set(canaryTaskId, canaryResult);

        if (canaryResult.status !== 'completed') {
          // Canary failed → abort the batch. Every remaining task gets
          // a synthetic `failed` result with a `canary-aborted:` note
          // pointing back at the canary that failed. Consumers that
          // want to distinguish "real failure" from "skipped" can grep
          // the CANARY_ABORTED_NOTE_PREFIX constant.
          for (const task of tasks) {
            if (results.has(task.id)) continue;
            results.set(task.id, this.makeCanaryAbortedResult(task, canaryResult));
          }
          this.bus?.emit('dag:executed', {
            taskId: `batch-${tasks.length}-aborted`,
            nodes: tasks.length,
            parallel: false,
            fileConflicts: 0,
          });
          return tasks.map((t) => results.get(t.id)!);
        }
        // Canary passed — fall through to the normal batch path. The
        // canary is already in `results` so the helpers below will
        // skip it via the `results.has` guard.
      }
    }

    const runSerialChain = async (group: ConflictGroup): Promise<void> => {
      for (const taskId of group.taskIds) {
        if (results.has(taskId)) continue; // skip the canary if it was in this group
        const task = byId.get(taskId)!;
        await this.taskQueue.enqueue(async () => {
          // Acquire the lock inside the serial chain so any other
          // dispatcher instance (e.g. cross-dispatcher races in tests)
          // observes the same invariant. Chain order guarantees no
          // self-contention.
          this.fileLock.tryAcquire(task.id, task.targetFiles ?? []);
          try {
            const result = await this.executeTask(task);
            results.set(task.id, result);
          } finally {
            this.fileLock.release(task.id);
          }
        });
      }
    };

    const runFileFreeTask = async (taskId: string): Promise<void> => {
      if (results.has(taskId)) return; // skip the canary if it was file-free
      const task = byId.get(taskId)!;
      await this.taskQueue.enqueue(async () => {
        try {
          const result = await this.executeTask(task);
          results.set(task.id, result);
        } finally {
          // No lock to release for file-free tasks, but keep the
          // symmetry in case a future subclass needs to hook cleanup.
        }
      });
    };

    // Launch all groups and all file-free tasks concurrently. Within a
    // group the chain is serial; across groups / file-free tasks they
    // run in parallel bounded by the TaskQueue.
    const pending: Array<Promise<void>> = [];
    for (const group of plan.groups) pending.push(runSerialChain(group));
    for (const taskId of plan.fileFree) pending.push(runFileFreeTask(taskId));
    await Promise.allSettled(pending);

    // Return results in original task order
    return tasks.map((t) => results.get(t.id)!);
  }

  /**
   * Wave 4.1: canary picker. Picks the first task in submission order
   * that can run without blocking other members of a conflict group.
   * Preference order:
   *   1. first file-free task (least disruptive — no lock)
   *   2. first task from a singleton group (one member, one set of files)
   *   3. none (return null — no canary, dispatch falls through)
   *
   * Multi-member groups are intentionally skipped because picking the
   * first member would serialize the rest of the group behind it
   * without any benefit (the rest of the batch still can't run until
   * the canary releases the lock).
   *
   * Exposed as a method so subclasses can override the picker rule.
   */
  protected pickCanary(tasks: TaskInput[], plan: ConflictPlan): string | null {
    // file-free first, in submission order
    for (const task of tasks) {
      if (plan.fileFree.includes(task.id)) return task.id;
    }
    // singleton groups next, in submission order
    const singletonIds = new Set<string>();
    for (const g of plan.groups) {
      if (g.taskIds.length === 1) singletonIds.add(g.taskIds[0]!);
    }
    for (const task of tasks) {
      if (singletonIds.has(task.id)) return task.id;
    }
    return null;
  }

  /**
   * Wave 4.1: build a synthetic `TaskResult` for a task that was
   * cancelled because the canary failed. Uses `status: 'failed'` (so
   * existing consumers that switch on status keep working) plus a
   * `notes` entry that callers can grep for `CANARY_ABORTED_NOTE_PREFIX`.
   */
  private makeCanaryAbortedResult(task: TaskInput, canaryResult: TaskResult): TaskResult {
    // Deep-audit #3 (2026-04-15): the synthetic trace's
    // `taskTypeSignature` previously held `task.taskType` (one of
    // 'code' | 'reasoning'), which is the wrong semantic field —
    // downstream pattern analysis expects a task-shape signature like
    // 'migrate::auth.ts'. We emit a dedicated 'canary-aborted' marker
    // so trace analysis can cluster these synthetic records without
    // polluting real task-type buckets.
    return {
      id: task.id,
      status: 'failed',
      mutations: [],
      trace: {
        id: `canary-aborted-${task.id}`,
        taskId: task.id,
        timestamp: Date.now(),
        routingLevel: 0,
        taskTypeSignature: 'canary-aborted',
        approach: 'canary-aborted',
        oracleVerdicts: {},
        modelUsed: 'none',
        tokensConsumed: 0,
        durationMs: 0,
        outcome: 'failure',
        affectedFiles: [],
      } as TaskResult['trace'],
      notes: [`${CANARY_ABORTED_NOTE_PREFIX} ${canaryResult.id} returned status=${canaryResult.status}`],
    };
  }

  getActiveCount(): number {
    return this.taskQueue.activeCount;
  }

  private async executeSingle(task: TaskInput): Promise<TaskResult> {
    const files = task.targetFiles ?? [];
    this.fileLock.tryAcquire(task.id, files);
    try {
      return await this.executeTask(task);
    } finally {
      this.fileLock.release(task.id);
    }
  }
}

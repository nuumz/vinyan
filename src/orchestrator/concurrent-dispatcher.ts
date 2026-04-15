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
import { AdvisoryFileLock } from './worker/file-lock.ts';

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
  const fileIndex = new Map<string, string[]>();
  const fileFree: string[] = [];
  for (const t of tasks) {
    const files = t.targetFiles ?? [];
    if (files.length === 0) {
      fileFree.push(t.id);
      continue;
    }
    for (const f of files) {
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

export interface ConcurrentDispatcher {
  dispatch(tasks: TaskInput[]): Promise<TaskResult[]>;
  getActiveCount(): number;
}

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
  async dispatch(tasks: TaskInput[]): Promise<TaskResult[]> {
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

    const runSerialChain = async (group: ConflictGroup): Promise<void> => {
      for (const taskId of group.taskIds) {
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

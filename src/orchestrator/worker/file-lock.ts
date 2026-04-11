/**
 * Advisory File Lock — K2.3 cross-task write conflict prevention.
 *
 * In-memory advisory lock that prevents concurrent tasks from writing
 * to the same files. No OS-level locking — purely cooperative.
 *
 * A3 compliant: deterministic conflict detection, no LLM in governance path.
 */

export interface FileLockResult {
  acquired: boolean;
  conflicts: string[];
}

export class AdvisoryFileLock {
  /** Map from file path to the task ID that holds the lock. */
  private locks = new Map<string, string>();

  /**
   * Attempt to acquire locks on the given files for a task.
   * Returns success if all files are available, or the list of conflicts.
   */
  tryAcquire(taskId: string, files: string[]): FileLockResult {
    const conflicts: string[] = [];
    for (const file of files) {
      const holder = this.locks.get(file);
      if (holder && holder !== taskId) {
        conflicts.push(file);
      }
    }

    if (conflicts.length > 0) {
      return { acquired: false, conflicts };
    }

    // All clear — acquire locks
    for (const file of files) {
      this.locks.set(file, taskId);
    }
    return { acquired: true, conflicts: [] };
  }

  /** Release all locks held by a task. */
  release(taskId: string): void {
    for (const [file, holder] of this.locks) {
      if (holder === taskId) {
        this.locks.delete(file);
      }
    }
  }

  /** Get the task ID holding the lock on a file, or undefined. */
  getHolder(file: string): string | undefined {
    return this.locks.get(file);
  }

  /** Get all files locked by a specific task. */
  getLockedFiles(taskId: string): string[] {
    const files: string[] = [];
    for (const [file, holder] of this.locks) {
      if (holder === taskId) {
        files.push(file);
      }
    }
    return files;
  }

  /** Number of currently locked files. */
  get size(): number {
    return this.locks.size;
  }
}

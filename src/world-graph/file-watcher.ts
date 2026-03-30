import { watch } from "chokidar";
import type { WorldGraph } from "./world-graph.ts";

export interface FileWatcherOptions {
  /** Glob patterns to ignore */
  ignored?: string[];
  /** Debounce delay in ms (default: 100) */
  debounceMs?: number;
}

export class FileWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private worldGraph: WorldGraph,
    private workspacePath: string,
    private options: FileWatcherOptions = {},
  ) {}

  /** Start watching the workspace for file changes. */
  start(): void {
    const ignored = this.options.ignored ?? ["**/node_modules/**", "**/.git/**", "**/.vinyan/**"];
    const debounceMs = this.options.debounceMs ?? 100;

    this.watcher = watch(this.workspacePath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
    });

    const handleChange = (filePath: string) => {
      // Debounce rapid changes to the same file
      const existing = this.debounceTimers.get(filePath);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(
        filePath,
        setTimeout(() => {
          this.debounceTimers.delete(filePath);
          try {
            this.worldGraph.invalidateByFile(filePath);
          } catch {
            // File may have been deleted between change event and hash computation
          }
        }, debounceMs),
      );
    };

    this.watcher.on("change", handleChange);
    this.watcher.on("add", handleChange);
    this.watcher.on("unlink", (filePath: string) => {
      // On file deletion, remove its hash entry — facts with old hash remain but are stale
      this.worldGraph.updateFileHash(filePath, "DELETED");
    });
  }

  /** Stop watching. */
  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

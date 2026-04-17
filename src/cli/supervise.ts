/**
 * CLI: vinyan serve supervisor.
 *
 * Spawns the actual server as a child subprocess. Provides two
 * self-healing capabilities:
 *
 *   1. Crash recovery — if the child exits non-zero (uncaught error,
 *      OOM, native crash), respawn with capped exponential backoff.
 *   2. Hot reload (opt-in via --watch) — watch the source tree and
 *      trigger a graceful child restart when a .ts file changes. This
 *      lets Vinyan evolve itself: regenerate its own code, save, and
 *      see the running server pick up the change without a manual
 *      restart.
 *
 * The parent:
 *   - Forwards SIGTERM/SIGINT to the child and exits after it does
 *   - Respawns on crash with capped exponential backoff
 *   - Resets the backoff counter once the child has been healthy > 60s
 *   - When --watch: debounces file change events (200ms) and sends
 *     SIGTERM to the child; the respawn loop brings up a fresh one.
 *
 * The child runs when VINYAN_SUPERVISED=1 is set in its env.
 */

import { watch, type FSWatcher } from 'chokidar';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'path';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const HEALTHY_THRESHOLD_MS = 60_000;
const MAX_CONSECUTIVE_CRASHES = 20;
const WATCH_DEBOUNCE_MS = 200;

/** Paths (relative to workspace) to watch for hot reload. */
const WATCH_PATHS = ['src', 'vinyan.json'];
/** File-path predicate: only .ts / vinyan.json, skip tests and noise dirs. */
function shouldIgnore(absPath: string): boolean {
  if (/node_modules|\.vinyan|\/dist\/|\/\.git\//.test(absPath)) return true;
  if (/\.(test|spec)\.ts$/.test(absPath)) return true;
  // Only react to .ts and vinyan.json (directory entries pass through)
  if (absPath.endsWith('.ts')) return false;
  if (absPath.endsWith('vinyan.json')) return false;
  // Allow directories (chokidar needs to recurse)
  // We can't stat here synchronously cheaply; chokidar passes dirs too.
  // If it looks like a file with a different extension, ignore it.
  const base = absPath.split('/').pop() ?? '';
  if (base.includes('.')) return true;
  return false;
}

export async function superviseServe(workspace: string, originalArgv: string[]): Promise<void> {
  // Strip the node/bun executable path; keep the script + args
  const [, scriptPath, ...rest] = originalArgv;
  if (!scriptPath) {
    throw new Error('superviseServe: missing script path in argv');
  }
  const bunExec = process.execPath;
  const watchMode = rest.includes('--watch');

  let crashCount = 0;
  let backoff = INITIAL_BACKOFF_MS;
  let stopping = false;
  let currentChild: ChildProcess | null = null;
  let reloadRequested = false;
  let watcher: FSWatcher | null = null;

  const installSignalForwarding = (child: ChildProcess) => {
    const forward = (signal: 'SIGTERM' | 'SIGINT') => () => {
      stopping = true;
      try {
        child.kill(signal);
      } catch {
        /* child already gone */
      }
    };
    process.on('SIGTERM', forward('SIGTERM'));
    process.on('SIGINT', forward('SIGINT'));
  };

  // ── Hot reload: watch source files and SIGTERM the child on change ──
  if (watchMode) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const absolutePaths = WATCH_PATHS.map((p) => join(workspace, p));

    watcher = watch(absolutePaths, {
      ignored: (path) => shouldIgnore(path),
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 300,
    });

    const triggerReload = (changedPath: string) => {
      if (stopping || !currentChild) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (stopping || !currentChild) return;
        console.log(`[vinyan-supervisor] File changed: ${changedPath} — reloading server...`);
        reloadRequested = true;
        try {
          currentChild.kill('SIGTERM'); // let graceful shutdown run
        } catch {
          /* child already gone */
        }
      }, WATCH_DEBOUNCE_MS);
    };

    watcher.on('change', triggerReload);
    watcher.on('add', triggerReload);
    watcher.on('unlink', triggerReload);
    watcher.on('error', (err) => {
      console.error('[vinyan-supervisor] File watcher error:', err);
    });

    console.log('[vinyan-supervisor] Hot reload enabled — watching src/**/*.ts and vinyan.json');
  }

  console.log(
    `[vinyan-supervisor] Starting server (auto-restart enabled${watchMode ? ', hot reload on' : ''} — use --no-supervise to disable)`,
  );

  while (!stopping) {
    const startedAt = Date.now();
    reloadRequested = false;

    const child = spawn(bunExec, [scriptPath, ...rest], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, VINYAN_SUPERVISED: '1' },
    });
    currentChild = child;

    installSignalForwarding(child);

    const exitCode: number = await new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve(code ?? (signal ? 128 : 0));
      });
    });
    const aliveMs = Date.now() - startedAt;
    currentChild = null;

    // Watch-triggered reload: we asked the child to exit; respawn immediately.
    if (reloadRequested && !stopping) {
      console.log(`[vinyan-supervisor] Reloading after file change (prev pid exited code=${exitCode})`);
      crashCount = 0;
      backoff = INITIAL_BACKOFF_MS;
      continue;
    }

    // Clean shutdown: child exited after user signal, or exited with 0.
    if (stopping || exitCode === 0) {
      console.log(`[vinyan-supervisor] Child exited cleanly (code=${exitCode}). Supervisor done.`);
      if (watcher) await watcher.close().catch(() => {});
      process.exit(exitCode ?? 0);
    }

    // Reset backoff if the child was healthy for a while before crashing
    if (aliveMs > HEALTHY_THRESHOLD_MS) {
      crashCount = 0;
      backoff = INITIAL_BACKOFF_MS;
    } else {
      crashCount++;
    }

    if (crashCount >= MAX_CONSECUTIVE_CRASHES) {
      console.error(
        `[vinyan-supervisor] Child crashed ${crashCount} times in rapid succession — giving up. ` +
          'Fix the crash cause and restart manually.',
      );
      if (watcher) await watcher.close().catch(() => {});
      process.exit(1);
    }

    console.error(
      `[vinyan-supervisor] Child exited with code ${exitCode} after ${aliveMs}ms. ` +
        `Restarting in ${backoff}ms (crash #${crashCount})`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  if (watcher) await watcher.close().catch(() => {});
}

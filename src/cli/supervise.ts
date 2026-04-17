/**
 * CLI: vinyan serve supervisor.
 *
 * Spawns the actual server as a child subprocess. If the child exits
 * unexpectedly (non-zero, non-SIGTERM/SIGINT), respawn with exponential
 * backoff. This gives the API server self-healing capability — a single
 * fatal error (uncaught exception that escaped serve.ts safety nets,
 * OOM, stack overflow, native crash) no longer ends the service.
 *
 * The parent:
 *   - Forwards SIGTERM/SIGINT to the child and exits after it does
 *   - Respawns on crash with capped exponential backoff
 *   - Resets the backoff counter once the child has been healthy > 60s
 *
 * The child runs when VINYAN_SUPERVISED=1 is set in its env.
 */

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const HEALTHY_THRESHOLD_MS = 60_000;
const MAX_CONSECUTIVE_CRASHES = 20;

export async function superviseServe(_workspace: string, originalArgv: string[]): Promise<void> {
  // Strip the node/bun executable path; keep the script + args
  const [, scriptPath, ...rest] = originalArgv;
  if (!scriptPath) {
    throw new Error('superviseServe: missing script path in argv');
  }
  const bunExec = process.execPath;

  let crashCount = 0;
  let backoff = INITIAL_BACKOFF_MS;
  let stopping = false;

  const installSignalForwarding = (child: ReturnType<typeof Bun.spawn>) => {
    const forward = (signal: 'SIGTERM' | 'SIGINT') => () => {
      stopping = true;
      try {
        child.kill(signal === 'SIGTERM' ? 15 : 2);
      } catch {
        /* child already gone */
      }
    };
    process.on('SIGTERM', forward('SIGTERM'));
    process.on('SIGINT', forward('SIGINT'));
  };

  console.log('[vinyan-supervisor] Starting server (auto-restart enabled — use --no-supervise to disable)');

  while (!stopping) {
    const startedAt = Date.now();

    const child = Bun.spawn([bunExec, scriptPath, ...rest], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, VINYAN_SUPERVISED: '1' },
    });

    installSignalForwarding(child);

    const exitCode = await child.exited;
    const aliveMs = Date.now() - startedAt;

    // Clean shutdown: child exited after receiving a signal we forwarded,
    // or exited with code 0. Stop the supervisor.
    if (stopping || exitCode === 0) {
      console.log(`[vinyan-supervisor] Child exited cleanly (code=${exitCode}). Supervisor done.`);
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
      process.exit(1);
    }

    console.error(
      `[vinyan-supervisor] Child exited with code ${exitCode} after ${aliveMs}ms. ` +
        `Restarting in ${backoff}ms (crash #${crashCount})`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

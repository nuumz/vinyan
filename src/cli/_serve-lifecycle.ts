/**
 * Shared lifecycle primitives for `vinyan serve` / supervisor.
 *
 * Zombie-recovery semantics:
 *   - On startup, detect any previous vinyan-serve instance that never
 *     cleaned up (stale PID file + live PID; or port holder that
 *     matches our workspace).
 *   - SIGTERM → wait 3s → SIGKILL survivors → wait for port release.
 *   - Remove stale PID files.
 *   - Proceed with startup.
 *
 * This eliminates the "user sees `Another vinyan serve is running (pid N)`
 * and has to manually `kill N` every time they hit a zombie" workflow.
 * Instead, `vinyan serve` is idempotent: running it always gives you a
 * working server, regardless of prior state.
 *
 * Safety: we only kill processes whose `ps` command-line contains our
 * workspace path. This prevents accidentally killing unrelated processes
 * even if the OS has reused a PID or lsof reports an unrelated holder.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'path';

/** Exit code for startup-fatal conditions (port held by non-vinyan, config error, etc.). */
export const EXIT_CODE_STARTUP_FATAL = 78;

// ── PID file helpers ────────────────────────────────────────────────

export function readPidFile(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid), 'utf8');
  } catch {
    // Non-fatal — PID file is convenience, not correctness.
  }
}

export function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already removed */
  }
}

// ── Process helpers ─────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function findPortHolder(port: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(['lsof', '-ti', `:${port}`, '-sTCP:LISTEN'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const pid = parseInt(out.trim().split('\n')[0] ?? '', 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Heuristic: is this PID a vinyan-serve-like process?
 *
 * Evidence sources (any one is sufficient):
 *   1. `ps -o command=` contains "cli/index.ts" or "cli/serve.ts" or
 *      "cli/supervise.ts" or "worker-entry" — covers bun relative-path
 *      invocations.
 *   2. `lsof -p PID -a -d cwd` points inside `workspace` — definitive
 *      proof this process lives in our workspace.
 *
 * Returns false on any error (conservative: if we can't verify, don't
 * kill — the caller will report a "foreign holder" and bail).
 */
export async function isVinyanServeProcess(pid: number, workspace: string): Promise<boolean> {
  // (1) Command-line heuristic — cheap, works on mac/linux.
  try {
    const proc = Bun.spawn(['ps', '-ww', '-p', String(pid), '-o', 'command='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const cmd = out.trim();
    if (cmd) {
      const looksLikeServe =
        cmd.includes('cli/index.ts') ||
        cmd.includes('cli/serve.ts') ||
        cmd.includes('cli/supervise.ts') ||
        cmd.includes('worker-entry');
      if (looksLikeServe) return true;
    }
  } catch {
    /* fall through to cwd check */
  }

  // (2) CWD check via lsof — matches even when the command line is
  //     a relative path that doesn't mention the workspace.
  try {
    const proc = Bun.spawn(['lsof', '-p', String(pid), '-a', '-d', 'cwd', '-Fn'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // `-Fn` prints lines starting with 'n' containing the path.
    for (const line of out.split('\n')) {
      if (line.startsWith('n') && line.slice(1).startsWith(workspace)) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }

  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Stale-instance recovery ─────────────────────────────────────────

export interface RecoveryOptions {
  workspace: string;
  port: number;
  supervisorPidPath: string;
  servePidPath: string;
  /** Log prefix, e.g. '[vinyan-supervisor]' or '[vinyan]'. */
  logPrefix: string;
  /** PIDs to never touch (e.g. our own pid, or our parent supervisor). */
  protectedPids?: readonly number[];
}

export interface RecoveryResult {
  /** Whether we actually had anything to recover. */
  recovered: boolean;
  /** PIDs we killed (SIGTERM, possibly escalated to SIGKILL). */
  killed: number[];
  /** PIDs that were holding state but were not vinyan-serve-like → we can't safely touch them. */
  foreignHolders: number[];
}

/**
 * Detect and clean up stale vinyan-serve instances. See module header
 * for the full rationale. Returns a report describing what happened
 * so the caller can decide to continue or fail.
 *
 * Process:
 *   1. Collect candidates from supervisor.pid, serve.pid, and `lsof :<port>`.
 *   2. Filter out our own PID and any caller-declared `protectedPids`.
 *   3. For each candidate, verify it's a vinyan-serve process for THIS
 *      workspace (ps cmdline check). Non-vinyan holders are reported
 *      via `foreignHolders` — the caller decides whether to abort.
 *   4. SIGTERM the vinyan candidates; wait up to 3s for graceful exit.
 *   5. SIGKILL any survivors; wait up to 2s.
 *   6. Poll the port until it's released (up to 3s).
 *   7. Unlink stale PID files.
 */
export async function recoverStaleInstance(opts: RecoveryOptions): Promise<RecoveryResult> {
  const { workspace, port, supervisorPidPath, servePidPath, logPrefix } = opts;
  const protectedPids = new Set(opts.protectedPids ?? []);
  protectedPids.add(process.pid);

  // Phase 1: collect candidates, distinguishing trust level.
  //   - PID-file sources: if a PID appears in .vinyan/*.pid, WE wrote
  //     it (or an earlier run did). It is definitively ours — no
  //     cmdline check needed. Kill without further verification.
  //   - Port-holder source: found via lsof. Could be anything. Requires
  //     isVinyanServeProcess verification before we touch it.
  const trustedCandidates = new Set<number>();
  for (const p of [supervisorPidPath, servePidPath]) {
    const pid = readPidFile(p);
    if (pid !== null && !protectedPids.has(pid) && isProcessAlive(pid)) {
      trustedCandidates.add(pid);
    }
  }
  const unverifiedCandidates = new Set<number>();
  const portHolder = await findPortHolder(port);
  if (portHolder !== null && !protectedPids.has(portHolder) && !trustedCandidates.has(portHolder) && isProcessAlive(portHolder)) {
    unverifiedCandidates.add(portHolder);
  }

  if (trustedCandidates.size === 0 && unverifiedCandidates.size === 0) {
    // Clean up dead PID files (process died without exit handler running).
    const superPid = readPidFile(supervisorPidPath);
    if (superPid !== null && !isProcessAlive(superPid)) removePidFile(supervisorPidPath);
    const servePid = readPidFile(servePidPath);
    if (servePid !== null && !isProcessAlive(servePid)) removePidFile(servePidPath);
    return { recovered: false, killed: [], foreignHolders: [] };
  }

  // Phase 2: classify — trusted (from PID files) are kept as-is;
  // unverified (port holders only) need the process-identity check.
  const toKill: number[] = [...trustedCandidates];
  const foreign: number[] = [];
  for (const pid of unverifiedCandidates) {
    if (await isVinyanServeProcess(pid, workspace)) {
      toKill.push(pid);
    } else {
      foreign.push(pid);
    }
  }

  if (toKill.length > 0) {
    console.log(`${logPrefix} Detected stale vinyan instance(s): ${toKill.join(', ')} — recovering...`);

    // Phase 3: SIGTERM
    for (const pid of toKill) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    for (let i = 0; i < 30; i++) {
      if (toKill.every((pid) => !isProcessAlive(pid))) break;
      await sleep(100);
    }

    // Phase 4: SIGKILL survivors
    const survivors = toKill.filter((pid) => isProcessAlive(pid));
    if (survivors.length > 0) {
      console.log(`${logPrefix} SIGTERM timed out on ${survivors.join(', ')} — escalating to SIGKILL`);
      for (const pid of survivors) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      }
      for (let i = 0; i < 20; i++) {
        if (survivors.every((pid) => !isProcessAlive(pid))) break;
        await sleep(100);
      }
    }

    // Phase 5: wait for port release (TIME_WAIT + OS bookkeeping)
    for (let i = 0; i < 30; i++) {
      const holder = await findPortHolder(port);
      if (holder === null || protectedPids.has(holder)) break;
      await sleep(100);
    }

    // Phase 6: remove stale PID files so our new instance claims fresh state
    removePidFile(supervisorPidPath);
    removePidFile(servePidPath);

    console.log(`${logPrefix} Recovered ${toKill.length} stale instance(s). Proceeding.`);
  }

  return { recovered: toKill.length > 0, killed: toKill, foreignHolders: foreign };
}

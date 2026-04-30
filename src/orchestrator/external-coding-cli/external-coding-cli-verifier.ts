/**
 * Verification — Vinyan's deterministic check on a CLI's "done" claim.
 *
 * Three deterministic checks (A1, A3):
 *   1. Filesystem reality: the changed files the CLI claimed actually exist
 *      and match what `git status --porcelain` shows. If the CLI claimed a
 *      file change that did not occur (or vice versa), prediction error.
 *   2. Build/test (optional): when `runTests: true`, run a configured test
 *      command and capture pass/fail counts. Failure flips the verdict
 *      regardless of the CLI's `claimedPassed`.
 *   3. Goal alignment (optional): if a `goalAlignmentOracle` is provided,
 *      run it against the changed files. Its verdict joins the chain.
 *
 * The verifier never trusts the CLI's self-report. `predictionError` is
 * recorded explicitly when the CLI claimed pass but the deterministic
 * verdict is fail (A7: prediction error as learning signal).
 */
import { spawn } from 'bun';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { CodingCliResult, CodingCliVerificationOutcome } from './types.ts';

export interface VerifierOptions {
  cwd: string;
  /** When set, run this command (argv form) and parse pass/fail counters. */
  testCommand?: { bin: string; args: string[]; timeoutMs?: number };
  /** Plug-in oracle: receives changed files, returns verdict. */
  goalAlignmentOracle?: (changedFiles: string[]) => Promise<{ ok: boolean; detail?: string }>;
  /** Skip git diff check (e.g., not a git repo). Default: false. */
  skipGitDiffCheck?: boolean;
}

export class CodingCliVerifier {
  constructor(private readonly opts: VerifierOptions) {}

  async verify(claim: CodingCliResult): Promise<CodingCliVerificationOutcome> {
    const oracleVerdicts: CodingCliVerificationOutcome['oracleVerdicts'] = [];
    let allOk = true;

    // 1. Git diff sanity.
    if (!this.opts.skipGitDiffCheck) {
      const gitVerdict = await this.checkGitDiff(claim);
      oracleVerdicts.push(gitVerdict);
      if (!gitVerdict.ok) allOk = false;
    }

    // 2. Tests, if configured.
    let testResults: CodingCliVerificationOutcome['testResults'] | undefined;
    if (this.opts.testCommand) {
      const test = await this.runTestCommand();
      testResults = test.results;
      oracleVerdicts.push({ name: 'test', ok: test.ok, detail: test.detail });
      if (!test.ok) allOk = false;
    }

    // 3. Goal alignment, if configured.
    if (this.opts.goalAlignmentOracle) {
      try {
        const verdict = await this.opts.goalAlignmentOracle(claim.changedFiles);
        oracleVerdicts.push({ name: 'goal-alignment', ok: verdict.ok, detail: verdict.detail });
        if (!verdict.ok) allOk = false;
      } catch (err) {
        oracleVerdicts.push({ name: 'goal-alignment', ok: false, detail: (err as Error).message });
        allOk = false;
      }
    }

    const passed = allOk;
    const predictionError = !!(claim.verification?.claimedPassed && !passed);
    let reason: string | undefined;
    if (predictionError) {
      reason = 'CLI self-reported pass but Vinyan verification failed';
    } else if (!passed) {
      reason = 'verification failed';
    }
    return { passed, oracleVerdicts, testResults, predictionError, reason };
  }

  private async checkGitDiff(claim: CodingCliResult): Promise<{ name: string; ok: boolean; detail?: string }> {
    const status = await this.runGit(['status', '--porcelain']);
    if (status.exitCode !== 0) {
      return { name: 'git-diff', ok: false, detail: `git status failed: ${status.stderr}` };
    }
    const actualPaths = status.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^.{1,2}\s+/, ''))
      .map((line) => line.split(' -> ').pop() ?? line);
    const claimed = new Set(claim.changedFiles.map((p) => path.relative(this.opts.cwd, path.resolve(this.opts.cwd, p))));
    const actual = new Set(actualPaths);

    // Liar detection: claimed change that is not in `git status` AND does
    // not exist on disk → false claim.
    const phantomClaims: string[] = [];
    for (const c of claimed) {
      if (!actual.has(c)) {
        const abs = path.resolve(this.opts.cwd, c);
        if (!fs.existsSync(abs)) {
          phantomClaims.push(c);
        }
      }
    }
    // Silent edits: changes on disk the CLI didn't disclose.
    const silentEdits: string[] = [];
    for (const a of actual) {
      if (!claimed.has(a)) silentEdits.push(a);
    }

    if (phantomClaims.length > 0) {
      return {
        name: 'git-diff',
        ok: false,
        detail: `phantom file claims: ${phantomClaims.join(', ')}`,
      };
    }
    if (silentEdits.length > 0) {
      return {
        name: 'git-diff',
        ok: false,
        detail: `undisclosed edits: ${silentEdits.join(', ')}`,
      };
    }
    return { name: 'git-diff', ok: true };
  }

  private async runTestCommand(): Promise<{
    ok: boolean;
    detail: string;
    results?: CodingCliVerificationOutcome['testResults'];
  }> {
    const { bin, args, timeoutMs } = this.opts.testCommand!;
    const env: Record<string, string> = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    let proc: ReturnType<typeof spawn> | null = null;
    try {
      proc = spawn({
        cmd: [bin, ...args],
        cwd: this.opts.cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => {
        try { proc?.kill('SIGTERM'); } catch {}
      }, timeoutMs ?? 5 * 60 * 1000);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as unknown as ReadableStream).text(),
        new Response(proc.stderr as unknown as ReadableStream).text(),
      ]);
      const exit = await proc.exited;
      clearTimeout(timer);
      const detail = `${stdout.slice(-2048)}\n${stderr.slice(-2048)}`;
      const counts = parseTestCounts(`${stdout}\n${stderr}`);
      return {
        ok: exit === 0,
        detail,
        results: counts,
      };
    } catch (err) {
      return { ok: false, detail: `test command crashed: ${(err as Error).message}` };
    }
  }

  private async runGit(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const env: Record<string, string> = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    try {
      const proc = spawn({
        cmd: ['git', ...args],
        cwd: this.opts.cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as unknown as ReadableStream).text(),
        new Response(proc.stderr as unknown as ReadableStream).text(),
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    } catch (err) {
      return { exitCode: -1, stdout: '', stderr: (err as Error).message };
    }
  }
}

/**
 * Best-effort test-count parser for common runners. Recognized formats:
 *   - bun: "Tests: passed N, failed N"
 *   - jest: "Tests: N passed, N failed, N skipped, N total"
 *   - pytest: "X passed, Y failed, Z skipped"
 *   - vitest: similar to jest
 */
function parseTestCounts(text: string): { passed: number; failed: number; skipped: number } {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const passed = text.match(/(\d+)\s+passed/i);
  const failed = text.match(/(\d+)\s+(failed|failures?)/i);
  const skipped = text.match(/(\d+)\s+(skipped|skips?)/i);
  if (passed && passed[1] !== undefined) counts.passed = parseInt(passed[1], 10);
  if (failed && failed[1] !== undefined) counts.failed = parseInt(failed[1], 10);
  if (skipped && skipped[1] !== undefined) counts.skipped = parseInt(skipped[1], 10);
  return counts;
}

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import type { Evidence, HypothesisTuple, OracleVerdict } from '../../core/types.ts';

const BASE_RATE = 0.5;
const TTL_MS = 600_000;

/**
 * Type Verifier — spawns `tsc --noEmit` on the workspace and parses diagnostic output.
 * verified = zero diagnostics for the target file(s).
 */

interface TscDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Parse tsc diagnostic output format: file(line,col): error TSxxxx: message */
function parseTscOutput(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    // Match: path/to/file.ts(line,col): error TS1234: message
    // Path may contain ../  and spaces
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (match) {
      diagnostics.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        col: parseInt(match[3]!, 10),
        code: match[4]!,
        message: match[5]!,
      });
    }
  }

  return diagnostics;
}

/** Resolve path to tsc binary from this package's node_modules. */
function resolveTscPath(): string {
  // Use the tsc installed in our own node_modules, not bunx (which depends on CWD's .npmrc)
  const localTsc = new URL('../../../node_modules/.bin/tsc', import.meta.url).pathname;
  return localTsc;
}

const TSC_TIMEOUT_MS = 30_000;
const DEDUP_WINDOW_MS = 2_000;

type TscResult = { diagnostics: TscDiagnostic[]; exitCode: number; timedOut?: boolean };

/** Dedup cache: concurrent tsc runs for the same workspace share one invocation. */
const pendingTsc = new Map<string, Promise<TscResult>>();

/** Ensure .vinyan cache directory exists and return tsBuildInfoFile path. */
function tsBuildInfoPath(workspace: string): string {
  const cacheDir = join(workspace, '.vinyan');
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return join(cacheDir, 'tsbuildinfo');
}

/** Core tsc invocation with incremental mode. */
async function runTscCore(workspace: string): Promise<TscResult> {
  const buildInfoFile = tsBuildInfoPath(workspace);
  const args = [
    '--noEmit', '--pretty', 'false', '--project', workspace,
    '--incremental', '--tsBuildInfoFile', buildInfoFile,
  ];

  const proc = Bun.spawn([resolveTscPath(), ...args], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), TSC_TIMEOUT_MS);
  });
  const processPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  })();

  const result = await Promise.race([processPromise, timeoutPromise]);
  clearTimeout(timer!);
  if (result === 'timeout') {
    proc.kill();
    return { diagnostics: [], exitCode: -1, timedOut: true };
  }

  return { diagnostics: parseTscOutput(result.stdout), exitCode: result.exitCode };
}

/** Run tsc --noEmit with dedup: concurrent calls for the same workspace share one invocation. */
async function runTsc(workspace: string): Promise<TscResult> {
  const cached = pendingTsc.get(workspace);
  if (cached) return cached;

  const promise = runTscCore(workspace);
  pendingTsc.set(workspace, promise);
  promise.then(
    () => setTimeout(() => pendingTsc.delete(workspace), DEDUP_WINDOW_MS),
    () => pendingTsc.delete(workspace),
  );

  return promise;
}

/** Clear the tsc dedup cache — exposed for testing. */
export function clearTscCache(): void {
  pendingTsc.clear();
}

export async function verify(hypothesis: HypothesisTuple): Promise<OracleVerdict> {
  const startTime = performance.now();
  const workspace = hypothesis.workspace;
  const target = hypothesis.target;

  try {
    const tscResult = await runTsc(workspace);

    // A2: Timeout → uncertain rather than unknown (partial information available)
    if (tscResult.timedOut) {
      return buildVerdict({
        verified: false,
        type: 'uncertain',
        confidence: 0.2,
        evidence: [],
        fileHashes: {},
        reason: `Type verification timed out after ${TSC_TIMEOUT_MS}ms`,
        errorCode: 'TIMEOUT',
        durationMs: Math.round(performance.now() - startTime),
        opinion: fromScalar(0.2, BASE_RATE),
        temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
      });
    }

    const { diagnostics } = tscResult;

    // Filter diagnostics to target file if specified
    const targetDiags = target
      ? diagnostics.filter((d) => d.file.includes(target) || d.file.endsWith(target))
      : diagnostics;

    const evidence: Evidence[] = targetDiags.map((d) => ({
      file: d.file,
      line: d.line,
      snippet: `${d.code}: ${d.message}`,
    }));

    // Compute file hash if target exists as a file
    const fileHashes: Record<string, string> = {};
    try {
      const content = readFileSync(target);
      fileHashes[target] = createHash('sha256').update(content).digest('hex');
    } catch {
      // target might be a symbol path, not a file — that's fine
    }

    return buildVerdict({
      verified: targetDiags.length === 0,
      type: 'known',
      confidence: 1.0,
      evidence,
      fileHashes,
      reason: targetDiags.length > 0 ? `${targetDiags.length} type error(s) found` : undefined,
      errorCode: targetDiags.length > 0 ? 'TYPE_MISMATCH' : undefined,
      durationMs: Math.round(performance.now() - startTime),
      opinion: fromScalar(1.0, BASE_RATE),
      temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
    });
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Type verification failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'ORACLE_CRASH',
      durationMs: Math.round(performance.now() - startTime),
      opinion: fromScalar(0, BASE_RATE),
      temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'exponential' as const, halfLife: 300_000 },
    });
  }
}

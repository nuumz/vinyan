/**
 * python-type-oracle -- standalone process entry point.
 * Reads HypothesisTuple from stdin, writes OracleVerdict to stdout.
 *
 * Runs `pyright --outputjson` on the target file or workspace.
 */

import { buildVerdict } from '../../core/index.ts';
import { HypothesisTupleSchema } from '../protocol.ts';
import { parsePyrightOutput } from './pyright-mapper.ts';

const PYRIGHT_TIMEOUT_MS = 60_000;

const input = await Bun.stdin.text();
const hypothesis = HypothesisTupleSchema.parse(JSON.parse(input));

const startTime = performance.now();

// Determine target: specific file or whole workspace
const target = hypothesis.target || hypothesis.workspace;
const args = ['--outputjson', target];

const proc = Bun.spawn(['pyright', ...args], {
  cwd: hypothesis.workspace,
  stdout: 'pipe',
  stderr: 'pipe',
});

const timeoutPromise = new Promise<'timeout'>((resolve) => {
  setTimeout(() => resolve('timeout'), PYRIGHT_TIMEOUT_MS);
});

const processPromise = (async () => {
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
})();

const result = await Promise.race([processPromise, timeoutPromise]);
const durationMs = Math.round(performance.now() - startTime);

if (result === 'timeout') {
  proc.kill();
  const verdict = buildVerdict({
    verified: false,
    type: 'uncertain',
    confidence: 0.2,
    evidence: [],
    fileHashes: {},
    reason: `Pyright timed out after ${PYRIGHT_TIMEOUT_MS}ms`,
    errorCode: 'TIMEOUT',
    durationMs,
  });
  process.stdout.write(JSON.stringify(verdict) + '\n');
} else {
  // Pyright exits non-zero when type errors exist -- that's normal, not a crash.
  // Only treat it as a crash if stdout is empty (no JSON output).
  if (!result.stdout.trim()) {
    const stderr = await new Response(proc.stderr).text();
    const verdict = buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Pyright produced no output (exit ${result.exitCode}): ${stderr.slice(0, 500)}`,
      errorCode: 'ORACLE_CRASH',
      durationMs,
    });
    process.stdout.write(JSON.stringify(verdict) + '\n');
  } else {
    const verdict = parsePyrightOutput(result.stdout.trim(), durationMs);
    process.stdout.write(JSON.stringify(verdict) + '\n');
  }
}

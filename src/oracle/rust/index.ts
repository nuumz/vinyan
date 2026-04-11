/**
 * rust-oracle -- standalone process entry point.
 * Reads HypothesisTuple from stdin, writes OracleVerdict to stdout.
 *
 * Dispatches to the appropriate Cargo tool based on hypothesis.pattern:
 * - type-check / borrow-check / lifetime-valid / trait-satisfies → `cargo check`
 * - unsafe-audit → `cargo check` (unsafe detection is part of standard compilation)
 */

import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import { HypothesisTupleSchema } from '../protocol.ts';
import { parseCargoCheckOutput } from './cargo-output-mapper.ts';

const BASE_RATE = 0.5;
const TTL_MS = 600_000;

const CARGO_TIMEOUT_MS = 120_000; // Rust compilation can be slow

const input = await Bun.stdin.text();
const hypothesis = HypothesisTupleSchema.parse(JSON.parse(input));

const startTime = performance.now();
const pattern = hypothesis.pattern;
const cwd = hypothesis.workspace;

const SUPPORTED_PATTERNS = new Set([
  'type-check',
  'borrow-check',
  'lifetime-valid',
  'trait-satisfies',
  'unsafe-audit',
]);

if (!SUPPORTED_PATTERNS.has(pattern)) {
  const verdict = buildVerdict({
    verified: false,
    type: 'unknown',
    confidence: 0,
    opinion: fromScalar(0, BASE_RATE),
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential' as const,
      halfLife: 300_000,
    },
    evidence: [],
    fileHashes: {},
    reason: `Unsupported Rust oracle pattern: ${pattern}`,
    errorCode: 'UNSUPPORTED_PATTERN',
    durationMs: Math.round(performance.now() - startTime),
  });
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
} else {
  // All patterns use `cargo check --message-format=json`
  // The Rust compiler reports all of these in a single pass:
  // type errors, borrow violations, lifetime issues, trait bounds, unsafe blocks
  const args = ['check', '--message-format=json'];

  // For specific file targets, use --lib or package filtering if provided
  // cargo check always checks the whole crate; target filtering is by package
  if (hypothesis.target && !hypothesis.target.includes('/')) {
    args.push('-p', hypothesis.target);
  }

  const proc = Bun.spawn(['cargo', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), CARGO_TIMEOUT_MS);
  });

  const processPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  const result = await Promise.race([processPromise, timeoutPromise]);
  const durationMs = Math.round(performance.now() - startTime);

  let verdict;
  if (result === 'timeout') {
    proc.kill();
    verdict = buildVerdict({
      verified: false,
      type: 'uncertain',
      confidence: 0.2,
      opinion: fromScalar(0.2, BASE_RATE),
      temporalContext: {
        validFrom: Date.now(),
        validUntil: Date.now() + TTL_MS,
        decayModel: 'exponential' as const,
        halfLife: 300_000,
      },
      evidence: [],
      fileHashes: {},
      reason: `Cargo check timed out after ${CARGO_TIMEOUT_MS}ms`,
      errorCode: 'TIMEOUT',
      durationMs,
    });
  } else {
    verdict = parseCargoCheckOutput(result.stdout, result.stderr, result.exitCode, durationMs);
  }

  process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

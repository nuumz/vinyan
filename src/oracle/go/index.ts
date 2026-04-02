/**
 * go-oracle -- standalone process entry point.
 * Reads HypothesisTuple from stdin, writes OracleVerdict to stdout.
 *
 * Dispatches to the appropriate Go tool based on hypothesis.pattern:
 * - type-check / import-exists / interface-satisfies → `go build`
 * - vet → `go vet`
 * - module-tidy → `go mod tidy -diff`
 */

import { buildVerdict } from '../../core/index.ts';
import { HypothesisTupleSchema } from '../protocol.ts';
import { parseGoBuildOutput, parseGoModTidyOutput, parseGoVetOutput } from './go-output-mapper.ts';

const GO_TIMEOUT_MS = 60_000;

const input = await Bun.stdin.text();
const hypothesis = HypothesisTupleSchema.parse(JSON.parse(input));

const startTime = performance.now();
const pattern = hypothesis.pattern;
const cwd = hypothesis.workspace;

async function runCommand(cmd: string[], opts?: { captureStdout?: boolean }) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), GO_TIMEOUT_MS);
  });

  const processPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  })();

  const result = await Promise.race([processPromise, timeoutPromise]);
  const durationMs = Math.round(performance.now() - startTime);

  if (result === 'timeout') {
    proc.kill();
    return buildVerdict({
      verified: false,
      type: 'uncertain',
      confidence: 0.2,
      evidence: [],
      fileHashes: {},
      reason: `Go tool timed out after ${GO_TIMEOUT_MS}ms`,
      errorCode: 'TIMEOUT',
      durationMs,
    });
  }

  return { ...result, durationMs };
}

let verdict;

switch (pattern) {
  case 'type-check':
  case 'import-exists':
  case 'interface-satisfies': {
    // go build checks types, imports, and interface satisfaction
    const target = hypothesis.target ? `./${hypothesis.target}` : './...';
    const result = await runCommand(['go', 'build', '-o', '/dev/null', target]);
    if ('verified' in result) {
      verdict = result; // timeout verdict
    } else {
      verdict = parseGoBuildOutput(result.stderr, result.exitCode, result.durationMs);
    }
    break;
  }

  case 'vet': {
    const target = hypothesis.target ? `./${hypothesis.target}` : './...';
    const result = await runCommand(['go', 'vet', target]);
    if ('verified' in result) {
      verdict = result;
    } else {
      verdict = parseGoVetOutput(result.stderr, result.exitCode, result.durationMs);
    }
    break;
  }

  case 'module-tidy': {
    const result = await runCommand(['go', 'mod', 'tidy', '-diff']);
    if ('verified' in result) {
      verdict = result;
    } else {
      verdict = parseGoModTidyOutput(result.stdout, result.exitCode, result.durationMs);
    }
    break;
  }

  default:
    verdict = buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Unsupported Go oracle pattern: ${pattern}`,
      errorCode: 'UNSUPPORTED_PATTERN',
      durationMs: Math.round(performance.now() - startTime),
    });
}

process.stdout.write(`${JSON.stringify(verdict)}\n`);

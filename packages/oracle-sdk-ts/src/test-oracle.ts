/**
 * testOracle — test utility for validating oracle implementations.
 *
 * Runs an oracle process with test fixtures and validates the output
 * matches the OracleVerdict schema.
 *
 * Usage:
 * ```ts
 * import { testOracle } from '@vinyan/oracle-sdk';
 *
 * const results = await testOracle('bun run src/my-oracle/index.ts', [
 *   {
 *     name: 'clean file',
 *     hypothesis: { target: 'clean.ts', pattern: 'type-check', workspace: '/tmp/test' },
 *     expect: { verified: true },
 *   },
 *   {
 *     name: 'type error',
 *     hypothesis: { target: 'bad.ts', pattern: 'type-check', workspace: '/tmp/test' },
 *     expect: { verified: false, errorCode: 'TYPE_MISMATCH' },
 *   },
 * ]);
 * ```
 */

import { OracleVerdictSchema, type HypothesisTuple, type OracleVerdict } from './schemas.ts';

export interface OracleTestFixture {
  /** Test name for reporting. */
  name: string;
  /** Input hypothesis to send to the oracle. */
  hypothesis: HypothesisTuple;
  /** Expected verdict fields (partial match). */
  expect: Partial<OracleVerdict>;
  /** Optional timeout in ms (default: 30_000). */
  timeoutMs?: number;
}

export interface OracleTestResult {
  name: string;
  passed: boolean;
  verdict?: OracleVerdict;
  error?: string;
  durationMs: number;
}

/**
 * Run an oracle process against test fixtures and validate output.
 *
 * @param command - The command to spawn the oracle (e.g., 'bun run src/oracle/index.ts')
 * @param fixtures - Array of test fixtures with expected results
 * @returns Array of test results
 */
export async function testOracle(command: string, fixtures: OracleTestFixture[]): Promise<OracleTestResult[]> {
  const results: OracleTestResult[] = [];

  for (const fixture of fixtures) {
    const startTime = performance.now();
    const timeoutMs = fixture.timeoutMs ?? 30_000;

    try {
      const parts = command.split(/\s+/);
      const proc = Bun.spawn(parts, {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Write hypothesis to stdin
      const stdin = proc.stdin;
      stdin.write(new TextEncoder().encode(JSON.stringify(fixture.hypothesis)));
      stdin.flush();
      stdin.end();

      // Race process vs timeout
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs);
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
        results.push({
          name: fixture.name,
          passed: false,
          error: `Oracle timed out after ${timeoutMs}ms`,
          durationMs,
        });
        continue;
      }

      // Parse verdict
      const raw = result.stdout.trim();
      if (!raw) {
        results.push({
          name: fixture.name,
          passed: false,
          error: `Oracle produced no output (exit ${result.exitCode})`,
          durationMs,
        });
        continue;
      }

      const parsed = OracleVerdictSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        results.push({
          name: fixture.name,
          passed: false,
          error: `Invalid OracleVerdict: ${parsed.error.message}`,
          durationMs,
        });
        continue;
      }

      const verdict = parsed.data;

      // Check expected fields
      const mismatches: string[] = [];
      for (const [key, expected] of Object.entries(fixture.expect)) {
        const actual = (verdict as Record<string, unknown>)[key];
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      }

      results.push({
        name: fixture.name,
        passed: mismatches.length === 0,
        verdict,
        error: mismatches.length > 0 ? mismatches.join('; ') : undefined,
        durationMs,
      });
    } catch (err) {
      results.push({
        name: fixture.name,
        passed: false,
        error: `Exception: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Math.round(performance.now() - startTime),
      });
    }
  }

  return results;
}

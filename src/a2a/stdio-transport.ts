/**
 * StdioTransport — child process oracle execution via stdin/stdout.
 *
 * Extracted from runner.ts to implement ECPTransport interface.
 * Writes HypothesisTuple JSON to stdin, reads OracleVerdict JSON from stdout.
 *
 * Source of truth: Plan Phase B1
 */

import { buildVerdict } from '../core/index.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { OracleVerdictSchema } from '../oracle/protocol.ts';
import type { ECPTransport } from './transport.ts';

export interface StdioTransportConfig {
  /** Bun.spawn arguments — e.g. ["bun", "run", "path/to/oracle.ts"] or ["python", "oracle.py"] */
  spawnArgs: string[];
  /** Oracle name for error messages. */
  oracleName: string;
}

export class StdioTransport implements ECPTransport {
  readonly transportType = 'stdio' as const;
  readonly connected = true;
  private config: StdioTransportConfig;

  constructor(config: StdioTransportConfig) {
    this.config = config;
  }

  async verify(hypothesis: HypothesisTuple, timeoutMs: number): Promise<OracleVerdict> {
    const startTime = performance.now();
    const { spawnArgs, oracleName } = this.config;

    const proc = Bun.spawn(spawnArgs, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const input = JSON.stringify(hypothesis) + '\n';
    proc.stdin.write(input);
    proc.stdin.end();

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const processPromise = (async () => {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    })();

    const result = await Promise.race([processPromise, timeoutPromise]);

    if (result === 'timeout') {
      proc.kill();
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: `Oracle '${oracleName}' timed out after ${timeoutMs}ms`,
        errorCode: 'TIMEOUT',
        durationMs: timeoutMs,
      });
    }

    const durationMs = Math.round(performance.now() - startTime);

    if (result.exitCode !== 0) {
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: `Oracle '${oracleName}' exited with code ${result.exitCode}`,
        errorCode: 'ORACLE_CRASH',
        durationMs,
      });
    }

    try {
      const raw = JSON.parse(result.stdout.trim());
      const verdict = OracleVerdictSchema.parse(raw);
      return { ...verdict, oracleName, durationMs };
    } catch (err) {
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: `Failed to parse oracle output: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 'PARSE_ERROR',
        durationMs,
      });
    }
  }

  async close(): Promise<void> {
    // Stdio transport has no persistent connection to close
  }
}

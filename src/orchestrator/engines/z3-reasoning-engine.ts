/**
 * Z3 Constraint Solver — ReasoningEngine implementation for SAT/SMT solving.
 *
 * Spawns z3 as a subprocess, feeds constraints from the user prompt,
 * and returns the result as an REResponse.
 *
 * A5 compliant: deterministic engine, highest trust tier.
 * A3 compliant: no LLM in governance path — pure constraint solving.
 */
import type { ReasoningEngine, RERequest, REResponse } from '../types.ts';

export interface Z3EngineConfig {
  /** Path to z3 binary (default: 'z3' from PATH). */
  z3Path?: string;
  /** Timeout in ms for z3 subprocess (default: 30s). */
  timeoutMs?: number;
}

export class Z3ReasoningEngine implements ReasoningEngine {
  readonly id = 'z3-solver';
  readonly engineType = 'symbolic' as const;
  readonly capabilities = ['constraint-solving', 'satisfiability', 'optimization'];
  readonly tier = undefined; // non-LLM — no tier mapping
  readonly maxContextTokens = undefined;

  private z3Path: string;
  private timeoutMs: number;

  constructor(config?: Z3EngineConfig) {
    this.z3Path = config?.z3Path ?? 'z3';
    this.timeoutMs = config?.timeoutMs ?? 30_000;
  }

  async execute(request: RERequest): Promise<REResponse> {
    const startTime = performance.now();

    // The user prompt should contain SMT-LIB2 or Z3 input
    const input = request.userPrompt;

    try {
      const proc = Bun.spawn([this.z3Path, '-in', '-T:' + Math.ceil(this.timeoutMs / 1000)], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Write constraint to stdin
      proc.stdin.write(input);
      proc.stdin.end();

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      const durationMs = performance.now() - startTime;

      if (exitCode !== 0 && !output.includes('unsat') && !output.includes('sat')) {
        return {
          content: `Z3 error (exit ${exitCode}): ${stderr || output}`.trim(),
          toolCalls: [],
          tokensUsed: { input: input.length, output: output.length },
          engineId: this.id,
          terminationReason: 'completed',
          providerMeta: { durationMs, exitCode },
        };
      }

      return {
        content: output.trim(),
        toolCalls: [],
        tokensUsed: { input: input.length, output: output.length },
        engineId: this.id,
        terminationReason: 'completed',
        providerMeta: { durationMs, exitCode },
      };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      return {
        content: `Z3 unavailable: ${message}. Ensure z3 is installed and accessible at '${this.z3Path}'.`,
        toolCalls: [],
        tokensUsed: { input: input.length, output: 0 },
        engineId: this.id,
        terminationReason: 'completed',
        providerMeta: { durationMs, error: message },
      };
    }
  }
}

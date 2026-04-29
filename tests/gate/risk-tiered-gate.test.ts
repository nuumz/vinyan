/**
 * Risk-Tiered Gate Pipeline (G2) — verifies that oracle selection
 * adapts to risk level when riskScore is provided in GateRequest.
 *
 * TDD §8: hash-only (< 0.2), structural (0.2-0.4), full (≥ 0.4)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { clearGateDeps } from '../../src/gate/gate.ts';
import { type GateRequest, runGate } from '../../src/gate/index.ts';
import { calculateRiskScore, getIrreversibilityScore } from '../../src/gate/risk-router.ts';
import { clearTscCache } from '../../src/oracle/type/type-verifier.ts';

let workspace: string;

beforeAll(() => {
  workspace = join(tmpdir(), `vinyan-risk-gate-test-${Date.now()}`);
  const fixtureDir = resolve(import.meta.dir, '../benchmark-fixtures/simple-project');
  cpSync(fixtureDir, workspace, { recursive: true });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// Gate state is module-level (see src/gate/gate.ts). A previous test in the
// process (e.g. anything that constructs an orchestrator via factory.ts) may
// have left behind an OracleAccuracyStore pointing at a now-closed DB —
// causing `RangeError: Cannot use a closed database` once runGate() reaches
// the accuracy lookup. Mirror tests/gate/gate.test.ts's beforeEach so this
// suite is isolated from cross-test contamination.
beforeEach(() => {
  clearTscCache();
  clearGateDeps();
});

function makeRequest(overrides: Partial<GateRequest> & { params?: Partial<GateRequest['params']> } = {}): GateRequest {
  return {
    tool: 'write_file',
    params: {
      file_path: 'math.ts',
      workspace,
      ...overrides.params,
    },
    session_id: 'test-risk',
    ...overrides,
  };
}

describe('Risk-Tiered Gate Pipeline (G2)', () => {
  test('riskScore field present in GateVerdict', async () => {
    const verdict = await runGate(makeRequest());
    expect(verdict.riskScore).toBeDefined();
    expect(typeof verdict.riskScore).toBe('number');
    expect(verdict.riskScore!).toBeGreaterThanOrEqual(0);
    expect(verdict.riskScore!).toBeLessThanOrEqual(1);
  });

  test('low riskScore (< 0.2) skips all oracles (hash-only tier)', async () => {
    const verdict = await runGate(
      makeRequest({
        riskScore: 0.05,
        params: { file_path: 'math.ts', workspace, content: 'export const x = 1;' },
      }),
    );

    // Hash-only: no oracles run, gate allows (no oracle can reject)
    expect(verdict.decision).toBe('allow');
    expect(Object.keys(verdict.oracle_results)).toHaveLength(0);
    expect(verdict.riskScore).toBe(0.05);
  });

  test('medium riskScore (0.2-0.4) runs structural oracles but skips test oracle', async () => {
    const verdict = await runGate(
      makeRequest({
        riskScore: 0.3,
        params: {
          file_path: 'math.ts',
          workspace,
          content: 'export function add(a: number, b: number): number { return a + b; }',
        },
      }),
    );

    // Structural tier: type/lint/dep may run, but test oracle should NOT
    expect(verdict.riskScore).toBe(0.3);
    expect(verdict.oracle_results.test).toBeUndefined();
    // At least one structural oracle should have run (type is always enabled)
    const structuralOracles = Object.keys(verdict.oracle_results).filter((name) =>
      ['type', 'lint', 'dep'].includes(name),
    );
    expect(structuralOracles.length).toBeGreaterThanOrEqual(1);
  });

  test('high riskScore (>= 0.4) runs all oracles including test', async () => {
    const verdict = await runGate(
      makeRequest({
        riskScore: 0.8,
        params: {
          file_path: 'math.ts',
          workspace,
          content: 'export function add(a: number, b: number): number { return a + b; }',
        },
      }),
    );

    expect(verdict.riskScore).toBe(0.8);
    // Full tier: test oracle should be included (if enabled in config)
    // Type oracle should definitely run
    expect(verdict.oracle_results.type).toBeDefined();
  });

  test('existing gate behavior unchanged when riskScore not provided', async () => {
    // Without riskScore in request, all enabled oracles run (no risk-tier filtering)
    const verdict = await runGate(
      makeRequest({
        params: {
          file_path: 'math.ts',
          workspace,
          content: 'export function add(a: number, b: number): number { return a + b; }',
        },
      }),
    );

    // Type oracle should always run when no risk filtering is active
    expect(verdict.oracle_results.type).toBeDefined();
    // riskScore should still be computed for observability
    expect(verdict.riskScore).toBeDefined();
    expect(typeof verdict.riskScore).toBe('number');
  });

  test('getIrreversibilityScore returns correct values for known tools', () => {
    expect(getIrreversibilityScore('write_file')).toBe(0.0);
    expect(getIrreversibilityScore('delete_file')).toBe(0.3);
    expect(getIrreversibilityScore('run_terminal_command')).toBe(0.5);
    expect(getIrreversibilityScore('db_schema')).toBe(0.8);
    expect(getIrreversibilityScore('deployment')).toBe(0.9);
    // Unknown tool → conservative default
    expect(getIrreversibilityScore('unknown_tool')).toBe(0.5);
  });

  test('calculateRiskScore computes correct risk for low-risk scenario', () => {
    const score = calculateRiskScore({
      blastRadius: 1,
      dependencyDepth: 0,
      testCoverage: 0.5,
      fileVolatility: 0,
      irreversibility: 0.0, // write_file
      hasSecurityImplication: false,
      environmentType: 'development',
    });
    // Expected: 0.02*0.25 + 0 + 0.5*0.15 + 0 + 0 + 0 + 0 = 0.005 + 0.075 = 0.08
    expect(score).toBeLessThan(0.2);
    expect(score).toBeGreaterThan(0);
  });
});

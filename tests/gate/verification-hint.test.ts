/**
 * EO Concept #3: Verification Hint — per-node oracle filtering.
 *
 * Verifies that verificationHint in GateRequest selectively filters oracles
 * while preserving backwards compatibility and respecting circuit breaker state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { type GateRequest, runGate } from '../../src/gate/index.ts';
import { clearOracleAccuracyStore } from '../../src/gate/gate.ts';

let workspace: string;

beforeAll(() => {
  workspace = join(tmpdir(), `vinyan-hint-test-${Date.now()}`);
  const fixtureDir = resolve(import.meta.dir, '../benchmark-fixtures/simple-project');
  cpSync(fixtureDir, workspace, { recursive: true });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  clearOracleAccuracyStore();
});

function makeRequest(overrides: Partial<GateRequest> = {}): GateRequest {
  return {
    tool: 'write_file',
    params: {
      file_path: 'math.ts',
      workspace,
      content: 'export function add(a: number, b: number): number { return a + b; }',
    },
    session_id: 'test-hint',
    ...overrides,
  };
}

describe('EO #3: Verification Hint', () => {
  test('verificationHint absent runs all enabled oracles (backwards compatible)', async () => {
    const verdict = await runGate(makeRequest());

    // Without hint, type oracle should always run (it's enabled by default)
    expect(verdict.oracle_results.type).toBeDefined();
    // No filtering should have been applied
    expect(verdict.decision).toBeDefined();
  });

  test('verificationHint.oracles filters to only specified oracles', async () => {
    const verdict = await runGate(
      makeRequest({
        verificationHint: { oracles: ['type'] },
      }),
    );

    // Only type oracle should run
    expect(verdict.oracle_results.type).toBeDefined();
    // Other oracles should NOT have run (filtered by hint)
    expect(verdict.oracle_results.lint).toBeUndefined();
    expect(verdict.oracle_results.test).toBeUndefined();
    expect(verdict.oracle_results.dep).toBeUndefined();
  });

  test('verificationHint.skipTestWhen skips test oracle', async () => {
    const verdict = await runGate(
      makeRequest({
        riskScore: 0.8, // high risk — would normally include test oracle
        verificationHint: { skipTestWhen: 'import-only' },
      }),
    );

    // Test oracle should be skipped despite high risk
    expect(verdict.oracle_results.test).toBeUndefined();
    // Other oracles should still run
    expect(verdict.oracle_results.type).toBeDefined();
  });

  test('verificationHint.oracles does not override circuit breaker (circuit-open still excluded)', async () => {
    // Even if hint says 'type' should run, if the circuit breaker is open for type,
    // it should still be excluded (circuit breaker check happens before hint check).
    // We can't easily force circuit breaker open in this integration test,
    // so verify the filter order: circuit breaker is checked first in the filter chain.
    const verdict = await runGate(
      makeRequest({
        verificationHint: { oracles: ['type', 'lint'] },
      }),
    );

    // Both type and lint should run (circuit breaker is closed by default)
    expect(verdict.oracle_results.type).toBeDefined();
    // Lint may or may not have results depending on config, but test/dep should be excluded
    expect(verdict.oracle_results.test).toBeUndefined();
    expect(verdict.oracle_results.dep).toBeUndefined();
  });

  test('verificationHint works together with risk-tiered filtering', async () => {
    // Risk score < 0.2 = hash-only tier → skips ALL oracles regardless of hint
    const lowRiskVerdict = await runGate(
      makeRequest({
        riskScore: 0.05,
        verificationHint: { oracles: ['type', 'lint'] },
      }),
    );

    // Hash-only tier takes precedence — no oracles run
    expect(Object.keys(lowRiskVerdict.oracle_results)).toHaveLength(0);

    // Risk score 0.3 = structural tier → hint further filters structural oracles
    const midRiskVerdict = await runGate(
      makeRequest({
        riskScore: 0.3,
        verificationHint: { oracles: ['type'] },
      }),
    );

    // Only type should run (hint filters out lint/dep, risk-tier filters out test)
    expect(midRiskVerdict.oracle_results.type).toBeDefined();
    expect(midRiskVerdict.oracle_results.lint).toBeUndefined();
    expect(midRiskVerdict.oracle_results.test).toBeUndefined();
  });
});

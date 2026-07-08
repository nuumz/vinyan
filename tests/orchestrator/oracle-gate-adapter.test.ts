/**
 * OracleGateAdapter — proposed-mutation verification (A1).
 *
 * Locks the load-bearing behavior: deterministic oracles verify the PROPOSED
 * tree (staged copy with mutations applied), not the pre-mutation disk state.
 * Before this, a type-breaking proposal passed verification because tsc ran
 * against the unchanged workspace.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { clearTscCache } from '../../src/oracle/type/type-verifier.ts';
import { OracleGateAdapter } from '../../src/orchestrator/oracle-gate-adapter.ts';

let workspace: string;

beforeAll(() => {
  workspace = join(tmpdir(), `vinyan-gate-adapter-test-${Date.now()}`);
  const fixtureDir = resolve(import.meta.dir, '../benchmark-fixtures/simple-project');
  cpSync(fixtureDir, workspace, { recursive: true });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  clearTscCache();
});

describe('OracleGateAdapter — verify the proposal, not the disk', () => {
  test('proposed mutation with a type error is rejected before commit', async () => {
    const adapter = new OracleGateAdapter(workspace);

    const result = await adapter.verify(
      [{ file: 'broken-proposal.ts', content: 'export const x: number = "not a number";\n' }],
      workspace,
    );

    expect(result.passed).toBe(false);
    expect(result.reason ?? '').toContain('type');
    // The rejected proposal must never have touched the live workspace.
    expect(existsSync(join(workspace, 'broken-proposal.ts'))).toBe(false);
  });

  test('mutation that breaks its callers is rejected (changeset delta)', async () => {
    const adapter = new OracleGateAdapter(workspace);

    // Rename `add` → `plus` in math.ts; utils.ts still imports `add`, so the
    // breakage surfaces in a DIFFERENT file than the mutation target.
    const mutatedMath = readFileSync(join(workspace, 'math.ts'), 'utf-8').replace(
      'export function add(',
      'export function plus(',
    );

    const result = await adapter.verify([{ file: 'math.ts', content: mutatedMath }], workspace);

    expect(result.passed).toBe(false);
    // Live workspace untouched — `add` still exported.
    expect(readFileSync(join(workspace, 'math.ts'), 'utf-8')).toContain('export function add(');
  });

  test('clean mutation passes and staging does not leak into the live workspace', async () => {
    const adapter = new OracleGateAdapter(workspace);

    const result = await adapter.verify(
      [{ file: 'clean-proposal.ts', content: 'export const ok: number = 1;\n' }],
      workspace,
    );

    expect(result.passed).toBe(true);
    expect(existsSync(join(workspace, 'clean-proposal.ts'))).toBe(false);
  });
});

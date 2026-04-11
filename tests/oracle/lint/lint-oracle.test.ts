import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple } from '../../../src/core/types.ts';
import { isAbstention } from '../../../src/core/types.ts';
import { verify } from '../../../src/oracle/lint/lint-verifier.ts';

describe('lint-oracle', () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-lint-oracle-'));
    writeFileSync(join(workspace, 'clean.ts'), 'export const x = 1;\n');
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('returns OracleAbstention when no linter configured', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'clean.ts',
      pattern: 'lint-clean',
      workspace,
    };
    const response = await verify(hypothesis);
    expect(isAbstention(response)).toBe(true);
    if (isAbstention(response)) {
      expect(response.type).toBe('abstained');
      expect(response.reason).toBe('no_linter_configured');
      expect(response.oracleName).toBe('lint');
      expect(response.durationMs).toBeGreaterThanOrEqual(0);
      expect(response.prerequisites).toBeDefined();
    }
  });

  test('returns OracleAbstention when target file not found (no linter)', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'nonexistent.ts',
      pattern: 'lint-clean',
      workspace,
    };
    const response = await verify(hypothesis);
    // Without a linter configured, returns abstention before file check
    expect(isAbstention(response)).toBe(true);
    if (isAbstention(response)) {
      expect(response.reason).toBe('no_linter_configured');
    }
  });

  test('has correct abstention structure', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'clean.ts',
      pattern: 'lint-clean',
      workspace,
    };
    const response = await verify(hypothesis);
    // WP-4: lint returns abstention when no linter is configured (EHD abstention path)
    expect(isAbstention(response)).toBe(true);
    expect(typeof response.durationMs).toBe('number');
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });
});

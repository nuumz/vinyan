import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { HypothesisTuple } from '../../../src/core/types.ts';
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

  test('returns verified=true with note when no linter configured', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'clean.ts',
      pattern: 'lint-clean',
      workspace,
    };
    const verdict = await verify(hypothesis);
    expect(verdict.verified).toBe(true);
    expect(verdict.confidence).toBe(0.5);
    expect(verdict.reason).toContain('No linter configured');
  });

  test('returns verified=true when target file not found (no linter)', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'nonexistent.ts',
      pattern: 'lint-clean',
      workspace,
    };
    const verdict = await verify(hypothesis);
    // Without a linter configured, returns early before file check
    expect(verdict.verified).toBe(true);
    expect(verdict.confidence).toBeLessThan(1.0);
  });

  test('has correct verdict structure', async () => {
    const hypothesis: HypothesisTuple = {
      target: 'clean.ts',
      pattern: 'lint-clean',
      workspace,
    };
    const verdict = await verify(hypothesis);
    // WP-4: lint returns "uncertain" when no linter is configured (A2 compliance)
    expect(['known', 'uncertain']).toContain(verdict.type);
    expect(typeof verdict.durationMs).toBe('number');
    expect(verdict.durationMs).toBeGreaterThan(0);
    expect(Array.isArray(verdict.evidence)).toBe(true);
  });
});

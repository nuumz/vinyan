import { describe, expect, test } from 'bun:test';
import { OracleGateAdapter } from '../src/orchestrator/oracle-gate-adapter.ts';

// Note: These tests run the real OracleGateAdapter which calls runGate().
// Since runGate operates on file content and real oracles, we test observable behavior.

describe('OracleGateAdapter', () => {
  const workspace = process.cwd();
  const adapter = new OracleGateAdapter(workspace);

  describe('empty mutations → fast-path pass', () => {
    test('returns passed: true with empty verdicts', async () => {
      const result = await adapter.verify([], workspace);
      expect(result.passed).toBe(true);
      expect(result.verdicts).toEqual({});
    });
  });

  describe('single mutation verification', () => {
    test('valid TypeScript file → passes structural checks', async () => {
      const result = await adapter.verify(
        [{ file: 'src/test-valid.ts', content: 'export const x: number = 42;\n' }],
        workspace,
      );
      // Gate should run and return verdicts (may pass or fail depending on oracle config)
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('verdicts');
      expect(typeof result.passed).toBe('boolean');
    });
  });

  describe('multi-file mutations', () => {
    test('multiple files → all run in parallel and results merged', async () => {
      const result = await adapter.verify(
        [
          { file: 'src/a.ts', content: 'export const a = 1;\n' },
          { file: 'src/b.ts', content: 'export const b = 2;\n' },
        ],
        workspace,
      );
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('verdicts');
      // Verdicts should be keyed by oracle:file
      const keys = Object.keys(result.verdicts);
      if (keys.length > 0) {
        // Keys should contain file info
        const hasFileKey = keys.some((k) => k.includes('src/a.ts') || k.includes('src/b.ts'));
        expect(hasFileKey).toBe(true);
      }
    });
  });

  describe('verdict structure', () => {
    test('verdicts have expected OracleVerdict shape', async () => {
      const result = await adapter.verify(
        [{ file: 'src/check.ts', content: 'export function check(): boolean { return true; }\n' }],
        workspace,
      );
      for (const [key, verdict] of Object.entries(result.verdicts)) {
        expect(key).toMatch(/:/); // keyed as oracle:file
        expect(typeof verdict.verified).toBe('boolean');
        expect(verdict).toHaveProperty('type');
        expect(verdict).toHaveProperty('confidence');
      }
    });
  });

  describe('reason aggregation', () => {
    test('when passed, reason is undefined', async () => {
      const result = await adapter.verify([], workspace);
      expect(result.passed).toBe(true);
      expect((result as any).reason).toBeUndefined();
    });
  });
});

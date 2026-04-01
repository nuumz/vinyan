import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildVerdict } from '../../src/core/index.ts';
import { afterToolCall, type ToolCallResult } from '../../src/gate/hooks.ts';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('afterToolCall hook', () => {
  let wg: WorldGraph;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-hooks-test-'));
    wg = new WorldGraph();
  });

  afterEach(() => {
    wg.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('stores verified verdicts as facts', async () => {
    const result: ToolCallResult = {
      toolName: 'write_file',
      affectedFiles: ['src/foo.ts'],
    };

    const verdicts = {
      type: buildVerdict({
        verified: true,
        type: 'known',
        confidence: 1.0,
        evidence: [{ file: 'src/foo.ts', line: 1, snippet: 'clean' }],
        fileHashes: { 'src/foo.ts': 'abc123' },
        durationMs: 50,
      }),
      dep: buildVerdict({
        verified: true,
        type: 'known',
        confidence: 0.8,
        evidence: [{ file: 'src/foo.ts', line: 1, snippet: 'deps ok' }],
        fileHashes: { 'src/foo.ts': 'abc123' },
        durationMs: 30,
      }),
    };

    await afterToolCall(result, verdicts, wg, 'test-session');

    const facts = wg.queryFacts('src/foo.ts');
    expect(facts.length).toBe(2);
    expect(facts.some((f) => f.oracleName === 'type')).toBe(true);
    expect(facts.some((f) => f.oracleName === 'dep')).toBe(true);
    expect(facts[0]!.sessionId).toBe('test-session');
  });

  test('skips unverified verdicts', async () => {
    const result: ToolCallResult = {
      toolName: 'write_file',
      affectedFiles: ['src/foo.ts'],
    };

    const verdicts = {
      type: buildVerdict({
        verified: false,
        type: 'known',
        confidence: 1.0,
        evidence: [],
        fileHashes: {},
        reason: 'type errors found',
        durationMs: 50,
      }),
    };

    await afterToolCall(result, verdicts, wg);

    expect(wg.queryFacts('src/foo.ts')).toHaveLength(0);
  });

  test('no-op on error result', async () => {
    const result: ToolCallResult = {
      toolName: 'write_file',
      error: 'file not writable',
      affectedFiles: ['src/foo.ts'],
    };

    const verdicts = {
      type: buildVerdict({
        verified: true,
        type: 'known',
        confidence: 1.0,
        evidence: [],
        fileHashes: {},
        durationMs: 50,
      }),
    };

    await afterToolCall(result, verdicts, wg);

    expect(wg.queryFacts('src/foo.ts')).toHaveLength(0);
  });

  test('no-op with empty affected files', async () => {
    const result: ToolCallResult = {
      toolName: 'write_file',
      affectedFiles: [],
    };

    await afterToolCall(result, {}, wg);
    // Should not throw
  });

  test('refreshes file hashes for affected files', async () => {
    const filePath = join(tempDir, 'test.ts');
    writeFileSync(filePath, 'const x = 1;');

    // Pre-populate a file hash
    const oldHash = wg.computeFileHash(filePath);
    wg.updateFileHash(filePath, oldHash);

    // Simulate file change
    writeFileSync(filePath, 'const x = 2;');

    const result: ToolCallResult = {
      toolName: 'write_file',
      affectedFiles: [filePath],
    };

    await afterToolCall(result, {}, wg);

    const newHash = wg.getFileHash(filePath);
    expect(newHash).toBeDefined();
    expect(newHash).not.toBe(oldHash);
  });

  test('handles non-existent affected files gracefully', async () => {
    const result: ToolCallResult = {
      toolName: 'delete_file',
      affectedFiles: ['/tmp/nonexistent-file-' + Date.now() + '.ts'],
    };

    // Should not throw
    await afterToolCall(result, {}, wg);
  });
});

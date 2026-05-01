/**
 * A4 — Content-Addressed Truth invariant.
 *
 * Facts are bound to file content hashes. When the file's hash changes,
 * dependent facts auto-invalidate at read time via the file-hash join in
 * `world-graph.queryFacts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

let tmp: string;
let wg: WorldGraph;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vinyan-a4-'));
  wg = new WorldGraph(':memory:', { workspaceRoot: tmp });
});

afterEach(() => {
  wg.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('A4 — Content-Addressed Truth', () => {
  test('fact survives while file hash matches', () => {
    const file = 'src/foo.ts';
    writeFileSync(join(tmp, 'src/foo.ts'.replace('src/', '')), '', { flag: 'w' });
    // Write a real file the world graph can hash.
    require('node:fs').mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, file), 'export const x = 1;\n');
    const hash = wg.computeFileHash(file);
    wg.updateFileHash(file, hash);
    wg.storeFact({
      target: file,
      pattern: 'symbol-exists:x',
      evidence: [{ file, line: 1, snippet: 'export const x = 1;' }],
      oracleName: 'ast-test',
      fileHash: hash,
      sourceFile: file,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });
    expect(wg.queryFacts(file).length).toBe(1);
  });

  test('changing file content invalidates dependent facts at read time', () => {
    const file = 'src/foo.ts';
    require('node:fs').mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, file), 'export const x = 1;\n');
    const hash1 = wg.computeFileHash(file);
    wg.updateFileHash(file, hash1);
    wg.storeFact({
      target: file,
      pattern: 'symbol-exists:x',
      evidence: [{ file, line: 1, snippet: 'export const x = 1;' }],
      oracleName: 'ast-test',
      fileHash: hash1,
      sourceFile: file,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });
    expect(wg.queryFacts(file).length).toBe(1);

    // Mutate file → recompute hash → invalidate.
    writeFileSync(join(tmp, file), 'export const x = 2;\n');
    wg.invalidateByFile(file);

    // Old facts (tagged with hash1) no longer match current file hash.
    expect(wg.queryFacts(file).length).toBe(0);
  });
});

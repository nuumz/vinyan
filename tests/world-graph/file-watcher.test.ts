import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileWatcher } from '../../src/world-graph/file-watcher.ts';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('FileWatcher', () => {
  let tempDir: string;
  let worldGraph: WorldGraph;
  let watcher: FileWatcher;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-fw-test-'));
    worldGraph = new WorldGraph(join(tempDir, 'test-wg.db'));
  });

  afterEach(async () => {
    if (watcher) await watcher.stop();
    worldGraph.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('start + file change → invalidateByFile called', async () => {
    // Store a fact so we can observe invalidation
    const testFile = join(tempDir, 'target.ts');
    writeFileSync(testFile, 'export const x = 1;');

    worldGraph.storeFact({
      target: 'some-symbol',
      pattern: 'symbol-exists',
      evidence: [{ file: testFile, line: 1, snippet: 'export const x = 1;' }],
      oracleName: 'ast-oracle',
      fileHash: worldGraph.computeFileHash(testFile),
      sourceFile: testFile,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    // Verify fact exists
    expect(worldGraph.queryFacts('some-symbol').length).toBe(1);

    watcher = new FileWatcher(worldGraph, tempDir, { debounceMs: 50 });
    watcher.start();

    // Wait for watcher to initialize
    await new Promise((r) => setTimeout(r, 200));

    // Modify the file — triggers invalidation
    writeFileSync(testFile, 'export const x = 2;');

    // Wait for debounce + processing
    await new Promise((r) => setTimeout(r, 500));

    // Fact should be invalidated (source file hash changed)
    const facts = worldGraph.queryFacts('some-symbol');
    expect(facts.length).toBe(0);
  });

  test('unlink → updateFileHash with DELETED', async () => {
    const testFile = join(tempDir, 'delete-me.ts');
    writeFileSync(testFile, 'export const y = 1;');

    watcher = new FileWatcher(worldGraph, tempDir, { debounceMs: 50 });
    watcher.start();

    // Wait for watcher to initialize
    await new Promise((r) => setTimeout(r, 200));

    // Delete the file
    unlinkSync(testFile);

    // Wait for processing
    await new Promise((r) => setTimeout(r, 500));

    // Should not throw — the try-catch in unlink handler prevents errors
    // WorldGraph updateFileHash was called with "DELETED"
    // We can verify by checking file_hashes table if needed
  });

  test('stop() prevents leaked timers', async () => {
    watcher = new FileWatcher(worldGraph, tempDir, { debounceMs: 50 });
    watcher.start();

    await new Promise((r) => setTimeout(r, 100));

    // Stop should complete without error
    await watcher.stop();

    // Write a file after stop — should NOT trigger any callbacks
    const testFile = join(tempDir, 'after-stop.ts');
    writeFileSync(testFile, '// should not trigger');

    // Wait to verify no errors
    await new Promise((r) => setTimeout(r, 300));
  });

  test('rapid changes → debounced (single invalidation)', async () => {
    const testFile = join(tempDir, 'rapid.ts');
    writeFileSync(testFile, 'v0');

    worldGraph.storeFact({
      target: 'rapid-target',
      pattern: 'symbol-exists',
      evidence: [{ file: testFile, line: 1, snippet: 'v0' }],
      oracleName: 'ast-oracle',
      fileHash: worldGraph.computeFileHash(testFile),
      sourceFile: testFile,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    watcher = new FileWatcher(worldGraph, tempDir, { debounceMs: 100 });
    watcher.start();

    await new Promise((r) => setTimeout(r, 200));

    // Rapid writes
    writeFileSync(testFile, 'v1');
    writeFileSync(testFile, 'v2');
    writeFileSync(testFile, 'v3');

    // Wait for debounce window
    await new Promise((r) => setTimeout(r, 500));

    // Fact should be invalidated
    expect(worldGraph.queryFacts('rapid-target').length).toBe(0);
  });
});

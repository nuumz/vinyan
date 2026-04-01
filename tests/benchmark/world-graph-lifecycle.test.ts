/**
 * World Graph Lifecycle Test — proves fact invalidation works end-to-end.
 *
 * Success criteria (architecture.md §10):
 * - World Graph fact invalidation works on file change
 *
 * Lifecycle:
 * 1. Create workspace with TypeScript files
 * 2. Run ast-oracle → get verdicts
 * 3. Store verdicts as facts in World Graph
 * 4. Verify facts are queryable
 * 5. Modify a source file (change function signature)
 * 6. Trigger file hash update (simulate chokidar event)
 * 7. Verify old facts are invalidated (deleted by trigger)
 * 8. Re-run ast-oracle → store new facts
 * 9. Verify new facts reflect updated code
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Fact, HypothesisTuple } from '../../src/core/types.ts';
import { verify as verifyAst } from '../../src/oracle/ast/ast-verifier.ts';
import { verify as verifyDep } from '../../src/oracle/dep/dep-analyzer.ts';
import { verify as verifyType } from '../../src/oracle/type/type-verifier.ts';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('World Graph Lifecycle', () => {
  let tempDir: string;
  let graph: WorldGraph;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-lifecycle-'));

    // Create TypeScript workspace
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
        },
        include: ['**/*.ts'],
      }),
    );

    writeFileSync(
      join(tempDir, 'math.ts'),
      `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(x: number, y: number): number {
  return x * y;
}
`,
    );

    writeFileSync(
      join(tempDir, 'utils.ts'),
      `import { add } from "./math.ts";

export function sum(values: number[]): number {
  return values.reduce((acc, v) => add(acc, v), 0);
}
`,
    );

    writeFileSync(
      join(tempDir, 'app.ts'),
      `import { sum } from "./utils.ts";
import { multiply } from "./math.ts";

export function main(): void {
  console.log(sum([1, 2, 3]), multiply(2, 3));
}
`,
    );

    graph = new WorldGraph(); // in-memory
  });

  afterEach(() => {
    graph.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('full lifecycle: create → verify → store → modify → invalidate → re-verify', async () => {
    const mathPath = join(tempDir, 'math.ts');

    // === Step 1-2: Run ast-oracle on workspace ===
    const astVerdict1 = verifyAst({
      target: 'math.ts',
      pattern: 'symbol-exists',
      context: { symbolName: 'add' },
      workspace: tempDir,
    });
    expect(astVerdict1.verified).toBe(true);
    expect(astVerdict1.evidence.length).toBeGreaterThan(0);
    expect(astVerdict1.evidence[0]!.snippet).toContain('add');

    const sigVerdict1 = verifyAst({
      target: 'math.ts',
      pattern: 'function-signature',
      context: { functionName: 'add', paramCount: 2, params: ['a', 'b'] },
      workspace: tempDir,
    });
    expect(sigVerdict1.verified).toBe(true);

    // === Step 3: Store verdicts as facts ===
    const initialHash = graph.computeFileHash(mathPath);

    const fact1: Omit<Fact, 'id'> = {
      target: 'math.ts',
      pattern: 'symbol-exists:add',
      evidence: astVerdict1.evidence,
      oracleName: 'ast-oracle',
      fileHash: initialHash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    };
    const stored1 = graph.storeFact(fact1);
    expect(stored1.id).toBeDefined();

    const fact2: Omit<Fact, 'id'> = {
      target: 'math.ts',
      pattern: 'function-signature:add(a,b)',
      evidence: sigVerdict1.evidence,
      oracleName: 'ast-oracle',
      fileHash: initialHash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    };
    const stored2 = graph.storeFact(fact2);
    expect(stored2.id).toBeDefined();

    // Register file hash in file_hashes table (simulates initial scan)
    graph.updateFileHash(mathPath, initialHash);

    // === Step 4: Verify facts are queryable ===
    const factsBeforeChange = graph.queryFacts('math.ts');
    expect(factsBeforeChange).toHaveLength(2);
    expect(factsBeforeChange.map((f) => f.pattern).sort()).toEqual([
      'function-signature:add(a,b)',
      'symbol-exists:add',
    ]);
    expect(factsBeforeChange[0]!.fileHash).toBe(initialHash);

    // Verify file hash is stored
    expect(graph.getFileHash(mathPath)).toBe(initialHash);

    // === Step 5: Modify source file (change function signature) ===
    writeFileSync(
      mathPath,
      `export function add(a: number, b: number, c: number): number {
  return a + b + c;
}

export function multiply(x: number, y: number): number {
  return x * y;
}
`,
    );

    // === Step 6: Trigger file hash update (simulate chokidar event) ===
    const newHash = graph.computeFileHash(mathPath);
    expect(newHash).not.toBe(initialHash);

    // This triggers the SQLite trigger: invalidate_facts_on_file_change
    graph.updateFileHash(mathPath, newHash);

    // === Step 7: Verify old facts are invalidated ===
    const factsAfterChange = graph.queryFacts('math.ts');
    expect(factsAfterChange).toHaveLength(0);

    // File hash should be updated
    expect(graph.getFileHash(mathPath)).toBe(newHash);

    // === Step 8: Re-run ast-oracle → store new facts ===
    const astVerdict2 = verifyAst({
      target: 'math.ts',
      pattern: 'symbol-exists',
      context: { symbolName: 'add' },
      workspace: tempDir,
    });
    expect(astVerdict2.verified).toBe(true);

    const sigVerdict2 = verifyAst({
      target: 'math.ts',
      pattern: 'function-signature',
      context: { functionName: 'add', paramCount: 3, params: ['a', 'b', 'c'] },
      workspace: tempDir,
    });
    expect(sigVerdict2.verified).toBe(true);

    // Store new facts
    const newFact1: Omit<Fact, 'id'> = {
      target: 'math.ts',
      pattern: 'symbol-exists:add',
      evidence: astVerdict2.evidence,
      oracleName: 'ast-oracle',
      fileHash: newHash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    };
    graph.storeFact(newFact1);

    const newFact2: Omit<Fact, 'id'> = {
      target: 'math.ts',
      pattern: 'function-signature:add(a,b,c)',
      evidence: sigVerdict2.evidence,
      oracleName: 'ast-oracle',
      fileHash: newHash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    };
    graph.storeFact(newFact2);

    // === Step 9: Verify new facts reflect updated code ===
    const finalFacts = graph.queryFacts('math.ts');
    expect(finalFacts).toHaveLength(2);
    expect(finalFacts.map((f) => f.pattern).sort()).toEqual(['function-signature:add(a,b,c)', 'symbol-exists:add']);
    expect(finalFacts[0]!.fileHash).toBe(newHash);
  });

  test('invalidation scope: changing one file only invalidates its facts', async () => {
    const mathPath = join(tempDir, 'math.ts');
    const utilsPath = join(tempDir, 'utils.ts');

    // Store facts for both files
    const mathHash = graph.computeFileHash(mathPath);
    const utilsHash = graph.computeFileHash(utilsPath);

    graph.storeFact({
      target: 'math.ts',
      pattern: 'symbol-exists:add',
      evidence: [{ file: 'math.ts', line: 1, snippet: 'export function add' }],
      oracleName: 'ast-oracle',
      fileHash: mathHash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    graph.storeFact({
      target: 'utils.ts',
      pattern: 'symbol-exists:sum',
      evidence: [{ file: 'utils.ts', line: 3, snippet: 'export function sum' }],
      oracleName: 'ast-oracle',
      fileHash: utilsHash,
      sourceFile: utilsPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    // Register hashes
    graph.updateFileHash(mathPath, mathHash);
    graph.updateFileHash(utilsPath, utilsHash);

    expect(graph.queryFacts('math.ts')).toHaveLength(1);
    expect(graph.queryFacts('utils.ts')).toHaveLength(1);

    // Modify only math.ts
    writeFileSync(
      mathPath,
      `export function add(a: number, b: number, c: number): number {
  return a + b + c;
}

export function multiply(x: number, y: number): number {
  return x * y;
}
`,
    );

    const newMathHash = graph.computeFileHash(mathPath);
    graph.updateFileHash(mathPath, newMathHash);

    // math.ts facts invalidated
    expect(graph.queryFacts('math.ts')).toHaveLength(0);
    // utils.ts facts still intact
    expect(graph.queryFacts('utils.ts')).toHaveLength(1);
  });

  test('multiple facts for same file all invalidated on change', () => {
    const mathPath = join(tempDir, 'math.ts');
    const hash = graph.computeFileHash(mathPath);

    // Store 3 facts for math.ts
    graph.storeFact({
      target: 'math.ts',
      pattern: 'symbol-exists:add',
      evidence: [{ file: 'math.ts', line: 1, snippet: 'add' }],
      oracleName: 'ast-oracle',
      fileHash: hash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    graph.storeFact({
      target: 'math.ts',
      pattern: 'symbol-exists:multiply',
      evidence: [{ file: 'math.ts', line: 5, snippet: 'multiply' }],
      oracleName: 'ast-oracle',
      fileHash: hash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    graph.storeFact({
      target: 'math.ts',
      pattern: 'type-check',
      evidence: [],
      oracleName: 'type-oracle',
      fileHash: hash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    graph.updateFileHash(mathPath, hash);
    expect(graph.queryFacts('math.ts')).toHaveLength(3);

    // Modify file
    writeFileSync(join(tempDir, 'math.ts'), 'export const changed = true;\n');
    const newHash = graph.computeFileHash(mathPath);
    graph.updateFileHash(mathPath, newHash);

    // All 3 facts invalidated
    expect(graph.queryFacts('math.ts')).toHaveLength(0);
  });

  test("re-storing with same content hash doesn't invalidate", () => {
    const mathPath = join(tempDir, 'math.ts');
    const hash = graph.computeFileHash(mathPath);

    graph.storeFact({
      target: 'math.ts',
      pattern: 'symbol-exists:add',
      evidence: [{ file: 'math.ts', line: 1, snippet: 'add' }],
      oracleName: 'ast-oracle',
      fileHash: hash,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    graph.updateFileHash(mathPath, hash);
    expect(graph.queryFacts('math.ts')).toHaveLength(1);

    // "Update" with same hash (file unchanged)
    graph.updateFileHash(mathPath, hash);

    // Fact should still be there
    expect(graph.queryFacts('math.ts')).toHaveLength(1);
  });

  test('type-oracle integration: type error after mutation → new fact reflects error', async () => {
    const mathPath = join(tempDir, 'math.ts');

    // Step 1: type-check passes
    const typeV1 = await verifyType({
      target: 'math.ts',
      pattern: 'type-check',
      workspace: tempDir,
    });
    expect(typeV1.verified).toBe(true);

    const hash1 = graph.computeFileHash(mathPath);
    graph.storeFact({
      target: 'math.ts',
      pattern: 'type-check',
      evidence: typeV1.evidence,
      oracleName: 'type-oracle',
      fileHash: hash1,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 1.0,
    });
    graph.updateFileHash(mathPath, hash1);

    // Step 2: introduce type error — add(a, b) callers still pass 2 args but function needs 3
    writeFileSync(
      mathPath,
      `export function add(a: number, b: number, c: number): number {
  return a + b + c;
}

export function multiply(x: number, y: number): number {
  return x * y;
}
`,
    );

    // Step 3: invalidate
    const hash2 = graph.computeFileHash(mathPath);
    graph.updateFileHash(mathPath, hash2);
    expect(graph.queryFacts('math.ts')).toHaveLength(0);

    // Step 4: re-run type-check — should now fail (utils.ts calls add(acc, v) with 2 args)
    const typeV2 = await verifyType({
      target: '',
      pattern: 'type-check',
      workspace: tempDir,
    });
    expect(typeV2.verified).toBe(false);
    expect(typeV2.evidence.length).toBeGreaterThan(0);

    // Step 5: store new fact reflecting the error state
    graph.storeFact({
      target: 'math.ts',
      pattern: 'type-check',
      evidence: typeV2.evidence,
      oracleName: 'type-oracle',
      fileHash: hash2,
      sourceFile: mathPath,
      verifiedAt: Date.now(),
      confidence: 0.0, // errors → confidence 0
    });

    const finalFacts = graph.queryFacts('math.ts');
    expect(finalFacts).toHaveLength(1);
    expect(finalFacts[0]!.confidence).toBe(0);
  });

  test('dep-oracle integration: blast radius changes after file modification', async () => {
    // Initial blast radius for math.ts
    const depV1 = await verifyDep({
      target: 'math.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    });
    expect(depV1.verified).toBe(true);
    const initialDependents = depV1.evidence.map((e) => e.file).sort();
    // utils.ts and app.ts depend on math.ts
    expect(initialDependents).toEqual(['app.ts', 'utils.ts']);

    // Add a new file that imports math.ts
    writeFileSync(
      join(tempDir, 'newlib.ts'),
      `import { multiply } from "./math.ts";
export const doubled = (n: number) => multiply(n, 2);
`,
    );

    // Re-run dep oracle
    const depV2 = await verifyDep({
      target: 'math.ts',
      pattern: 'dependency-check',
      workspace: tempDir,
    });
    const newDependents = depV2.evidence.map((e) => e.file).sort();
    // Now also newlib.ts
    expect(newDependents).toEqual(['app.ts', 'newlib.ts', 'utils.ts']);
  });
});

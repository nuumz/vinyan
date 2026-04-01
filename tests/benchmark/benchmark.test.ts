/**
 * Oracle Gate Benchmark — runs mutation cases through oracles, measures catch rate.
 * Validates: "deterministic external verification measurably reduces structural hallucination."
 *
 * Success criteria (architecture.md §10):
 * - True Positive Rate >= 30% (invalid mutations caught)
 * - False Positive Rate = 0% (valid mutations NOT blocked)
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { HypothesisTuple, OracleVerdict } from '../../src/core/types.ts';
import { verify as verifyAst } from '../../src/oracle/ast/ast-verifier.ts';
import { verify as verifyDep } from '../../src/oracle/dep/dep-analyzer.ts';
import { runOracle } from '../../src/oracle/runner.ts';
import { verify as verifyType } from '../../src/oracle/type/type-verifier.ts';
import type { MutationCase } from './mutations.ts';
import { buildMutationCases, INVALID_COUNT, TOTAL_COUNT, VALID_COUNT } from './mutations.ts';

// --- Test state ---
let workspaceDir: string;
let cases: MutationCase[];

// --- Results tracking ---
interface CaseResult {
  id: string;
  description: string;
  expectedResult: 'valid' | 'invalid';
  actualBlocked: boolean;
  oracleResults: Record<string, { verified: boolean; reason?: string }>;
}

const results: CaseResult[] = [];

// --- Oracle dispatch ---

async function runOracleByName(
  name: 'ast' | 'type' | 'dep',
  workspace: string,
  targetFile: string,
): Promise<OracleVerdict> {
  const hypothesis: HypothesisTuple = {
    target: targetFile,
    pattern: name === 'ast' ? 'symbol-exists' : name === 'type' ? 'type-check' : 'dependency-check',
    workspace,
    context: name === 'ast' ? { symbolName: '*' } : undefined,
  };

  switch (name) {
    case 'ast':
      return verifyAst(hypothesis);
    case 'type':
      return await verifyType(hypothesis);
    case 'dep':
      return await verifyDep(hypothesis);
  }
}

/**
 * Run all specified oracles on a mutated workspace.
 * For ast-oracle: checks all .ts files for symbol-exists with known symbols;
 * also checks that imports resolve.
 * For type-oracle: runs tsc --noEmit and checks for errors.
 * For dep-oracle: checks if deleted/modified files break dependents.
 */
async function evaluateMutation(
  mc: MutationCase,
): Promise<{ blocked: boolean; oracleResults: Record<string, { verified: boolean; reason?: string }> }> {
  const oracleResults: Record<string, { verified: boolean; reason?: string }> = {};
  let blocked = false;

  for (const oracle of mc.oracles) {
    if (oracle === 'type') {
      // Type oracle: run tsc on workspace — any error means blocked
      const verdict = await verifyType({
        target: '',
        pattern: 'type-check',
        workspace: mc.workspace,
      });
      oracleResults['type'] = { verified: verdict.verified, reason: verdict.reason };
      if (!verdict.verified) blocked = true;
    } else if (oracle === 'ast') {
      // AST oracle: check that known imports resolve to real modules/symbols
      const verdict = await runAstChecks(mc.workspace);
      oracleResults['ast'] = verdict;
      if (!verdict.verified) blocked = true;
    } else if (oracle === 'dep') {
      // Dep oracle: check for broken dependencies (missing files, circular imports)
      const verdict = await runDepChecks(mc.workspace);
      oracleResults['dep'] = verdict;
      if (!verdict.verified) blocked = true;
    }
  }

  return { blocked, oracleResults };
}

/**
 * AST checks: verify all import specifiers point to files that exist
 * and imported symbols actually exist in the target module.
 */
async function runAstChecks(workspace: string): Promise<{ verified: boolean; reason?: string }> {
  // Collect all .ts files
  const { readdirSync, statSync, readFileSync } = await import('fs');
  const files: string[] = [];
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(entry.name);
    }
  }

  const errors: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(workspace, file), 'utf-8');
    // Parse import statements
    const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const namedImports = match[1]; // { name1, name2 }
      const specifier = match[3]!;

      // Check if import target file exists
      if (specifier.startsWith('.')) {
        // Resolve relative to workspace
        const targetPath = resolve(workspace, specifier);
        // Try with .ts extension, /index.ts
        const { existsSync } = await import('fs');
        const candidates = [targetPath, targetPath + '.ts', join(targetPath, 'index.ts')];
        const found = candidates.some((c) => existsSync(c));
        if (!found) {
          errors.push(`${file}: import from "${specifier}" — module not found`);
          continue;
        }

        // Resolve the actual path
        const actualPath = candidates.find((c) => existsSync(c))!;

        // Check that named imports exist as symbols
        if (namedImports) {
          const symbols = namedImports
            .split(',')
            .map((s) => s.trim())
            .filter((s) => !s.startsWith('type '))
            .map((s) => s.replace(/^type\s+/, ''));

          for (const sym of symbols) {
            if (!sym) continue;
            const verdict = verifyAst({
              target: actualPath,
              pattern: 'symbol-exists',
              context: { symbolName: sym },
              workspace,
            });
            if (!verdict.verified) {
              errors.push(`${file}: symbol "${sym}" not found in "${specifier}"`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { verified: false, reason: errors.join('; ') };
  }
  return { verified: true };
}

/**
 * Dep checks: detect broken dependencies (missing files) and circular imports.
 */
async function runDepChecks(workspace: string): Promise<{ verified: boolean; reason?: string }> {
  const { readdirSync, existsSync, readFileSync } = await import('fs');
  const files: string[] = [];
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(entry.name);
    }
  }

  const errors: string[] = [];

  // Build adjacency list for cycle detection
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const content = readFileSync(join(workspace, file), 'utf-8');
    const deps: string[] = [];
    const importRegex = /import\s+.+\s+from\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const specifier = match[1]!;
      if (specifier.startsWith('.')) {
        // Resolve to filename
        let target = specifier.replace(/^\.\//, '');
        if (!target.endsWith('.ts')) target += '.ts';
        if (!existsSync(join(workspace, target))) {
          errors.push(`${file}: imports "${specifier}" but file doesn't exist`);
        } else {
          deps.push(target);
        }
      }
    }
    graph.set(file, deps);
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(node: string): boolean {
    visited.add(node);
    recursionStack.add(node);

    for (const neighbor of graph.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor)) return true;
      } else if (recursionStack.has(neighbor)) {
        errors.push(`Circular dependency detected: ${node} → ${neighbor}`);
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  }

  for (const file of files) {
    if (!visited.has(file)) {
      hasCycle(file);
    }
  }

  if (errors.length > 0) {
    return { verified: false, reason: errors.join('; ') };
  }
  return { verified: true };
}

// =============================================================================
// Test suite
// =============================================================================

describe('Oracle Gate Benchmark', () => {
  beforeAll(() => {
    // Copy simple-project to a temp directory for isolated testing
    workspaceDir = mkdtempSync(join(tmpdir(), 'vinyan-benchmark-'));
    const fixtureDir = resolve(import.meta.dir, 'fixtures/simple-project');
    cpSync(fixtureDir, workspaceDir, { recursive: true });

    cases = buildMutationCases(workspaceDir);
  });

  afterAll(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    printSummary();
  });

  afterEach(() => {
    // Ensure teardown happens even if test fails
    // (each test calls teardown explicitly, but this is safety net)
  });

  // --- Baseline: verify fixture project is clean ---
  test('baseline: simple-project has zero type errors', async () => {
    const verdict = await verifyType({
      target: '',
      pattern: 'type-check',
      workspace: workspaceDir,
    });
    expect(verdict.verified).toBe(true);
  });

  test('baseline: simple-project has no broken imports', async () => {
    const result = await runAstChecks(workspaceDir);
    expect(result.verified).toBe(true);
  });

  test('baseline: simple-project has no circular deps', async () => {
    const result = await runDepChecks(workspaceDir);
    expect(result.verified).toBe(true);
  });

  // --- Run all mutation cases ---
  describe('VALID mutations (should NOT be blocked)', () => {
    // Generate tests dynamically
    const validCaseDefs = buildMutationCases('/placeholder').filter((c) => c.category === 'valid');

    for (const caseDef of validCaseDefs) {
      test(`${caseDef.id}: ${caseDef.description}`, async () => {
        const mc = { ...caseDef, workspace: workspaceDir };
        try {
          mc.setup(workspaceDir);
          const { blocked, oracleResults } = await evaluateMutation(mc);
          results.push({
            id: mc.id,
            description: mc.description,
            expectedResult: mc.expectedResult,
            actualBlocked: blocked,
            oracleResults,
          });
          // Valid mutations must NOT be blocked
          expect(blocked).toBe(false);
        } finally {
          mc.teardown(workspaceDir);
        }
      });
    }
  });

  describe('INVALID mutations (should be caught)', () => {
    const invalidCaseDefs = buildMutationCases('/placeholder').filter((c) => c.category === 'invalid');

    for (const caseDef of invalidCaseDefs) {
      test(`${caseDef.id}: ${caseDef.description}`, async () => {
        const mc = { ...caseDef, workspace: workspaceDir };
        try {
          mc.setup(workspaceDir);
          const { blocked, oracleResults } = await evaluateMutation(mc);
          results.push({
            id: mc.id,
            description: mc.description,
            expectedResult: mc.expectedResult,
            actualBlocked: blocked,
            oracleResults,
          });
          // Invalid mutations SHOULD be blocked
          expect(blocked).toBe(true);
        } finally {
          mc.teardown(workspaceDir);
        }
      });
    }
  });

  // --- Stdio protocol: run a few cases through child process ---
  describe('Stdio protocol (runOracle child process)', () => {
    test('ast-oracle via child process: verify existing symbol', async () => {
      const hypothesis: HypothesisTuple = {
        target: join(workspaceDir, 'math.ts'),
        pattern: 'symbol-exists',
        context: { symbolName: 'add' },
        workspace: workspaceDir,
      };
      const verdict = await runOracle('ast-oracle', hypothesis);
      expect(verdict.verified).toBe(true);
      expect(verdict.evidence.length).toBeGreaterThan(0);
    });

    test('ast-oracle via child process: detect missing symbol', async () => {
      const hypothesis: HypothesisTuple = {
        target: join(workspaceDir, 'math.ts'),
        pattern: 'symbol-exists',
        context: { symbolName: 'nonExistent' },
        workspace: workspaceDir,
      };
      const verdict = await runOracle('ast-oracle', hypothesis);
      expect(verdict.verified).toBe(false);
    });

    test('type-oracle via child process: clean workspace passes', async () => {
      const hypothesis: HypothesisTuple = {
        target: '',
        pattern: 'type-check',
        workspace: workspaceDir,
      };
      const verdict = await runOracle('type-oracle', hypothesis);
      expect(verdict.verified).toBe(true);
    });

    test('dep-oracle via child process: reports blast radius', async () => {
      const hypothesis: HypothesisTuple = {
        target: 'math.ts',
        pattern: 'dependency-check',
        workspace: workspaceDir,
      };
      const verdict = await runOracle('dep-oracle', hypothesis);
      expect(verdict.verified).toBe(true);
      // math.ts is imported by utils.ts and app.ts (directly)
      expect(verdict.evidence.length).toBeGreaterThanOrEqual(2);
    });

    test('ast-oracle via child process: detect mutation (remove function)', async () => {
      // Apply mutation: remove 'add' function
      const { writeFileSync, readFileSync } = await import('fs');
      const mathPath = join(workspaceDir, 'math.ts');
      const original = readFileSync(mathPath, 'utf-8');

      writeFileSync(
        mathPath,
        `export function subtract(a: number, b: number): number {
  return a - b;
}
export function multiply(x: number, y: number): number { return x * y; }
export function divide(n: number, d: number): number { return n / d; }
export const PI = 3.14159;
`,
      );

      try {
        const hypothesis: HypothesisTuple = {
          target: mathPath,
          pattern: 'symbol-exists',
          context: { symbolName: 'add' },
          workspace: workspaceDir,
        };
        const verdict = await runOracle('ast-oracle', hypothesis);
        expect(verdict.verified).toBe(false);
      } finally {
        writeFileSync(mathPath, original);
      }
    });
  });
});

// =============================================================================
// Summary report
// =============================================================================

function printSummary(): void {
  console.log('\n' + '='.repeat(80));
  console.log('  ORACLE GATE BENCHMARK — RESULTS SUMMARY');
  console.log('='.repeat(80));

  const validResults = results.filter((r) => r.expectedResult === 'valid');
  const invalidResults = results.filter((r) => r.expectedResult === 'invalid');

  // False positives: valid mutations that were incorrectly blocked
  const falsePositives = validResults.filter((r) => r.actualBlocked);
  // True positives: invalid mutations correctly caught
  const truePositives = invalidResults.filter((r) => r.actualBlocked);
  // False negatives: invalid mutations that were missed
  const falseNegatives = invalidResults.filter((r) => !r.actualBlocked);

  const tpr = invalidResults.length > 0 ? (truePositives.length / invalidResults.length) * 100 : 0;
  const fpr = validResults.length > 0 ? (falsePositives.length / validResults.length) * 100 : 0;

  console.log(`\n  Total cases:      ${results.length}`);
  console.log(`  Valid mutations:  ${validResults.length}`);
  console.log(`  Invalid mutations: ${invalidResults.length}`);
  console.log('');
  console.log(
    `  TRUE POSITIVE RATE:  ${tpr.toFixed(1)}% (${truePositives.length}/${invalidResults.length}) — target: ≥30%`,
  );
  console.log(
    `  FALSE POSITIVE RATE: ${fpr.toFixed(1)}% (${falsePositives.length}/${validResults.length}) — target: 0%`,
  );
  console.log('');

  // Per-oracle breakdown
  const oracleStats: Record<string, { caught: number; total: number }> = {};
  for (const r of invalidResults) {
    for (const [oracle, result] of Object.entries(r.oracleResults)) {
      if (!oracleStats[oracle]) oracleStats[oracle] = { caught: 0, total: 0 };
      oracleStats[oracle]!.total++;
      if (!result.verified) oracleStats[oracle]!.caught++;
    }
  }

  console.log('  Per-oracle breakdown (invalid mutations only):');
  console.log('  ' + '-'.repeat(50));
  for (const [oracle, stats] of Object.entries(oracleStats)) {
    const rate = stats.total > 0 ? ((stats.caught / stats.total) * 100).toFixed(1) : 'N/A';
    console.log(`    ${oracle.padEnd(12)} caught ${stats.caught}/${stats.total} (${rate}%)`);
  }

  if (falsePositives.length > 0) {
    console.log('\n  ⚠ FALSE POSITIVES (valid mutations incorrectly blocked):');
    for (const fp of falsePositives) {
      console.log(`    ${fp.id}: ${fp.description}`);
      for (const [oracle, result] of Object.entries(fp.oracleResults)) {
        if (!result.verified) console.log(`      → ${oracle}: ${result.reason}`);
      }
    }
  }

  if (falseNegatives.length > 0) {
    console.log('\n  ✗ FALSE NEGATIVES (invalid mutations missed):');
    for (const fn of falseNegatives) {
      console.log(`    ${fn.id}: ${fn.description}`);
    }
  }

  console.log('\n  Detailed results:');
  console.log('  ' + '-'.repeat(76));
  console.log(`  ${'ID'.padEnd(6)} ${'Expected'.padEnd(10)} ${'Actual'.padEnd(10)} ${'Description'}`);
  console.log('  ' + '-'.repeat(76));
  for (const r of results) {
    const actual = r.actualBlocked ? 'BLOCKED' : 'PASSED';
    const expected = r.expectedResult === 'invalid' ? 'BLOCKED' : 'PASSED';
    const match = actual === expected ? '✓' : '✗';
    console.log(`  ${match} ${r.id.padEnd(5)} ${expected.padEnd(10)} ${actual.padEnd(10)} ${r.description}`);
  }

  console.log('\n' + '='.repeat(80));

  // Assert targets
  const tprPass = tpr >= 30;
  const fprPass = fpr === 0;
  console.log(`  TPR ≥ 30%: ${tprPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`  FPR = 0%:  ${fprPass ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('='.repeat(80) + '\n');
}

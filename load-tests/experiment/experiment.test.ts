/**
 * Vinyan Phase 0 — A/B Experiment Runner
 *
 * Tests whether the Oracle Gate measurably reduces structural hallucinations
 * in a simulated agent coding scenario.
 *
 * Protocol:
 *   For each of 50 tasks:
 *     1. Copy fresh workspace to temp dir
 *     2. Apply incorrect mutation → run gate → measure if blocked (WITH gate)
 *     3. Apply correct mutation → run gate → measure if allowed (false positive check)
 *
 * Baseline: without oracle gate, incorrect mutations pass through unchecked (100% pass-through).
 * Target: Oracle gate catches ≥30% of structural hallucinations with 0% false positives.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { type GateRequest, runGate } from '../../src/gate/index.ts';
import { clearGateDeps } from '../../src/gate/gate.ts';
import { clearTscCache } from '../../src/oracle/type/type-verifier.ts';
import { CODING_TASKS, type CodingTask, TASK_COUNT } from './tasks.ts';

// ── Types ───────────────────────────────────────────────────────

interface TaskResult {
  id: string;
  category: string;
  incorrectBlocked: boolean;
  correctAllowed: boolean;
  incorrectReasons: string[];
  correctReasons: string[];
  durationMs: number;
}

interface CategorySummary {
  category: string;
  total: number;
  blocked: number;
  catchRate: string;
  falsePositives: number;
  fpRate: string;
}

interface TaskEvaluation {
  error?: string;
  result?: TaskResult;
}

// ── Test infrastructure ────────────────────────────────────────

const fixtureDir = resolve(import.meta.dir, 'fixtures/workspace');
// The gate records blocking oracle verdicts as circuit-breaker failures.
// Keep concurrency below the breaker threshold so the type oracle is never skipped mid-run.
const DEFAULT_EXPERIMENT_CONCURRENCY = 2;
const MAX_SAFE_EXPERIMENT_CONCURRENCY = 2;
const EXPERIMENT_TIMEOUT_MS = 120_000;
let tempRoot: string;

function getExperimentConcurrency(): number {
  const raw = Bun.env.VINYAN_EXPERIMENT_CONCURRENCY;
  if (!raw) return DEFAULT_EXPERIMENT_CONCURRENCY;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_EXPERIMENT_CONCURRENCY;
  }

  return Math.min(parsed, MAX_SAFE_EXPERIMENT_CONCURRENCY, TASK_COUNT);
}

const EXPERIMENT_CONCURRENCY = getExperimentConcurrency();

beforeAll(() => {
  // Clear any stale gate deps that may have been injected by other test files
  // (e.g. orchestrator factory tests that call setGateDeps with a real SQLite store).
  // Without this, runGate() would try to use the stale oracleAccuracyStore from a
  // now-closed database, causing a disk I/O error.
  clearGateDeps();
  tempRoot = join(tmpdir(), `vinyan-experiment-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function createFreshWorkspace(taskId: string): string {
  const ws = join(tempRoot, taskId);
  cpSync(fixtureDir, ws, { recursive: true });
  return ws;
}

function makeGateRequest(
  workspace: string,
  taskId: string,
  phase: 'correct' | 'incorrect',
  filePath: string,
  content?: string,
): GateRequest {
  return {
    tool: 'write_file',
    params: { file_path: filePath, workspace, content },
    session_id: `experiment-${taskId}-${phase}`,
  };
}

async function evaluateTask(task: CodingTask): Promise<TaskResult> {
  const start = performance.now();

  // Reuse one workspace per task so the second tsc run can benefit from incremental state.
  const workspace = createFreshWorkspace(task.id);

  try {
    const incorrectPath = join(workspace, task.incorrectMutation.file);
    writeFileSync(incorrectPath, task.incorrectMutation.content);
    const incorrectRequest = makeGateRequest(workspace, task.id, 'incorrect', task.incorrectMutation.file);
    const incorrectVerdict = await runGate(incorrectRequest);

    if (task.correctMutation.file !== task.incorrectMutation.file) {
      rmSync(incorrectPath, { force: true });
    }

    // Clear the tsc dedup cache between the incorrect and correct runs.
    // Both runs share the same workspace path, so without this the second runGate
    // call would reuse the cached tsc result from the first run (within the 5s
    // dedup window), causing a false positive when the correct mutation is clean.
    clearTscCache();

    const correctPath = join(workspace, task.correctMutation.file);
    writeFileSync(correctPath, task.correctMutation.content);
    const correctRequest = makeGateRequest(workspace, task.id, 'correct', task.correctMutation.file);
    const correctVerdict = await runGate(correctRequest);

    return {
      id: task.id,
      category: task.errorCategory,
      incorrectBlocked: incorrectVerdict.decision === 'block',
      correctAllowed: correctVerdict.decision === 'allow',
      incorrectReasons: incorrectVerdict.reasons,
      correctReasons: correctVerdict.reasons,
      durationMs: performance.now() - start,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function executeExperiment(): Promise<Map<string, TaskEvaluation>> {
  const evaluations = new Map<string, TaskEvaluation>();
  const pendingTasks = [...CODING_TASKS];
  const workerCount = Math.min(EXPERIMENT_CONCURRENCY, pendingTasks.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const task = pendingTasks.shift();
      if (!task) return;

      try {
        const result = await evaluateTask(task);
        evaluations.set(task.id, { result });
      } catch (error) {
        evaluations.set(task.id, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  await Promise.all(workers);
  return evaluations;
}

let experimentPromise: Promise<Map<string, TaskEvaluation>> | undefined;

function runExperiment(): Promise<Map<string, TaskEvaluation>> {
  experimentPromise ??= executeExperiment();
  return experimentPromise;
}

function getTaskResult(evaluations: Map<string, TaskEvaluation>, taskId: string): TaskResult {
  const evaluation = evaluations.get(taskId);
  if (!evaluation) {
    throw new Error(`Missing experiment result for ${taskId}`);
  }

  if (evaluation.error) {
    throw new Error(`Experiment task ${taskId} failed: ${evaluation.error}`);
  }

  if (!evaluation.result) {
    throw new Error(`Experiment task ${taskId} returned no result`);
  }

  return evaluation.result;
}

// ── Main experiment ────────────────────────────────────────────

describe('Phase 0 A/B Experiment — Oracle Gate Effectiveness', () => {
  test('task count matches expected', () => {
    expect(CODING_TASKS.length).toBe(TASK_COUNT);
    expect(TASK_COUNT).toBe(50);
  });

  // Run all 50 tasks — each as its own test for clear reporting
  for (const task of CODING_TASKS) {
    test(`${task.id}: ${task.description} [${task.errorCategory}]`, async () => {
      const evaluations = await runExperiment();
      const result = getTaskResult(evaluations, task.id);

      // Correct mutations must always be ALLOWED (zero false positives)
      if (!result.correctAllowed) {
        console.warn(
          `  ⚠ FALSE POSITIVE: ${task.id} correct mutation was blocked: ${result.correctReasons.join(', ')}`,
        );
      }
      expect(result.correctAllowed).toBe(true);
    }, EXPERIMENT_TIMEOUT_MS);
  }

  // Summary test — runs last, prints the experiment report
  test('experiment summary — ≥30% catch rate, 0% false positives', async () => {
    const evaluations = await runExperiment();
    const results = CODING_TASKS.map((task) => getTaskResult(evaluations, task.id));

    // Ensure all 50 tasks ran
    expect(results.length).toBe(TASK_COUNT);

    // ── Compute metrics ──
    const totalBlocked = results.filter((r) => r.incorrectBlocked).length;
    const totalFp = results.filter((r) => !r.correctAllowed).length;
    const catchRate = totalBlocked / TASK_COUNT;
    const fpRate = totalFp / TASK_COUNT;
    const baselineCatchRate = 0; // No gate = everything passes through
    const reductionDelta = catchRate - baselineCatchRate;

    // ── Per-category breakdown ──
    const categories = [...new Set(results.map((r) => r.category))];
    const catSummaries: CategorySummary[] = categories.map((cat) => {
      const catResults = results.filter((r) => r.category === cat);
      const blocked = catResults.filter((r) => r.incorrectBlocked).length;
      const fps = catResults.filter((r) => !r.correctAllowed).length;
      return {
        category: cat,
        total: catResults.length,
        blocked,
        catchRate: `${((blocked / catResults.length) * 100).toFixed(0)}%`,
        falsePositives: fps,
        fpRate: `${((fps / catResults.length) * 100).toFixed(0)}%`,
      };
    });

    // ── Per-oracle contribution ──
    const oracleBlocks: Record<string, number> = {};
    for (const r of results) {
      if (r.incorrectBlocked) {
        for (const reason of r.incorrectReasons) {
          const match = reason.match(/Oracle "(\w+)"/);
          if (match) {
            oracleBlocks[match[1]!] = (oracleBlocks[match[1]!] ?? 0) + 1;
          }
        }
      }
    }

    // ── Missed tasks (incorrect mutations that weren't caught) ──
    const missed = results.filter((r) => !r.incorrectBlocked);

    // ── Print report ──
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   VINYAN PHASE 0 — A/B EXPERIMENT RESULTS          ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Total tasks:           ${TASK_COUNT.toString().padStart(4)}                         ║`);
    console.log(
      `║  Incorrect blocked:     ${totalBlocked.toString().padStart(4)} (${(catchRate * 100).toFixed(1)}%)                  ║`,
    );
    console.log(
      `║  False positives:       ${totalFp.toString().padStart(4)} (${(fpRate * 100).toFixed(1)}%)                   ║`,
    );
    console.log(`║  Baseline catch rate:   ${(baselineCatchRate * 100).toFixed(1)}%                        ║`);
    console.log(`║  Gate catch rate:       ${(catchRate * 100).toFixed(1)}%                        ║`);
    console.log(`║  Δ Reduction:           ${(reductionDelta * 100).toFixed(1)}%                        ║`);
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  Per-Category Breakdown                             ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    for (const s of catSummaries) {
      console.log(
        `║  ${s.category.padEnd(22)} ${s.blocked}/${s.total} caught (${s.catchRate.padStart(4)})  FP: ${s.falsePositives}  ║`,
      );
    }
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log('║  Per-Oracle Contribution                            ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    for (const [oracle, count] of Object.entries(oracleBlocks).sort((a, b) => b[1] - a[1])) {
      console.log(`║  ${oracle.padEnd(22)} ${count.toString().padStart(3)} blocks                     ║`);
    }
    if (missed.length > 0 && missed.length <= 15) {
      console.log('╠══════════════════════════════════════════════════════╣');
      console.log('║  Missed (not caught by gate)                        ║');
      console.log('╠══════════════════════════════════════════════════════╣');
      for (const m of missed) {
        console.log(`${`║  ${m.id} [${m.category}]`.padEnd(55)}║`);
      }
    }
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(
      `║  VERDICT: ${reductionDelta >= 0.3 ? '✅ PASS' : '❌ FAIL'} — Gate ${reductionDelta >= 0.3 ? 'meets' : 'does NOT meet'} ≥30% target     ║`,
    );
    console.log(
      `║  FP:      ${totalFp === 0 ? '✅ PASS' : '❌ FAIL'} — ${totalFp === 0 ? 'Zero' : `${totalFp} `} false positives               ║`,
    );
    console.log('╚══════════════════════════════════════════════════════╝');

    // ── Assertions ──
    expect(catchRate).toBeGreaterThanOrEqual(0.3);
    expect(totalFp).toBe(0);
  }, EXPERIMENT_TIMEOUT_MS);
});

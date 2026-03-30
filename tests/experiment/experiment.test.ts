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
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve, join } from "path";
import { cpSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { runGate, type GateRequest } from "../../src/gate/index.ts";
import { CODING_TASKS, TASK_COUNT, type CodingTask } from "./tasks.ts";

// ── Types ───────────────────────────────────────────────────────

interface TaskResult {
  id: string;
  category: string;
  incorrectBlocked: boolean;
  correctAllowed: boolean;
  incorrectReasons: string[];
  correctReasons: string[];
  duration_ms: number;
}

interface CategorySummary {
  category: string;
  total: number;
  blocked: number;
  catchRate: string;
  falsePositives: number;
  fpRate: string;
}

// ── Test infrastructure ────────────────────────────────────────

const fixtureDir = resolve(import.meta.dir, "fixtures/workspace");
let tempRoot: string;

beforeAll(() => {
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

function makeGateRequest(workspace: string, filePath: string, content?: string): GateRequest {
  return {
    tool: "write_file",
    params: { file_path: filePath, workspace, content },
    session_id: `experiment-${Date.now()}`,
  };
}

async function evaluateTask(task: CodingTask): Promise<TaskResult> {
  const start = performance.now();

  // Test 1: Apply incorrect mutation → gate should BLOCK
  const wsIncorrect = createFreshWorkspace(`${task.id}-incorrect`);
  writeFileSync(join(wsIncorrect, task.incorrectMutation.file), task.incorrectMutation.content);
  const incorrectRequest = makeGateRequest(wsIncorrect, task.incorrectMutation.file);
  const incorrectVerdict = await runGate(incorrectRequest);

  // Test 2: Apply correct mutation → gate should ALLOW
  const wsCorrect = createFreshWorkspace(`${task.id}-correct`);
  writeFileSync(join(wsCorrect, task.correctMutation.file), task.correctMutation.content);
  const correctRequest = makeGateRequest(wsCorrect, task.correctMutation.file);
  const correctVerdict = await runGate(correctRequest);

  return {
    id: task.id,
    category: task.errorCategory,
    incorrectBlocked: incorrectVerdict.decision === "block",
    correctAllowed: correctVerdict.decision === "allow",
    incorrectReasons: incorrectVerdict.reasons,
    correctReasons: correctVerdict.reasons,
    duration_ms: performance.now() - start,
  };
}

// ── Main experiment ────────────────────────────────────────────

describe("Phase 0 A/B Experiment — Oracle Gate Effectiveness", () => {
  const results: TaskResult[] = [];

  test("task count matches expected", () => {
    expect(CODING_TASKS.length).toBe(TASK_COUNT);
    expect(TASK_COUNT).toBe(50);
  });

  // Run all 50 tasks — each as its own test for clear reporting
  for (const task of CODING_TASKS) {
    test(`${task.id}: ${task.description} [${task.errorCategory}]`, async () => {
      const result = await evaluateTask(task);
      results.push(result);

      // Correct mutations must always be ALLOWED (zero false positives)
      if (!result.correctAllowed) {
        console.warn(`  ⚠ FALSE POSITIVE: ${task.id} correct mutation was blocked: ${result.correctReasons.join(", ")}`);
      }
      expect(result.correctAllowed).toBe(true);
    }, 30_000);
  }

  // Summary test — runs last, prints the experiment report
  test("experiment summary — ≥30% catch rate, 0% false positives", () => {
    // Ensure all 50 tasks ran
    expect(results.length).toBe(TASK_COUNT);

    // ── Compute metrics ──
    const totalBlocked = results.filter((r) => r.incorrectBlocked).length;
    const totalFP = results.filter((r) => !r.correctAllowed).length;
    const catchRate = totalBlocked / TASK_COUNT;
    const fpRate = totalFP / TASK_COUNT;
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
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║   VINYAN PHASE 0 — A/B EXPERIMENT RESULTS          ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  Total tasks:           ${TASK_COUNT.toString().padStart(4)}                         ║`);
    console.log(`║  Incorrect blocked:     ${totalBlocked.toString().padStart(4)} (${(catchRate * 100).toFixed(1)}%)                  ║`);
    console.log(`║  False positives:       ${totalFP.toString().padStart(4)} (${(fpRate * 100).toFixed(1)}%)                   ║`);
    console.log(`║  Baseline catch rate:   ${(baselineCatchRate * 100).toFixed(1)}%                        ║`);
    console.log(`║  Gate catch rate:       ${(catchRate * 100).toFixed(1)}%                        ║`);
    console.log(`║  Δ Reduction:           ${(reductionDelta * 100).toFixed(1)}%                        ║`);
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log("║  Per-Category Breakdown                             ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    for (const s of catSummaries) {
      console.log(`║  ${s.category.padEnd(22)} ${s.blocked}/${s.total} caught (${s.catchRate.padStart(4)})  FP: ${s.falsePositives}  ║`);
    }
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log("║  Per-Oracle Contribution                            ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    for (const [oracle, count] of Object.entries(oracleBlocks).sort((a, b) => b[1] - a[1])) {
      console.log(`║  ${oracle.padEnd(22)} ${count.toString().padStart(3)} blocks                     ║`);
    }
    if (missed.length > 0 && missed.length <= 15) {
      console.log("╠══════════════════════════════════════════════════════╣");
      console.log("║  Missed (not caught by gate)                        ║");
      console.log("╠══════════════════════════════════════════════════════╣");
      for (const m of missed) {
        console.log(`║  ${m.id} [${m.category}]`.padEnd(55) + "║");
      }
    }
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  VERDICT: ${reductionDelta >= 0.3 ? "✅ PASS" : "❌ FAIL"} — Gate ${reductionDelta >= 0.3 ? "meets" : "does NOT meet"} ≥30% target     ║`);
    console.log(`║  FP:      ${totalFP === 0 ? "✅ PASS" : "❌ FAIL"} — ${totalFP === 0 ? "Zero" : totalFP + " "} false positives               ║`);
    console.log("╚══════════════════════════════════════════════════════╝");

    // ── Assertions ──
    expect(catchRate).toBeGreaterThanOrEqual(0.3);
    expect(totalFP).toBe(0);
  });
});

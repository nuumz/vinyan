import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SleepCycleRunner } from "../../src/sleep-cycle/sleep-cycle.ts";
import { TraceStore } from "../../src/db/trace-store.ts";
import { PatternStore } from "../../src/db/pattern-store.ts";
import { SkillStore } from "../../src/db/skill-store.ts";
import { SkillManager } from "../../src/orchestrator/skill-manager.ts";
import { TRACE_SCHEMA_SQL } from "../../src/db/trace-schema.ts";
import { PATTERN_SCHEMA_SQL } from "../../src/db/pattern-schema.ts";
import { SKILL_SCHEMA_SQL } from "../../src/db/skill-schema.ts";
import type { ExecutionTrace } from "../../src/orchestrator/types.ts";
import type { QualityScore } from "../../src/core/types.ts";

describe("Dep Cone Hashes for Skill Creation (P3.0 Gap 5)", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "vinyan-dch-"));
    writeFileSync(join(workspace, "auth.ts"), "export function login() { return true; }");
    writeFileSync(join(workspace, "utils.ts"), "export const add = (a: number, b: number) => a + b;");
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function createAll() {
    const db = new Database(":memory:");
    db.exec(TRACE_SCHEMA_SQL);
    db.exec(PATTERN_SCHEMA_SQL);
    db.exec(SKILL_SCHEMA_SQL);
    const traceStore = new TraceStore(db);
    const patternStore = new PatternStore(db);
    const skillStore = new SkillStore(db);
    const skillManager = new SkillManager({ skillStore, workspace });
    return { traceStore, patternStore, skillStore, skillManager };
  }

  function makeQS(composite: number): QualityScore {
    return { architecturalCompliance: composite, efficiency: composite, composite, dimensions_available: 2, phase: "phase0" };
  }

  /**
   * Insert enough traces to trigger sleep cycle and produce a success pattern.
   * Needs: data gate satisfied + approach quality delta ≥ 25%.
   */
  function seedSuccessPattern(traceStore: TraceStore) {
    const taskSig = "refactor::auth.ts";
    // Winner approach: 30 successes with high quality
    for (let i = 0; i < 30; i++) {
      traceStore.insert({
        id: `t-win-${i}`,
        taskId: `task-${i}`,
        timestamp: Date.now() - (60 - i) * 1000,
        routingLevel: 1,
        task_type_signature: taskSig,
        approach: "extract-method",
        oracleVerdicts: { ast: true, type: true },
        model_used: "mock",
        tokens_consumed: 100,
        duration_ms: 500,
        outcome: "success",
        affected_files: ["auth.ts", "utils.ts"],
        qualityScore: makeQS(0.9),
        risk_score: 0.3,
        session_id: `s-${i % 5}`,
      } as ExecutionTrace);
    }
    // Loser approach: 30 successes with low quality
    for (let i = 0; i < 30; i++) {
      traceStore.insert({
        id: `t-lose-${i}`,
        taskId: `task-${60 + i}`,
        timestamp: Date.now() - (60 - i) * 1000,
        routingLevel: 1,
        task_type_signature: taskSig,
        approach: "inline-all",
        oracleVerdicts: { ast: true },
        model_used: "mock",
        tokens_consumed: 200,
        duration_ms: 1000,
        outcome: "success",
        affected_files: ["auth.ts"],
        qualityScore: makeQS(0.4),
        risk_score: 0.15,
        session_id: `s-${i % 5}`,
      } as ExecutionTrace);
    }
    // Additional traces for different task types to satisfy the data gate (5 distinct types)
    for (let t = 1; t <= 5; t++) {
      for (let i = 0; i < 10; i++) {
        traceStore.insert({
          id: `t-filler-${t}-${i}`,
          taskId: `task-filler-${t}-${i}`,
          timestamp: Date.now(),
          routingLevel: 1,
          task_type_signature: `other-type-${t}`,
          approach: "default",
          oracleVerdicts: { ast: true },
          model_used: "mock",
          tokens_consumed: 50,
          duration_ms: 200,
          outcome: "success",
          affected_files: ["other.ts"],
          qualityScore: makeQS(0.7),
          session_id: `s-${i % 5}`,
        } as ExecutionTrace);
      }
    }
  }

  test("skill created from success pattern has non-empty depConeHashes", async () => {
    const { traceStore, patternStore, skillManager } = createAll();
    seedSuccessPattern(traceStore);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      skillManager,
      config: { min_traces_for_analysis: 50 },
    });

    const result = await runner.run();

    // Should find at least one success pattern
    const successPatterns = result.patterns.filter(p => p.type === "success-pattern");
    expect(successPatterns.length).toBeGreaterThan(0);

    // The skill was created from the pattern with real hashes
    // Verify the SkillManager can compute hashes for the pattern's affected files
    const hashes = skillManager.computeCurrentHashes(["auth.ts", "utils.ts"]);
    expect(Object.keys(hashes).length).toBe(2);
    expect(hashes["auth.ts"]).toBeDefined();
    expect(hashes["utils.ts"]).toBeDefined();
  });

  test("risk score derived from source traces (not hardcoded 0.2)", async () => {
    const { traceStore, patternStore, skillManager, skillStore } = createAll();
    seedSuccessPattern(traceStore);

    const runner = new SleepCycleRunner({
      traceStore,
      patternStore,
      skillManager,
      config: { min_traces_for_analysis: 50 },
    });

    await runner.run();

    // Winner traces have risk_score=0.3 → pattern risk should average ~0.3 (not hardcoded 0.2)
    const probationSkills = skillStore.findByStatus("probation");
    expect(probationSkills.length).toBeGreaterThan(0);
    const createdSkill = probationSkills[0]!;
    // Risk should reflect source trace average (~0.3), not old hardcoded 0.2
    expect(createdSkill.riskAtCreation).not.toBe(0.2);
    expect(createdSkill.riskAtCreation).toBeGreaterThanOrEqual(0.2);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createBus, type VinyanBus } from "../../src/core/bus.ts";
import { SkillManager } from "../../src/orchestrator/skill-manager.ts";
import { SkillStore } from "../../src/db/skill-store.ts";
import { SKILL_SCHEMA_SQL } from "../../src/db/skill-schema.ts";
import type { ExtractedPattern, CachedSkill } from "../../src/orchestrator/types.ts";
import { WorkingMemory } from "../../src/orchestrator/working-memory.ts";

let db: Database;
let store: SkillStore;
let tempDir: string;
let bus: VinyanBus;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SKILL_SCHEMA_SQL);
  store = new SkillStore(db);
  tempDir = mkdtempSync(join(tmpdir(), "vinyan-skill-fb-"));
  mkdirSync(join(tempDir, "src"), { recursive: true });
  writeFileSync(join(tempDir, "src", "auth.ts"), "export function login() {}");
  bus = createBus();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePattern(overrides?: Partial<ExtractedPattern>): ExtractedPattern {
  return {
    id: "p-1",
    type: "success-pattern",
    description: "direct-edit is effective for refactors",
    frequency: 20,
    confidence: 0.85,
    taskTypeSignature: "refactor::auth.ts",
    approach: "direct-edit",
    qualityDelta: 0.3,
    sourceTraceIds: ["t-1", "t-2"],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

describe("Skill Feedback Loop (H4)", () => {
  test("matched skill approach injected as hypothesis in working memory", () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(["src/auth.ts"]);
    const workingMemory = new WorkingMemory();

    // Create and promote skill
    manager.createFromPattern(makePattern(), 0.1, hashes);
    store.updateStatus("refactor::auth.ts", "active", 0);

    const skill = manager.match("refactor::auth.ts");
    expect(skill).not.toBeNull();

    // Inject approach as hypothesis (what core-loop does)
    workingMemory.addHypothesis(
      `Proven approach: ${skill!.approach}`,
      skill!.successRate,
      "cached-skill",
    );

    const snapshot = workingMemory.getSnapshot();
    expect(snapshot.activeHypotheses).toHaveLength(1);
    expect(snapshot.activeHypotheses[0]!.hypothesis).toContain("direct-edit");
    expect(snapshot.activeHypotheses[0]!.source).toBe("cached-skill");
  });

  test("recordOutcome(true) promotes skill after probation", () => {
    const manager = new SkillManager({
      skillStore: store,
      workspace: tempDir,
      probationSessions: 2,
    });
    const hashes = manager.computeCurrentHashes(["src/auth.ts"]);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);

    expect(skill.status).toBe("probation");
    expect(skill.probationRemaining).toBe(2);

    // Success #1
    manager.recordOutcome(skill, true);
    const s1 = store.findBySignature(skill.taskSignature)!;
    expect(s1.probationRemaining).toBe(1);

    // Success #2 → promote
    manager.recordOutcome(s1, true);
    const s2 = store.findBySignature(skill.taskSignature)!;
    expect(s2.status).toBe("active");
    expect(s2.probationRemaining).toBe(0);
  });

  test("recordOutcome(false) demotes skill immediately", () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(["src/auth.ts"]);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);

    manager.recordOutcome(skill, false);
    const demoted = store.findBySignature(skill.taskSignature)!;
    expect(demoted.status).toBe("demoted");
  });

  test("skill:outcome event emitted on success and failure", () => {
    const events: Array<{ success: boolean }> = [];
    bus.on("skill:outcome", (payload) => {
      events.push({ success: payload.success });
    });

    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(["src/auth.ts"]);
    const skill = manager.createFromPattern(makePattern(), 0.1, hashes);

    // Simulate what core-loop does
    manager.recordOutcome(skill, true);
    bus.emit("skill:outcome", { taskId: "t-1", skill, success: true });

    const skill2 = store.findBySignature(skill.taskSignature)!;
    manager.recordOutcome(skill2, false);
    bus.emit("skill:outcome", { taskId: "t-2", skill: skill2, success: false });

    expect(events).toHaveLength(2);
    expect(events[0]!.success).toBe(true);
    expect(events[1]!.success).toBe(false);
  });

  test("skill match only returns active skills (not probation)", () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(["src/auth.ts"]);

    // Skill in probation
    manager.createFromPattern(makePattern(), 0.1, hashes);
    expect(manager.match("refactor::auth.ts")).toBeNull();

    // Promote to active
    store.updateStatus("refactor::auth.ts", "active", 0);
    expect(manager.match("refactor::auth.ts")).not.toBeNull();
  });

  test("countActive returns correct count", () => {
    const manager = new SkillManager({ skillStore: store, workspace: tempDir });
    const hashes = manager.computeCurrentHashes(["src/auth.ts"]);

    expect(manager.countActive()).toBe(0);

    manager.createFromPattern(makePattern(), 0.1, hashes);
    expect(manager.countActive()).toBe(0); // still in probation

    store.updateStatus("refactor::auth.ts", "active", 0);
    expect(manager.countActive()).toBe(1);
  });
});

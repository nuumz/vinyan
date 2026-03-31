import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillManager } from "../../src/orchestrator/skill-manager.ts";
import { SkillStore } from "../../src/db/skill-store.ts";
import { SKILL_SCHEMA_SQL } from "../../src/db/skill-schema.ts";
import type { CachedSkill } from "../../src/orchestrator/types.ts";

function makeSkill(overrides?: Partial<CachedSkill>): CachedSkill {
  return {
    taskSignature: "refactor::ts::medium",
    approach: "extract-method",
    successRate: 0.9,
    status: "active",
    probationRemaining: 0,
    usageCount: 10,
    riskAtCreation: 0.1,
    depConeHashes: {},
    lastVerifiedAt: Date.now(),
    verificationProfile: "hash-only",
    ...overrides,
  };
}

function setup() {
  const db = new Database(":memory:");
  db.exec(SKILL_SCHEMA_SQL);
  const store = new SkillStore(db);
  const tempDir = mkdtempSync(join(tmpdir(), "vinyan-skill-gen-"));
  const manager = new SkillManager({ skillStore: store, workspace: tempDir });
  return { db, store, manager, tempDir };
}

describe("PH3.4: Cross-Task Skill Generalization", () => {
  test("fuzzy match: same verb + overlapping extension", () => {
    const { store, manager } = setup();
    // Skill for refactor::ts::medium
    store.insert(makeSkill());

    // Query for refactor::ts::small — same verb, same ext, different blast radius
    const result = manager.match("refactor::ts::small");
    expect(result).not.toBeNull();
    expect(result!.taskSignature).toBe("refactor::ts::medium");
    expect(result!.confidence).toBe(0.4);
  });

  test("exact match has no confidence field (undefined)", () => {
    const { store, manager } = setup();
    store.insert(makeSkill());

    // Exact match for the same signature
    const result = manager.match("refactor::ts::medium");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeUndefined();
  });

  test("no fuzzy match when verb differs", () => {
    const { store, manager } = setup();
    store.insert(makeSkill({ taskSignature: "refactor::ts::medium" }));

    // Different verb → no match
    const result = manager.match("bugfix::ts::medium");
    expect(result).toBeNull();
  });

  test("no fuzzy match when extensions don't overlap", () => {
    const { store, manager } = setup();
    store.insert(makeSkill({ taskSignature: "refactor::ts::medium" }));

    // Different extension → no match
    const result = manager.match("refactor::py::medium");
    expect(result).toBeNull();
  });

  test("no fuzzy match when successRate < 0.8", () => {
    const { store, manager } = setup();
    store.insert(makeSkill({ successRate: 0.75 }));

    const result = manager.match("refactor::ts::small");
    expect(result).toBeNull();
  });

  test("picks highest successRate among fuzzy candidates", () => {
    const { store, manager } = setup();
    store.insert(makeSkill({ taskSignature: "refactor::ts::medium", successRate: 0.85 }));
    store.insert(makeSkill({ taskSignature: "refactor::ts::large", successRate: 0.95 }));

    const result = manager.match("refactor::ts::small");
    expect(result).not.toBeNull();
    expect(result!.taskSignature).toBe("refactor::ts::large");
    expect(result!.successRate).toBe(0.95);
    expect(result!.confidence).toBe(0.4);
  });

  test("exact match takes priority over fuzzy match", () => {
    const { store, manager } = setup();
    store.insert(makeSkill({ taskSignature: "refactor::ts::small", successRate: 0.8 }));
    store.insert(makeSkill({ taskSignature: "refactor::ts::medium", successRate: 0.95 }));

    // Exact match exists → should return it without confidence
    const result = manager.match("refactor::ts::small");
    expect(result).not.toBeNull();
    expect(result!.taskSignature).toBe("refactor::ts::small");
    expect(result!.confidence).toBeUndefined();
  });

  test("fuzzy match works with multi-extension signatures", () => {
    const { store, manager } = setup();
    // Skill for ts,tsx
    store.insert(makeSkill({ taskSignature: "refactor::ts,tsx::medium" }));

    // Query has tsx overlap
    const result = manager.match("refactor::tsx::small");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.4);
  });

  test("probation skills are not considered for fuzzy match", () => {
    const { store, manager } = setup();
    // Only a probation skill exists
    store.insert(makeSkill({ status: "probation", probationRemaining: 5 }));

    // findActive() won't return probation skills
    const result = manager.match("refactor::ts::small");
    expect(result).toBeNull();
  });
});

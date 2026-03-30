import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SkillStore } from "../../src/db/skill-store.ts";
import { SKILL_SCHEMA_SQL } from "../../src/db/skill-schema.ts";
import type { CachedSkill } from "../../src/orchestrator/types.ts";

let db: Database;
let store: SkillStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SKILL_SCHEMA_SQL);
  store = new SkillStore(db);
});

function makeSkill(overrides?: Partial<CachedSkill>): CachedSkill {
  return {
    taskSignature: "refactor::auth.ts",
    approach: "direct-edit",
    successRate: 0.85,
    status: "active",
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.15,
    depConeHashes: { "src/auth.ts": "abc123" },
    lastVerifiedAt: Date.now(),
    verificationProfile: "hash-only",
    ...overrides,
  };
}

describe("SkillStore", () => {
  test("insert and find by signature", () => {
    const skill = makeSkill();
    store.insert(skill);

    const found = store.findBySignature("refactor::auth.ts");
    expect(found).not.toBeNull();
    expect(found!.approach).toBe("direct-edit");
    expect(found!.successRate).toBe(0.85);
    expect(found!.depConeHashes).toEqual({ "src/auth.ts": "abc123" });
  });

  test("findActive returns only active skills", () => {
    store.insert(makeSkill({ taskSignature: "s1", status: "active" }));
    store.insert(makeSkill({ taskSignature: "s2", status: "probation" }));
    store.insert(makeSkill({ taskSignature: "s3", status: "demoted" }));

    const active = store.findActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.taskSignature).toBe("s1");
  });

  test("updateStatus changes status and probation remaining", () => {
    store.insert(makeSkill({ taskSignature: "s1", status: "probation", probationRemaining: 5 }));

    store.updateStatus("s1", "probation", 4);
    const found = store.findBySignature("s1");
    expect(found!.probationRemaining).toBe(4);

    store.updateStatus("s1", "active", 0);
    const promoted = store.findBySignature("s1");
    expect(promoted!.status).toBe("active");
  });

  test("incrementUsage increases usage count", () => {
    store.insert(makeSkill({ taskSignature: "s1", usageCount: 3 }));
    store.incrementUsage("s1");

    const found = store.findBySignature("s1");
    expect(found!.usageCount).toBe(4);
  });

  test("demoteStale demotes old skills", () => {
    const old = Date.now() - 100_000;
    store.insert(makeSkill({ taskSignature: "s1", lastVerifiedAt: old, status: "active" }));
    store.insert(makeSkill({ taskSignature: "s2", lastVerifiedAt: Date.now(), status: "active" }));

    const demoted = store.demoteStale(50_000);
    expect(demoted).toBe(1);

    const s1 = store.findBySignature("s1");
    expect(s1!.status).toBe("demoted");

    const s2 = store.findBySignature("s2");
    expect(s2!.status).toBe("active");
  });

  test("countActive returns correct count", () => {
    store.insert(makeSkill({ taskSignature: "s1", status: "active" }));
    store.insert(makeSkill({ taskSignature: "s2", status: "active" }));
    store.insert(makeSkill({ taskSignature: "s3", status: "demoted" }));

    expect(store.countActive()).toBe(2);
    expect(store.count()).toBe(3);
  });

  test("insert with OR REPLACE updates existing skill", () => {
    store.insert(makeSkill({ taskSignature: "s1", successRate: 0.5 }));
    store.insert(makeSkill({ taskSignature: "s1", successRate: 0.9 }));

    const found = store.findBySignature("s1");
    expect(found!.successRate).toBe(0.9);
    expect(store.count()).toBe(1);
  });
});

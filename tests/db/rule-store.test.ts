import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RuleStore } from "../../src/db/rule-store.ts";
import { RULE_SCHEMA_SQL } from "../../src/db/rule-schema.ts";
import type { EvolutionaryRule } from "../../src/orchestrator/types.ts";

let db: Database;
let store: RuleStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(RULE_SCHEMA_SQL);
  store = new RuleStore(db);
});

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: "rule-1",
    source: "sleep-cycle",
    condition: { file_pattern: "*.ts" },
    action: "escalate",
    parameters: { toLevel: 2 },
    status: "active",
    created_at: Date.now(),
    effectiveness: 0.7,
    specificity: 1,
    ...overrides,
  };
}

describe("RuleStore", () => {
  test("insert and find active", () => {
    store.insert(makeRule());
    const active = store.findActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("rule-1");
    expect(active[0]!.condition).toEqual({ file_pattern: "*.ts" });
  });

  test("findMatching filters by context", () => {
    store.insert(makeRule({ id: "r1", condition: { file_pattern: "*.ts" } }));
    store.insert(makeRule({ id: "r2", condition: { file_pattern: "*.py" } }));

    const matched = store.findMatching({ filePattern: "auth.ts" });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.id).toBe("r1");
  });

  test("retire sets status and superseded_by", () => {
    store.insert(makeRule({ id: "r1" }));
    store.retire("r1", "r2");

    const retired = store.findByStatus("retired");
    expect(retired).toHaveLength(1);
    expect(retired[0]!.superseded_by).toBe("r2");
    expect(store.findActive()).toHaveLength(0);
  });

  test("countByStatus returns correct counts", () => {
    store.insert(makeRule({ id: "r1", status: "active" }));
    store.insert(makeRule({ id: "r2", status: "probation" }));
    store.insert(makeRule({ id: "r3", status: "retired" }));

    expect(store.countByStatus("active")).toBe(1);
    expect(store.countByStatus("probation")).toBe(1);
    expect(store.count()).toBe(3);
  });
});

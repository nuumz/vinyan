import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WorldGraph } from "../../src/world-graph/world-graph.ts";
import { runRetention } from "../../src/world-graph/retention.ts";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../../src/world-graph/schema.ts";

describe("World Graph Retention", () => {
  let wg: WorldGraph;

  beforeEach(() => {
    wg = new WorldGraph();
  });

  afterEach(() => {
    wg.close();
  });

  function storeFacts(count: number, options?: { sessionId?: string; age_ms?: number }) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      wg.storeFact({
        target: `file-${i}.ts`,
        pattern: `pattern-${i}`,
        evidence: [{ file: `file-${i}.ts`, line: 1, snippet: `x${i}` }],
        oracle_name: "ast-oracle",
        file_hash: `hash-${i}`,
        source_file: `file-${i}.ts`,
        verified_at: now - (options?.age_ms ?? 0),
        session_id: options?.sessionId,
        confidence: 1.0,
      });
    }
  }

  test("deletes facts older than maxAgeDays", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Store old facts (40 days old) with distinct targets
    for (let i = 0; i < 5; i++) {
      wg.storeFact({
        target: `old-${i}.ts`,
        pattern: `old-pattern-${i}`,
        evidence: [{ file: `old-${i}.ts`, line: 1, snippet: `x${i}` }],
        oracle_name: "ast-oracle",
        file_hash: `old-hash-${i}`,
        source_file: `old-${i}.ts`,
        verified_at: Date.now() - 40 * DAY_MS,
        session_id: "old-session",
        confidence: 1.0,
      });
    }
    // Store recent facts
    storeFacts(3, { sessionId: "new-session" });

    const db = (wg as any).db as Database;
    const before = db.query("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number };
    expect(before.cnt).toBe(8);

    const deleted = runRetention(db, {
      maxAgeDays: 30,
      keepLastSessions: 1, // protect only "new-session"
      maxFactCount: 50_000,
    });

    // Exactly 5 old facts deleted (source counts fact rows, not CASCADE junction rows)
    expect(deleted).toBe(5);
    // Old facts gone
    expect(wg.queryFacts("old-0.ts")).toHaveLength(0);
    expect(wg.queryFacts("old-1.ts")).toHaveLength(0);
    // New facts remain
    expect(wg.queryFacts("file-0.ts")).toHaveLength(1);
  });

  test("protects facts from recent sessions", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    // Old facts in a "protected" session
    storeFacts(3, { age_ms: 40 * DAY_MS, sessionId: "protected-session" });
    // Recent fact in same session to make it "recent"
    wg.storeFact({
      target: "recent.ts",
      pattern: "p",
      evidence: [{ file: "recent.ts", line: 1, snippet: "x" }],
      oracle_name: "ast-oracle",
      file_hash: "h",
      source_file: "recent.ts",
      verified_at: Date.now(),
      session_id: "protected-session",
      confidence: 1.0,
    });

    const db = (wg as any).db as Database;
    const deleted = runRetention(db, {
      maxAgeDays: 30,
      keepLastSessions: 10,
      maxFactCount: 50_000,
    });

    // Old facts in protected session should NOT be deleted
    expect(deleted).toBe(0);
  });

  test("enforces maxFactCount hard cap", () => {
    storeFacts(15, { sessionId: "s1" });

    const db = (wg as any).db as Database;
    const before = db.query("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number };
    expect(before.cnt).toBe(15);

    const deleted = runRetention(db, {
      maxAgeDays: 365, // effectively disabled
      keepLastSessions: 10,
      maxFactCount: 10,
    });

    // Exactly 5 excess facts deleted (15 - 10 = 5)
    expect(deleted).toBe(5);
    const remaining = db.query("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number };
    expect(remaining.cnt).toBe(10);
  });

  test("automatic retention via storeFact interval", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const smallWg = new WorldGraph(":memory:", {
      retentionInterval: 5, // run every 5 stores
      retention: { maxAgeDays: 1, keepLastSessions: 0, maxFactCount: 50_000 },
    });

    // Store 4 old facts (won't trigger retention yet)
    for (let i = 0; i < 4; i++) {
      smallWg.storeFact({
        target: `old-${i}.ts`,
        pattern: "p",
        evidence: [{ file: `old-${i}.ts`, line: 1, snippet: "x" }],
        oracle_name: "ast-oracle",
        file_hash: `h-${i}`,
        source_file: `old-${i}.ts`,
        verified_at: Date.now() - 2 * DAY_MS,
        confidence: 1.0,
      });
    }

    // 5th store triggers retention
    smallWg.storeFact({
      target: "new.ts",
      pattern: "p",
      evidence: [{ file: "new.ts", line: 1, snippet: "x" }],
      oracle_name: "ast-oracle",
      file_hash: "h-new",
      source_file: "new.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    });

    // Old facts should be gone, new one remains
    expect(smallWg.queryFacts("old-0.ts")).toHaveLength(0);
    expect(smallWg.queryFacts("new.ts")).toHaveLength(1);

    smallWg.close();
  });

  test("no-op when nothing to delete", () => {
    storeFacts(3, { sessionId: "s1" });

    const db = (wg as any).db as Database;
    const deleted = runRetention(db, {
      maxAgeDays: 365,
      keepLastSessions: 10,
      maxFactCount: 50_000,
    });

    expect(deleted).toBe(0);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WorldGraph } from "../../src/world-graph/world-graph.ts";
import type { Evidence } from "../../src/core/types.ts";

describe("WorldGraph queryFacts staleness filter (WU4)", () => {
  let wg: WorldGraph;

  const evidence: Evidence[] = [{ file: "src/foo.ts", line: 1, snippet: "export const x = 1;" }];

  const baseFact = {
    target: "src/foo.ts",
    pattern: "symbol-exists",
    evidence,
    oracle_name: "ast-oracle",
    file_hash: "hash-original",
    source_file: "src/foo.ts",
    verified_at: Date.now(),
    session_id: "sess-1",
    confidence: 1.0,
  };

  beforeEach(() => {
    wg = new WorldGraph(); // in-memory DB
  });

  afterEach(() => {
    wg.close();
  });

  test("stale fact is excluded when source file hash changes", () => {
    wg.storeFact(baseFact);

    // Update file hash to a different value — fact is now stale
    wg.updateFileHash("src/foo.ts", "hash-updated");

    const facts = wg.queryFacts("src/foo.ts");
    expect(facts).toHaveLength(0);
  });

  test("fresh fact is included when file hash matches", () => {
    wg.storeFact(baseFact);

    // Update file hash to the SAME value as stored in the fact
    wg.updateFileHash("src/foo.ts", "hash-original");

    const facts = wg.queryFacts("src/foo.ts");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.file_hash).toBe("hash-original");
  });

  test("fact without tracked file hash is preserved (LEFT JOIN behaviour)", () => {
    // Store a fact but do NOT insert any row into file_hashes for this source_file
    const untrackedFact = {
      ...baseFact,
      target: "src/bar.ts",
      source_file: "src/bar.ts",
      file_hash: "hash-bar",
    };
    wg.storeFact(untrackedFact);

    // Verify no entry exists in file_hashes for src/bar.ts
    expect(wg.getFileHash("src/bar.ts")).toBeUndefined();

    const facts = wg.queryFacts("src/bar.ts");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.target).toBe("src/bar.ts");
  });

  test("mix: stale fact excluded, untracked fact preserved", () => {
    // Stale fact for foo
    wg.storeFact(baseFact);
    wg.updateFileHash("src/foo.ts", "hash-different");

    // Untracked fact for bar (no file_hashes entry)
    const barFact = {
      ...baseFact,
      target: "src/bar.ts",
      source_file: "src/bar.ts",
      file_hash: "hash-bar",
    };
    wg.storeFact(barFact);

    expect(wg.queryFacts("src/foo.ts")).toHaveLength(0);
    expect(wg.queryFacts("src/bar.ts")).toHaveLength(1);
  });
});

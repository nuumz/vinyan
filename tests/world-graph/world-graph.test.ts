import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WorldGraph } from "../../src/world-graph/world-graph.ts";
import type { Evidence } from "../../src/core/types.ts";

describe("WorldGraph", () => {
  let wg: WorldGraph;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vinyan-test-"));
    wg = new WorldGraph(); // in-memory DB
  });

  afterEach(() => {
    wg.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("storeFact and queryFacts round-trip", () => {
    const evidence: Evidence[] = [{ file: "src/foo.ts", line: 10, snippet: "function foo() {}" }];

    const stored = wg.storeFact({
      target: "src/foo.ts",
      pattern: "symbol-exists",
      evidence,
      oracle_name: "ast-oracle",
      file_hash: "abc123",
      source_file: "src/foo.ts",
      verified_at: Date.now(),
      session_id: "sess-1",
      confidence: 1.0,
    });

    expect(stored.id).toBeTruthy();

    const facts = wg.queryFacts("src/foo.ts");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.target).toBe("src/foo.ts");
    expect(facts[0]!.pattern).toBe("symbol-exists");
    expect(facts[0]!.evidence).toEqual(evidence);
    expect(facts[0]!.oracle_name).toBe("ast-oracle");
    expect(facts[0]!.confidence).toBe(1.0);
  });

  test("storeFact deduplicates by content hash", () => {
    const evidence: Evidence[] = [{ file: "src/foo.ts", line: 10, snippet: "function foo() {}" }];
    const base = {
      target: "src/foo.ts",
      pattern: "symbol-exists",
      evidence,
      oracle_name: "ast-oracle",
      file_hash: "abc123",
      source_file: "src/foo.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    };

    wg.storeFact(base);
    wg.storeFact(base); // same content → same ID → upsert

    const facts = wg.queryFacts("src/foo.ts");
    expect(facts).toHaveLength(1);
  });

  test("queryFacts returns empty for unknown target", () => {
    const facts = wg.queryFacts("nonexistent.ts");
    expect(facts).toHaveLength(0);
  });

  test("computeFileHash returns SHA-256 of file contents", () => {
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const x = 1;");

    const hash = wg.computeFileHash(filePath);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Same content → same hash
    const hash2 = wg.computeFileHash(filePath);
    expect(hash2).toBe(hash);
  });

  test("updateFileHash and getFileHash", () => {
    wg.updateFileHash("src/foo.ts", "hash-v1");
    expect(wg.getFileHash("src/foo.ts")).toBe("hash-v1");

    wg.updateFileHash("src/foo.ts", "hash-v2");
    expect(wg.getFileHash("src/foo.ts")).toBe("hash-v2");
  });

  test("invalidation: updating file hash deletes facts with old hash", () => {
    // Store a fact with hash "hash-v1"
    wg.updateFileHash("src/foo.ts", "hash-v1");
    wg.storeFact({
      target: "src/foo.ts",
      pattern: "symbol-exists",
      evidence: [{ file: "src/foo.ts", line: 1, snippet: "x" }],
      oracle_name: "ast-oracle",
      file_hash: "hash-v1",
      source_file: "src/foo.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts("src/foo.ts")).toHaveLength(1);

    // File changes → new hash → old facts invalidated
    wg.updateFileHash("src/foo.ts", "hash-v2");
    expect(wg.queryFacts("src/foo.ts")).toHaveLength(0);
  });

  test("invalidateByFile computes hash from actual file", () => {
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const x = 1;");

    const hash = wg.computeFileHash(filePath);
    wg.updateFileHash(filePath, hash);
    wg.storeFact({
      target: filePath,
      pattern: "symbol-exists",
      evidence: [{ file: filePath, line: 1, snippet: "const x = 1;" }],
      oracle_name: "ast-oracle",
      file_hash: hash,
      source_file: filePath,
      verified_at: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts(filePath)).toHaveLength(1);

    // Modify file → invalidateByFile → facts cleared
    writeFileSync(filePath, "const x = 2; // changed");
    wg.invalidateByFile(filePath);

    expect(wg.queryFacts(filePath)).toHaveLength(0);
  });

  test("cross-file cascade: evidence file change invalidates fact", () => {
    // Fact about fileA has evidence from fileB
    wg.updateFileHash("src/fileA.ts", "hashA-v1");
    wg.updateFileHash("src/fileB.ts", "hashB-v1");

    wg.storeFact({
      target: "src/fileA.ts",
      pattern: "import-exists",
      evidence: [
        { file: "src/fileA.ts", line: 1, snippet: "import { b } from './fileB'" },
        { file: "src/fileB.ts", line: 5, snippet: "export function b() {}" },
      ],
      oracle_name: "ast-oracle",
      file_hash: "hashA-v1",
      source_file: "src/fileA.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts("src/fileA.ts")).toHaveLength(1);

    // fileB changes → fact about fileA should be invalidated via junction table
    wg.updateFileHash("src/fileB.ts", "hashB-v2");
    expect(wg.queryFacts("src/fileA.ts")).toHaveLength(0);
  });

  test("cross-file cascade: source_file change handled by original trigger", () => {
    wg.updateFileHash("src/fileA.ts", "hashA-v1");

    wg.storeFact({
      target: "src/fileA.ts",
      pattern: "symbol-exists",
      evidence: [{ file: "src/fileA.ts", line: 1, snippet: "x" }],
      oracle_name: "ast-oracle",
      file_hash: "hashA-v1",
      source_file: "src/fileA.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts("src/fileA.ts")).toHaveLength(1);

    // source_file itself changes — original trigger handles this
    wg.updateFileHash("src/fileA.ts", "hashA-v2");
    expect(wg.queryFacts("src/fileA.ts")).toHaveLength(0);
  });

  test("invalidation is scoped to single file — same hash, different files", () => {
    const sharedHash = "shared-hash-value";
    wg.updateFileHash("/abs/path/fileA.ts", sharedHash);
    wg.updateFileHash("/abs/path/fileB.ts", sharedHash);

    wg.storeFact({
      target: "fileA.ts",
      pattern: "symbol-exists",
      evidence: [{ file: "fileA.ts", line: 1, snippet: "x" }],
      oracle_name: "ast-oracle",
      file_hash: sharedHash,
      source_file: "/abs/path/fileA.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    });

    wg.storeFact({
      target: "fileB.ts",
      pattern: "symbol-exists",
      evidence: [{ file: "fileB.ts", line: 1, snippet: "x" }],
      oracle_name: "ast-oracle",
      file_hash: sharedHash,
      source_file: "/abs/path/fileB.ts",
      verified_at: Date.now(),
      confidence: 1.0,
    });

    expect(wg.queryFacts("fileA.ts")).toHaveLength(1);
    expect(wg.queryFacts("fileB.ts")).toHaveLength(1);

    // Modify fileA → new hash
    wg.updateFileHash("/abs/path/fileA.ts", "new-hash-for-A");

    // fileA facts deleted (source_file matches), fileB facts remain
    expect(wg.queryFacts("fileA.ts")).toHaveLength(0);
    expect(wg.queryFacts("fileB.ts")).toHaveLength(1);
  });
});

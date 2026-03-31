import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { VinyanDB } from "../../src/db/vinyan-db.ts";

describe("VinyanDB checkpoint (WU7a)", () => {
  let tempDir: string;
  let dbPath: string;

  // Each test creates its own temp dir; clean up after each
  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempDb(): VinyanDB {
    tempDir = mkdtempSync(join(tmpdir(), "vinyan-db-test-"));
    dbPath = join(tempDir, "vinyan.db");
    return new VinyanDB(dbPath);
  }

  test("checkpoint() runs without throwing", () => {
    const db = makeTempDb();
    expect(() => db.checkpoint()).not.toThrow();
    db.close();
  });

  test("close() calls checkpoint then closes cleanly", () => {
    const db = makeTempDb();
    // close() internally calls checkpoint() — must not throw
    expect(() => db.close()).not.toThrow();
  });

  test("checkpoint() is idempotent — can be called multiple times", () => {
    const db = makeTempDb();
    expect(() => {
      db.checkpoint();
      db.checkpoint();
      db.checkpoint();
    }).not.toThrow();
    db.close();
  });

  test("DB is functional after checkpoint()", () => {
    const db = makeTempDb();
    db.checkpoint();
    // getDb() should still return a working database handle
    const raw = db.getDb();
    const row = raw.query("SELECT 1 AS val").get() as { val: number };
    expect(row.val).toBe(1);
    db.close();
  });
});

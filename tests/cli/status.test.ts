import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { VinyanDB } from "../../src/db/vinyan-db.ts";
import {
  runStatusCommand,
  runMetricsCommand,
  runRulesCommand,
  runSkillsCommand,
} from "../../src/cli/status.ts";

describe("CLI status commands", () => {
  let tempDir: string;
  let db: VinyanDB;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vinyan-status-test-"));
    // Create the .vinyan directory and DB so commands can open it
    db = new VinyanDB(join(tempDir, ".vinyan", "vinyan.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("runStatusCommand completes without error on empty DB", async () => {
    // Capture console output to verify it runs (no throw)
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await runStatusCommand(tempDir);
    } finally {
      console.log = origLog;
    }
    expect(logs.some(l => l.includes("Vinyan System Status"))).toBe(true);
    expect(logs.some(l => l.includes("Total:"))).toBe(true);
  });

  test("runMetricsCommand outputs valid JSON on empty DB", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await runMetricsCommand(tempDir);
    } finally {
      console.log = origLog;
    }
    // Output should be valid JSON
    const combined = logs.join("\n");
    const parsed = JSON.parse(combined);
    expect(parsed.traces.total).toBe(0);
    expect(parsed.rules.active).toBe(0);
    expect(parsed.skills.active).toBe(0);
  });

  test("runRulesCommand handles empty store", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await runRulesCommand(tempDir);
    } finally {
      console.log = origLog;
    }
    expect(logs.some(l => l.includes("Evolutionary Rules"))).toBe(true);
    expect(logs.some(l => l.includes("No active or probation rules"))).toBe(true);
  });

  test("runSkillsCommand handles empty store", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await runSkillsCommand(tempDir);
    } finally {
      console.log = origLog;
    }
    expect(logs.some(l => l.includes("Cached Skills"))).toBe(true);
    expect(logs.some(l => l.includes("No active or probation skills"))).toBe(true);
  });
});

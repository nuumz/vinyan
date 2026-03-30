/**
 * Analyzer tests — verifies JSONL session log analysis and metric computation.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import {
  analyzeSessionDir,
  analyzeSessionFile,
  formatMetrics,
  type SessionMetrics,
} from "../../src/gate/analyzer.ts";
import type { SessionLogEntry } from "../../src/gate/logger.ts";

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `vinyan-analyzer-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(dir: string, filename: string, entries: SessionLogEntry[]): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

function makeEntry(overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    session_id: "test",
    tool: "write_file",
    file_path: "src/test.ts",
    decision: "allow",
    reasons: [],
    oracle_results: {},
    duration_ms: 100,
    ...overrides,
  };
}

describe("Session Analyzer", () => {
  test("returns empty metrics for non-existent directory", () => {
    const metrics = analyzeSessionDir("/tmp/nonexistent-" + Date.now());
    expect(metrics.totalDecisions).toBe(0);
    expect(metrics.blockRate).toBe(0);
  });

  test("returns empty metrics for empty directory", () => {
    const emptyDir = join(tempDir, "empty-sessions");
    mkdirSync(emptyDir, { recursive: true });
    const metrics = analyzeSessionDir(emptyDir);
    expect(metrics.totalDecisions).toBe(0);
  });

  test("analyzes single session file correctly", () => {
    const sessionDir = join(tempDir, "single-session");
    const entries: SessionLogEntry[] = [
      makeEntry({ decision: "allow", duration_ms: 100 }),
      makeEntry({ decision: "block", reasons: ['Oracle "type" rejected: type error'], duration_ms: 200 }),
      makeEntry({ decision: "allow", duration_ms: 150 }),
    ];
    writeJsonl(sessionDir, "session-1.jsonl", entries);

    const metrics = analyzeSessionDir(sessionDir);
    expect(metrics.totalDecisions).toBe(3);
    expect(metrics.allowCount).toBe(2);
    expect(metrics.blockCount).toBe(1);
    expect(metrics.blockRate).toBeCloseTo(1 / 3);
    expect(metrics.avgDuration_ms).toBeCloseTo(150);
    expect(metrics.oracleBlockCounts["type"]).toBe(1);
  });

  test("aggregates multiple session files", () => {
    const sessionDir = join(tempDir, "multi-session");
    writeJsonl(sessionDir, "session-a.jsonl", [
      makeEntry({ decision: "block", reasons: ['Oracle "type" rejected: error'] }),
    ]);
    writeJsonl(sessionDir, "session-b.jsonl", [
      makeEntry({ decision: "allow" }),
      makeEntry({ decision: "block", reasons: ['Oracle "ast" rejected: missing symbol'] }),
    ]);

    const metrics = analyzeSessionDir(sessionDir);
    expect(metrics.totalDecisions).toBe(3);
    expect(metrics.blockCount).toBe(2);
    expect(metrics.oracleBlockCounts["type"]).toBe(1);
    expect(metrics.oracleBlockCounts["ast"]).toBe(1);
  });

  test("counts guardrail blocks correctly", () => {
    const sessionDir = join(tempDir, "guardrail-session");
    writeJsonl(sessionDir, "session.jsonl", [
      makeEntry({ decision: "block", reasons: ["Prompt injection detected: system-prompt-marker"] }),
      makeEntry({ decision: "block", reasons: ["Bypass attempt detected: skip-oracle"] }),
    ]);

    const metrics = analyzeSessionDir(sessionDir);
    expect(metrics.blockCount).toBe(2);
    expect(metrics.oracleBlockCounts["guardrail:injection"]).toBe(1);
    expect(metrics.oracleBlockCounts["guardrail:bypass"]).toBe(1);
  });

  test("computes per-tool breakdown", () => {
    const sessionDir = join(tempDir, "tool-session");
    writeJsonl(sessionDir, "session.jsonl", [
      makeEntry({ tool: "write_file", decision: "allow" }),
      makeEntry({ tool: "write_file", decision: "block", reasons: ["error"] }),
      makeEntry({ tool: "edit_file", decision: "allow" }),
    ]);

    const metrics = analyzeSessionDir(sessionDir);
    expect(metrics.toolBreakdown["write_file"]).toEqual({ allow: 1, block: 1 });
    expect(metrics.toolBreakdown["edit_file"]).toEqual({ allow: 1, block: 0 });
  });

  test("handles corrupt JSONL lines gracefully", () => {
    const sessionDir = join(tempDir, "corrupt-session");
    mkdirSync(sessionDir, { recursive: true });
    const content = [
      JSON.stringify(makeEntry({ decision: "allow" })),
      "this is not json",
      JSON.stringify(makeEntry({ decision: "block", reasons: ["error"] })),
      "",
    ].join("\n");
    writeFileSync(join(sessionDir, "corrupt.jsonl"), content);

    const metrics = analyzeSessionDir(sessionDir);
    expect(metrics.totalDecisions).toBe(2);
    expect(metrics.allowCount).toBe(1);
    expect(metrics.blockCount).toBe(1);
  });

  test("analyzeSessionFile works on single file", () => {
    const sessionDir = join(tempDir, "file-session");
    const path = writeJsonl(sessionDir, "target.jsonl", [
      makeEntry({ decision: "allow" }),
      makeEntry({ decision: "allow" }),
    ]);

    const metrics = analyzeSessionFile(path);
    expect(metrics.totalDecisions).toBe(2);
    expect(metrics.allowCount).toBe(2);
    expect(metrics.blockRate).toBe(0);
  });
});

describe("formatMetrics", () => {
  test("formats empty metrics", () => {
    const output = formatMetrics({ totalDecisions: 0, allowCount: 0, blockCount: 0, blockRate: 0, avgDuration_ms: 0, oracleBlockCounts: {}, toolBreakdown: {} });
    expect(output).toContain("No session data");
  });

  test("formats non-empty metrics", () => {
    const metrics: SessionMetrics = {
      totalDecisions: 10,
      allowCount: 7,
      blockCount: 3,
      blockRate: 0.3,
      avgDuration_ms: 150,
      oracleBlockCounts: { type: 2, ast: 1 },
      toolBreakdown: { write_file: { allow: 7, block: 3 } },
    };
    const output = formatMetrics(metrics);
    expect(output).toContain("Total decisions:  10");
    expect(output).toContain("Blocked:        3");
    expect(output).toContain("type");
    expect(output).toContain("write_file");
  });
});

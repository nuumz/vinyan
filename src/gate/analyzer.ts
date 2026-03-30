/**
 * Session Analyzer — reads JSONL session logs and computes decision metrics.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import type { SessionLogEntry } from "./logger.ts";

export interface SessionMetrics {
  totalDecisions: number;
  allowCount: number;
  blockCount: number;
  blockRate: number;
  avgDuration_ms: number;
  oracleBlockCounts: Record<string, number>;
  toolBreakdown: Record<string, { allow: number; block: number }>;
}

/**
 * Analyze all JSONL session files in the given directory.
 */
export function analyzeSessionDir(sessionDir: string): SessionMetrics {
  if (!existsSync(sessionDir)) {
    return emptyMetrics();
  }

  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  const entries: SessionLogEntry[] = [];

  for (const file of files) {
    const content = readFileSync(join(sessionDir, file), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as SessionLogEntry);
      } catch {
        // skip corrupt lines
      }
    }
  }

  return computeMetrics(entries);
}

/**
 * Analyze a single JSONL file.
 */
export function analyzeSessionFile(filePath: string): SessionMetrics {
  if (!existsSync(filePath)) {
    return emptyMetrics();
  }

  const content = readFileSync(filePath, "utf-8");
  const entries: SessionLogEntry[] = [];
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SessionLogEntry);
    } catch {
      // skip corrupt lines
    }
  }

  return computeMetrics(entries);
}

function computeMetrics(entries: SessionLogEntry[]): SessionMetrics {
  if (entries.length === 0) return emptyMetrics();

  const allowCount = entries.filter((e) => e.decision === "allow").length;
  const blockCount = entries.filter((e) => e.decision === "block").length;
  const totalDuration = entries.reduce((sum, e) => sum + e.duration_ms, 0);

  // Count oracle blocks from reasons
  const oracleBlockCounts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.decision === "block") {
      for (const reason of entry.reasons) {
        const match = reason.match(/Oracle "(\w+)"/);
        if (match) {
          const name = match[1]!;
          oracleBlockCounts[name] = (oracleBlockCounts[name] ?? 0) + 1;
        }
        if (reason.toLowerCase().includes("injection")) {
          oracleBlockCounts["guardrail:injection"] = (oracleBlockCounts["guardrail:injection"] ?? 0) + 1;
        }
        if (reason.toLowerCase().includes("bypass")) {
          oracleBlockCounts["guardrail:bypass"] = (oracleBlockCounts["guardrail:bypass"] ?? 0) + 1;
        }
      }
    }
  }

  // Per-tool breakdown
  const toolBreakdown: Record<string, { allow: number; block: number }> = {};
  for (const entry of entries) {
    if (!toolBreakdown[entry.tool]) {
      toolBreakdown[entry.tool] = { allow: 0, block: 0 };
    }
    toolBreakdown[entry.tool]![entry.decision]++;
  }

  return {
    totalDecisions: entries.length,
    allowCount,
    blockCount,
    blockRate: blockCount / entries.length,
    avgDuration_ms: totalDuration / entries.length,
    oracleBlockCounts,
    toolBreakdown,
  };
}

function emptyMetrics(): SessionMetrics {
  return {
    totalDecisions: 0,
    allowCount: 0,
    blockCount: 0,
    blockRate: 0,
    avgDuration_ms: 0,
    oracleBlockCounts: {},
    toolBreakdown: {},
  };
}

/**
 * Format metrics as a human-readable string.
 */
export function formatMetrics(metrics: SessionMetrics): string {
  if (metrics.totalDecisions === 0) {
    return "No session data found.";
  }

  const lines: string[] = [
    `Session Analysis`,
    `${"─".repeat(40)}`,
    `Total decisions:  ${metrics.totalDecisions}`,
    `  Allowed:        ${metrics.allowCount} (${((metrics.allowCount / metrics.totalDecisions) * 100).toFixed(1)}%)`,
    `  Blocked:        ${metrics.blockCount} (${(metrics.blockRate * 100).toFixed(1)}%)`,
    `  Avg latency:    ${metrics.avgDuration_ms.toFixed(0)}ms`,
    ``,
    `Block sources:`,
  ];

  for (const [source, count] of Object.entries(metrics.oracleBlockCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${source.padEnd(24)} ${count}`);
  }

  if (Object.keys(metrics.toolBreakdown).length > 0) {
    lines.push(``, `Per-tool breakdown:`);
    for (const [tool, counts] of Object.entries(metrics.toolBreakdown)) {
      lines.push(`  ${tool.padEnd(20)} allow: ${counts.allow}  block: ${counts.block}`);
    }
  }

  return lines.join("\n");
}

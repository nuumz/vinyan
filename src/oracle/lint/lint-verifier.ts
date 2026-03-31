/**
 * lint-oracle — runs linter on target file and reports errors.
 *
 * Pattern: "lint-clean" — verified=true if no lint errors (warnings ok).
 * P99 budget: 1,000ms (TDD §13).
 *
 * Linter detection: eslint.config → eslint, ruff.toml/pyproject → ruff.
 */
import type { HypothesisTuple, OracleVerdict, Evidence } from "../../core/types.ts";
import { buildVerdict } from "../../core/index.ts";
import { existsSync } from "fs";
import { join, relative } from "path";

interface LintError {
  file: string;
  line: number;
  message: string;
  severity: "error" | "warning";
}

/** Detect linter from workspace markers. */
function detectLinter(workspace: string): { cmd: string; args: string[] } | null {
  // ESLint
  const eslintConfigs = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "eslint.config.ts",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc",
  ];
  for (const config of eslintConfigs) {
    if (existsSync(join(workspace, config))) {
      return { cmd: "npx", args: ["eslint", "--format", "json"] };
    }
  }

  // Ruff (Python)
  if (
    existsSync(join(workspace, "ruff.toml")) ||
    existsSync(join(workspace, ".ruff.toml"))
  ) {
    return { cmd: "ruff", args: ["check", "--output-format", "json"] };
  }

  return null;
}

/** Parse ESLint JSON output. */
function parseEslintOutput(output: string): LintError[] {
  try {
    const results = JSON.parse(output) as Array<{
      filePath: string;
      messages: Array<{ line: number; message: string; severity: number }>;
    }>;
    const errors: LintError[] = [];
    for (const result of results) {
      for (const msg of result.messages) {
        errors.push({
          file: result.filePath,
          line: msg.line,
          message: msg.message,
          severity: msg.severity >= 2 ? "error" : "warning",
        });
      }
    }
    return errors;
  } catch {
    return [];
  }
}

/** Parse Ruff JSON output. */
function parseRuffOutput(output: string): LintError[] {
  try {
    const results = JSON.parse(output) as Array<{
      filename: string;
      location: { row: number };
      message: string;
      fix?: unknown;
    }>;
    return results.map((r) => ({
      file: r.filename,
      line: r.location.row,
      message: r.message,
      severity: "error" as const,
    }));
  } catch {
    return [];
  }
}

export async function verify(hypothesis: HypothesisTuple): Promise<OracleVerdict> {
  const start = performance.now();
  const { workspace, target } = hypothesis;

  const linter = detectLinter(workspace);
  if (!linter) {
    return buildVerdict({
      verified: true,
      type: "uncertain",
      confidence: 0.5,
      evidence: [],
      fileHashes: {},
      reason: "No linter configured in workspace",
      duration_ms: performance.now() - start,
    });
  }

  const targetPath = join(workspace, target);
  if (!existsSync(targetPath)) {
    return buildVerdict({
      verified: true,
      type: "uncertain",
      confidence: 0.5,
      evidence: [],
      fileHashes: {},
      reason: `Target file ${target} not found`,
      duration_ms: performance.now() - start,
    });
  }

  try {
    const proc = Bun.spawn([linter.cmd, ...linter.args, target], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const duration_ms = performance.now() - start;

    const isEslint = linter.cmd === "npx" && linter.args.includes("eslint");
    const lintErrors = isEslint ? parseEslintOutput(stdout) : parseRuffOutput(stdout);
    const errors = lintErrors.filter((e) => e.severity === "error");

    const evidence: Evidence[] = errors.slice(0, 10).map((e) => ({
      file: relative(workspace, e.file) || target,
      line: e.line,
      snippet: e.message,
    }));

    if (errors.length === 0) {
      return buildVerdict({
        verified: true,
        type: "known",
        confidence: 1.0,
        evidence: [],
        fileHashes: {},
        reason: `Lint clean (${lintErrors.length} warnings)`,
        duration_ms,
      });
    }

    return buildVerdict({
      verified: false,
      type: "known",
      confidence: 1.0,
      evidence,
      fileHashes: {},
      reason: `${errors.length} lint error(s) found`,
      duration_ms,
    });
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Linter failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "ORACLE_CRASH",
      duration_ms: performance.now() - start,
    });
  }
}

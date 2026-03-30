/**
 * test-oracle — runs affected tests and reports pass/fail.
 *
 * Pattern: "test-pass" — verified=true if tests pass or no test file found.
 * P99 budget: 5,000ms (TDD §13).
 *
 * Runner detection: bun.lock → bun test, vitest.config → vitest, pyproject.toml → pytest.
 */
import type { HypothesisTuple, OracleVerdict, Evidence } from "../../core/types.ts";
import { buildVerdict } from "../../core/index.ts";
import { existsSync } from "fs";
import { join, basename, dirname, relative } from "path";

/** Detect test runner from workspace markers. */
function detectTestRunner(workspace: string): { cmd: string; args: string[] } {
  if (existsSync(join(workspace, "bun.lockb")) || existsSync(join(workspace, "bun.lock"))) {
    return { cmd: "bun", args: ["test"] };
  }
  if (
    existsSync(join(workspace, "vitest.config.ts")) ||
    existsSync(join(workspace, "vitest.config.js"))
  ) {
    return { cmd: "npx", args: ["vitest", "run"] };
  }
  if (existsSync(join(workspace, "pyproject.toml")) || existsSync(join(workspace, "pytest.ini"))) {
    return { cmd: "python", args: ["-m", "pytest"] };
  }
  // Default to bun test
  return { cmd: "bun", args: ["test"] };
}

/** Derive likely test file paths from a source file. */
function deriveTestFiles(target: string, workspace: string): string[] {
  const name = basename(target).replace(/\.(ts|tsx|js|jsx|py)$/, "");
  const dir = dirname(target);
  const candidates = [
    // Colocated: src/foo.test.ts
    join(workspace, dir, `${name}.test.ts`),
    join(workspace, dir, `${name}.test.tsx`),
    join(workspace, dir, `${name}.spec.ts`),
    // Mirror: tests/foo.test.ts
    join(workspace, "tests", dir.replace(/^src\/?/, ""), `${name}.test.ts`),
    join(workspace, "tests", `${name}.test.ts`),
    // Python
    join(workspace, "tests", `test_${name}.py`),
    join(workspace, dir, `test_${name}.py`),
  ];
  return candidates.filter((f) => existsSync(f));
}

export async function verify(hypothesis: HypothesisTuple): Promise<OracleVerdict> {
  const start = performance.now();
  const { workspace, target } = hypothesis;

  // Find test files for the target
  const testFiles = deriveTestFiles(target, workspace);

  if (testFiles.length === 0) {
    return buildVerdict({
      verified: true,
      type: "known",
      confidence: 0.5,
      evidence: [],
      fileHashes: {},
      reason: `No test file found for ${target}`,
      duration_ms: performance.now() - start,
    });
  }

  const runner = detectTestRunner(workspace);
  const relativeTestFiles = testFiles.map((f) => relative(workspace, f));

  try {
    const proc = Bun.spawn([runner.cmd, ...runner.args, ...relativeTestFiles], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const output = stdout + stderr;
    const duration_ms = performance.now() - start;

    const evidence: Evidence[] = relativeTestFiles.map((f) => ({
      file: f,
      line: 0,
      snippet: exitCode === 0 ? "PASS" : output.slice(0, 200),
    }));

    if (exitCode === 0) {
      return buildVerdict({
        verified: true,
        type: "known",
        confidence: 1.0,
        evidence,
        fileHashes: {},
        reason: `All tests passed (${relativeTestFiles.join(", ")})`,
        duration_ms,
      });
    }

    return buildVerdict({
      verified: false,
      type: "known",
      confidence: 1.0,
      evidence,
      fileHashes: {},
      reason: `Tests failed (exit code ${exitCode}): ${output.slice(0, 300)}`,
      duration_ms,
    });
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Test runner failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "ORACLE_CRASH",
      duration_ms: performance.now() - start,
    });
  }
}

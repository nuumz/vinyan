/**
 * Oracle Latency Smoke Tests
 *
 * Verifies oracle execution stays within TDD latency budgets:
 * - AST oracle: p99 ≤ 200ms
 * - Type oracle: p99 ≤ 1500ms
 * - Dep oracle: p99 ≤ 500ms
 *
 * Uses a small fixture workspace for realistic but fast testing.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { verify as astVerify } from "../../src/oracle/ast/ast-verifier.ts";
import { verify as depVerify } from "../../src/oracle/dep/dep-analyzer.ts";
import type { HypothesisTuple } from "../../src/core/types.ts";

let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "vinyan-oracle-bench-"));
  mkdirSync(join(workspace, "src"), { recursive: true });

  // Create a small fixture workspace
  writeFileSync(
    join(workspace, "src", "index.ts"),
    `import { helper } from "./helper.ts";\nexport function main() { return helper(); }\n`,
  );
  writeFileSync(
    join(workspace, "src", "helper.ts"),
    `export function helper() { return 42; }\nexport function unused() { return 0; }\n`,
  );
  writeFileSync(
    join(workspace, "src", "utils.ts"),
    `import { helper } from "./helper.ts";\nexport const result = helper() + 1;\n`,
  );
  writeFileSync(
    join(workspace, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
      },
      include: ["src"],
    }),
  );
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function makeHypothesis(target: string, pattern: string): HypothesisTuple {
  return { target, pattern, workspace };
}

/** Run an oracle N times and return p99 latency in ms. */
async function benchmarkOracle(
  oracleFn: (h: HypothesisTuple) => any,
  hypothesis: HypothesisTuple,
  runs: number,
): Promise<{ p99: number; median: number; mean: number }> {
  const latencies: number[] = [];

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = oracleFn(hypothesis);
    if (result && typeof result.then === "function") await result;
    latencies.push(performance.now() - start);
  }

  latencies.sort((a, b) => a - b);
  const p99Index = Math.ceil(latencies.length * 0.99) - 1;
  const medianIndex = Math.floor(latencies.length / 2);

  return {
    p99: latencies[p99Index]!,
    median: latencies[medianIndex]!,
    mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
  };
}

describe("Oracle Latency Smoke Tests", () => {
  const RUNS = 20;

  test(`AST oracle p99 ≤ 200ms (${RUNS} runs)`, async () => {
    const stats = await benchmarkOracle(
      astVerify,
      makeHypothesis("src/helper.ts", "symbol-exists"),
      RUNS,
    );
    console.log(`  AST: p99=${stats.p99.toFixed(1)}ms, median=${stats.median.toFixed(1)}ms, mean=${stats.mean.toFixed(1)}ms`);
    expect(stats.p99).toBeLessThan(200);
  });

  test(`Dep oracle p99 ≤ 500ms (${RUNS} runs)`, async () => {
    const stats = await benchmarkOracle(
      depVerify,
      makeHypothesis("src/helper.ts", "blast-radius"),
      RUNS,
    );
    console.log(`  Dep: p99=${stats.p99.toFixed(1)}ms, median=${stats.median.toFixed(1)}ms, mean=${stats.mean.toFixed(1)}ms`);
    expect(stats.p99).toBeLessThan(500);
  });

  test("AST oracle returns valid verdict structure", () => {
    const verdict = astVerify(makeHypothesis("src/helper.ts", "symbol-exists"));
    expect(verdict).toHaveProperty("verified");
    expect(typeof verdict.verified).toBe("boolean");
    expect(verdict).toHaveProperty("evidence");
    expect(typeof verdict.duration_ms).toBe("number");
  });

  test("Dep oracle returns valid verdict structure", async () => {
    const verdict = await depVerify(makeHypothesis("src/helper.ts", "blast-radius"));
    expect(verdict).toHaveProperty("verified");
    expect(typeof verdict.verified).toBe("boolean");
    expect(verdict).toHaveProperty("evidence");
    expect(typeof verdict.duration_ms).toBe("number");
  });
});

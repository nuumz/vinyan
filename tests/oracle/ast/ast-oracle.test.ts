import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { verify } from "../../../src/oracle/ast/ast-verifier.ts";
import type { HypothesisTuple } from "../../../src/core/types.ts";

describe("ast-oracle", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vinyan-ast-test-"));
    testFile = join(tempDir, "sample.ts");
    writeFileSync(
      testFile,
      `import { readFileSync } from "fs";
import { join } from "path";

export function greet(name: string, greeting: string): string {
  return \`\${greeting}, \${name}!\`;
}

export class UserService {
  getUser(id: number): string {
    return "user-" + id;
  }
}

export interface Config {
  host: string;
  port: number;
}

export const DEFAULT_PORT = 3000;

export type UserId = string;
`,
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeHypothesis(pattern: string, context?: Record<string, unknown>): HypothesisTuple {
    return { target: testFile, pattern, context, workspace: tempDir };
  }

  // --- symbol-exists ---

  test("symbol-exists: finds function", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "greet" }));
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.line).toBe(4);
    expect(verdict.evidence[0]!.snippet).toContain("function greet");
  });

  test("symbol-exists: finds class", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "UserService" }));
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence[0]!.snippet).toContain("class UserService");
  });

  test("symbol-exists: finds interface", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "Config" }));
    expect(verdict.verified).toBe(true);
  });

  test("symbol-exists: finds const variable", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "DEFAULT_PORT" }));
    expect(verdict.verified).toBe(true);
  });

  test("symbol-exists: finds type alias", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "UserId" }));
    expect(verdict.verified).toBe(true);
  });

  test("symbol-exists: missing symbol returns verified=false", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "nonExistent" }));
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("not found");
  });

  test("symbol-exists: missing symbolName returns error", () => {
    const verdict = verify(makeHypothesis("symbol-exists", {}));
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("symbolName is required");
  });

  // --- function-signature ---

  test("function-signature: correct param count", () => {
    const verdict = verify(
      makeHypothesis("function-signature", { functionName: "greet", paramCount: 2 }),
    );
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(1);
  });

  test("function-signature: wrong param count", () => {
    const verdict = verify(
      makeHypothesis("function-signature", { functionName: "greet", paramCount: 3 }),
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("Expected 3 params, found 2");
  });

  test("function-signature: correct param names", () => {
    const verdict = verify(
      makeHypothesis("function-signature", { functionName: "greet", params: ["name", "greeting"] }),
    );
    expect(verdict.verified).toBe(true);
  });

  test("function-signature: wrong param names", () => {
    const verdict = verify(
      makeHypothesis("function-signature", { functionName: "greet", params: ["user", "msg"] }),
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("Param name mismatch");
  });

  test("function-signature: function not found", () => {
    const verdict = verify(
      makeHypothesis("function-signature", { functionName: "missing", paramCount: 1 }),
    );
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("not found");
  });

  // --- import-exists ---

  test("import-exists: finds import", () => {
    const verdict = verify(makeHypothesis("import-exists", { moduleSpecifier: "fs" }));
    expect(verdict.verified).toBe(true);
    expect(verdict.evidence[0]!.line).toBe(1);
  });

  test("import-exists: finds path import", () => {
    const verdict = verify(makeHypothesis("import-exists", { moduleSpecifier: "path" }));
    expect(verdict.verified).toBe(true);
  });

  test("import-exists: missing import", () => {
    const verdict = verify(makeHypothesis("import-exists", { moduleSpecifier: "zod" }));
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("not found");
  });

  // --- unknown pattern ---

  test("unknown pattern returns error", () => {
    const verdict = verify(makeHypothesis("unknown-pattern"));
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain("Unknown pattern");
  });

  // --- file hashes ---

  test("verdict includes file hash", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "greet" }));
    expect(verdict.fileHashes[testFile]).toMatch(/^[a-f0-9]{64}$/);
  });

  // --- duration ---

  test("verdict includes duration", () => {
    const verdict = verify(makeHypothesis("symbol-exists", { symbolName: "greet" }));
    expect(verdict.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

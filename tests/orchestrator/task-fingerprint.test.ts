import { describe, test, expect } from "bun:test";
import { computeFingerprint, detectFrameworkMarkers, fingerprintKey } from "../../src/orchestrator/task-fingerprint.ts";
import type { TaskInput, PerceptualHierarchy } from "../../src/orchestrator/types.ts";

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: "t1",
    source: "cli",
    goal: "refactor the authentication module",
    targetFiles: ["src/auth/login.ts", "src/auth/session.ts"],
    budget: { maxTokens: 10000, maxDurationMs: 60000, maxRetries: 3 },
    ...overrides,
  };
}

function makePerception(overrides?: Partial<PerceptualHierarchy>): PerceptualHierarchy {
  return {
    taskTarget: { file: "src/auth/login.ts", description: "auth module" },
    dependencyCone: {
      directImporters: ["src/app.ts"],
      directImportees: ["express", "zod", "src/db/user.ts"],
      transitiveBlastRadius: 5,
      ...overrides?.dependencyCone,
    },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: "20", os: "linux", availableTools: [] },
    ...overrides,
  };
}

describe("computeFingerprint", () => {
  test("extracts action verb from goal", () => {
    const fp = computeFingerprint(makeInput({ goal: "fix the broken test suite" }));
    expect(fp.actionVerb).toBe("fix");
  });

  test("extracts refactor action", () => {
    const fp = computeFingerprint(makeInput({ goal: "refactor the auth module" }));
    expect(fp.actionVerb).toBe("refactor");
  });

  test("returns unknown for unrecognized action", () => {
    const fp = computeFingerprint(makeInput({ goal: "do something weird" }));
    expect(fp.actionVerb).toBe("unknown");
  });

  test("extracts file extensions", () => {
    const fp = computeFingerprint(makeInput({
      targetFiles: ["src/app.ts", "src/style.css", "src/page.tsx"],
    }));
    expect(fp.fileExtensions).toEqual([".css", ".ts", ".tsx"]);
  });

  test("handles no target files", () => {
    const fp = computeFingerprint(makeInput({ targetFiles: [] }));
    expect(fp.fileExtensions).toEqual([]);
  });

  test("computes blast radius bucket - single", () => {
    const fp = computeFingerprint(makeInput(), makePerception({
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
    }));
    expect(fp.blastRadiusBucket).toBe("single");
  });

  test("computes blast radius bucket - small", () => {
    const fp = computeFingerprint(makeInput(), makePerception({
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 4 },
    }));
    expect(fp.blastRadiusBucket).toBe("small");
  });

  test("computes blast radius bucket - medium", () => {
    const fp = computeFingerprint(makeInput(), makePerception({
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 15 },
    }));
    expect(fp.blastRadiusBucket).toBe("medium");
  });

  test("computes blast radius bucket - large", () => {
    const fp = computeFingerprint(makeInput(), makePerception({
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 50 },
    }));
    expect(fp.blastRadiusBucket).toBe("large");
  });

  test("defaults to single when no perception", () => {
    const fp = computeFingerprint(makeInput());
    expect(fp.blastRadiusBucket).toBe("single");
  });

  test("detects framework markers from imports (with data gate met)", () => {
    const fp = computeFingerprint(makeInput(), makePerception(), { traceCount: 200 });
    expect(fp.frameworkMarkers).toContain("express");
    expect(fp.frameworkMarkers).toContain("zod");
  });

  test("no framework markers when data gate not met", () => {
    const fp = computeFingerprint(makeInput(), makePerception(), { traceCount: 50 });
    expect(fp.frameworkMarkers).toBeUndefined();
  });

  test("no framework markers when no matching imports", () => {
    const fp = computeFingerprint(makeInput(), makePerception({
      dependencyCone: { directImporters: [], directImportees: ["./utils.ts"], transitiveBlastRadius: 1 },
    }), { traceCount: 200 });
    expect(fp.frameworkMarkers).toBeUndefined();
  });

  test("deterministic for same inputs (A3)", () => {
    const input = makeInput();
    const perception = makePerception();
    const fp1 = computeFingerprint(input, perception);
    const fp2 = computeFingerprint(input, perception);
    expect(fp1).toEqual(fp2);
  });
});

describe("detectFrameworkMarkers", () => {
  test("detects react from imports", () => {
    const perception = makePerception({
      dependencyCone: { directImporters: [], directImportees: ["react", "react-dom"], transitiveBlastRadius: 1 },
    });
    const markers = detectFrameworkMarkers(perception);
    expect(markers).toContain("react");
  });

  test("detects multiple frameworks", () => {
    const perception = makePerception({
      dependencyCone: { directImporters: [], directImportees: ["express", "prisma", "zod"], transitiveBlastRadius: 1 },
    });
    const markers = detectFrameworkMarkers(perception);
    expect(markers).toEqual(["express", "prisma", "zod"]);
  });

  test("returns empty for no framework imports", () => {
    const perception = makePerception({
      dependencyCone: { directImporters: [], directImportees: ["./local.ts"], transitiveBlastRadius: 1 },
    });
    expect(detectFrameworkMarkers(perception)).toEqual([]);
  });
});

describe("fingerprintKey", () => {
  test("serializes fingerprint deterministically", () => {
    const key = fingerprintKey({
      actionVerb: "refactor",
      fileExtensions: [".ts"],
      blastRadiusBucket: "small",
    });
    expect(key).toBe("refactor::.ts::small");
  });

  test("joins multiple extensions", () => {
    const key = fingerprintKey({
      actionVerb: "fix",
      fileExtensions: [".css", ".ts", ".tsx"],
      blastRadiusBucket: "medium",
    });
    expect(key).toBe("fix::.css,.ts,.tsx::medium");
  });
});

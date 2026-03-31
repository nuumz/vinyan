import { describe, test, expect, afterEach } from "bun:test";
import { mapPyrightToVerdict, parsePyrightOutput, type PyrightOutput } from "../../../src/oracle/python/pyright-mapper.ts";
import { registerPythonTypeOracle } from "../../../src/oracle/python/register.ts";
import { getOracleEntry, listOraclesForLanguage, clearDynamicOracles } from "../../../src/oracle/registry.ts";

function makePyrightOutput(overrides: Partial<PyrightOutput> = {}): PyrightOutput {
  return {
    version: "1.1.389",
    generalDiagnostics: [],
    summary: { errorCount: 0, warningCount: 0, informationCount: 0, filesAnalyzed: 5 },
    ...overrides,
  };
}

describe("pyright-mapper", () => {
  test("clean file (0 errors) -> verified=true", () => {
    const output = makePyrightOutput();
    const verdict = mapPyrightToVerdict(output, 100);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe("known");
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(0);
    expect(verdict.reason).toBeUndefined();
    expect(verdict.errorCode).toBeUndefined();
    expect(verdict.duration_ms).toBe(100);
  });

  test("single error -> verified=false with evidence", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "src/main.py",
          severity: "error",
          message: 'Argument of type "str" cannot be assigned to parameter "x" of type "int"',
          range: { start: { line: 10, character: 4 }, end: { line: 10, character: 20 } },
          rule: "reportArgumentType",
        },
      ],
      summary: { errorCount: 1, warningCount: 0, informationCount: 0, filesAnalyzed: 3 },
    });
    const verdict = mapPyrightToVerdict(output, 250);

    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe("known");
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe("src/main.py");
    expect(verdict.evidence[0]!.line).toBe(11); // 0-based -> 1-based
    expect(verdict.evidence[0]!.snippet).toContain("reportArgumentType");
    expect(verdict.evidence[0]!.snippet).toContain("cannot be assigned");
    expect(verdict.reason).toContain("1 type error(s)");
    expect(verdict.errorCode).toBe("TYPE_MISMATCH");
  });

  test("multiple errors -> evidence array matches all errors", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "src/a.py",
          severity: "error",
          message: "Missing return statement",
          range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
        },
        {
          file: "src/b.py",
          severity: "error",
          message: 'Type "None" is not assignable to type "int"',
          range: { start: { line: 20, character: 8 }, end: { line: 20, character: 15 } },
          rule: "reportReturnType",
        },
        {
          file: "src/a.py",
          severity: "warning",
          message: "Variable is unused",
          range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
        },
      ],
      summary: { errorCount: 2, warningCount: 1, informationCount: 0, filesAnalyzed: 2 },
    });
    const verdict = mapPyrightToVerdict(output, 500);

    expect(verdict.verified).toBe(false);
    // Only errors become evidence, not warnings
    expect(verdict.evidence).toHaveLength(2);
    expect(verdict.evidence[0]!.file).toBe("src/a.py");
    expect(verdict.evidence[0]!.snippet).toBe("Missing return statement"); // no rule -> no prefix
    expect(verdict.evidence[1]!.file).toBe("src/b.py");
    expect(verdict.evidence[1]!.snippet).toContain("[reportReturnType]");
    expect(verdict.reason).toContain("2 type error(s)");
  });

  test("warnings only -> verified=true", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "src/main.py",
          severity: "warning",
          message: "Import is unused",
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
        },
        {
          file: "src/main.py",
          severity: "information",
          message: "Type could be narrowed",
          range: { start: { line: 5, character: 0 }, end: { line: 5, character: 8 } },
        },
      ],
      summary: { errorCount: 0, warningCount: 1, informationCount: 1, filesAnalyzed: 1 },
    });
    const verdict = mapPyrightToVerdict(output, 80);

    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(0);
    expect(verdict.reason).toBeUndefined();
  });

  test("empty generalDiagnostics -> verified=true", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [],
      summary: { errorCount: 0, warningCount: 0, informationCount: 0, filesAnalyzed: 0 },
    });
    const verdict = mapPyrightToVerdict(output, 50);

    expect(verdict.verified).toBe(true);
    expect(verdict.evidence).toHaveLength(0);
  });

  test("evidence format: line is 1-based from 0-based pyright range", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "test.py",
          severity: "error",
          message: "err",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      ],
      summary: { errorCount: 1, warningCount: 0, informationCount: 0, filesAnalyzed: 1 },
    });
    const verdict = mapPyrightToVerdict(output, 10);

    expect(verdict.evidence[0]!.line).toBe(1); // 0-based -> 1-based
  });

  test("evidence snippet includes rule prefix when rule is present", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "x.py",
          severity: "error",
          message: "Something wrong",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          rule: "reportGeneralClassIssues",
        },
      ],
      summary: { errorCount: 1, warningCount: 0, informationCount: 0, filesAnalyzed: 1 },
    });
    const verdict = mapPyrightToVerdict(output, 10);

    expect(verdict.evidence[0]!.snippet).toBe("[reportGeneralClassIssues] Something wrong");
  });

  test("evidence snippet has no prefix when rule is absent", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "x.py",
          severity: "error",
          message: "Something wrong",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
      summary: { errorCount: 1, warningCount: 0, informationCount: 0, filesAnalyzed: 1 },
    });
    const verdict = mapPyrightToVerdict(output, 10);

    expect(verdict.evidence[0]!.snippet).toBe("Something wrong");
  });

  test("summary statistics appear in reason", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "x.py",
          severity: "error",
          message: "err",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
      summary: { errorCount: 1, warningCount: 2, informationCount: 3, filesAnalyzed: 10 },
    });
    const verdict = mapPyrightToVerdict(output, 200);

    expect(verdict.reason).toContain("pyright 1.1.389");
    expect(verdict.reason).toContain("10 files analyzed");
  });

  test("fileHashes is always empty (no file hash for type checks)", () => {
    const output = makePyrightOutput({
      generalDiagnostics: [
        {
          file: "x.py",
          severity: "error",
          message: "err",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
      summary: { errorCount: 1, warningCount: 0, informationCount: 0, filesAnalyzed: 1 },
    });
    const verdict = mapPyrightToVerdict(output, 10);

    expect(verdict.fileHashes).toEqual({});
  });
});

describe("parsePyrightOutput", () => {
  test("valid JSON -> maps correctly", () => {
    const raw = JSON.stringify(makePyrightOutput());
    const verdict = parsePyrightOutput(raw, 100);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe("known");
    expect(verdict.confidence).toBe(1.0);
  });

  test("malformed JSON structure -> error verdict", () => {
    const raw = JSON.stringify({ not: "pyright output" });
    const verdict = parsePyrightOutput(raw, 50);

    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe("unknown");
    expect(verdict.confidence).toBe(0);
    expect(verdict.errorCode).toBe("PARSE_ERROR");
    expect(verdict.reason).toContain("Failed to parse pyright output");
  });

  test("completely invalid JSON -> throws", () => {
    expect(() => parsePyrightOutput("not json at all", 50)).toThrow();
  });
});

describe("registerPythonTypeOracle", () => {
  afterEach(() => {
    clearDynamicOracles();
  });

  test("registers python-type oracle in dynamic registry", () => {
    registerPythonTypeOracle();

    const entry = getOracleEntry("python-type");
    expect(entry).toBeDefined();
    expect(entry!.languages).toEqual(["python"]);
    expect(entry!.tier).toBe("deterministic");
    expect(entry!.command).toContain("src/oracle/python/index.ts");
  });

  test("python-type appears in language listing for python", () => {
    registerPythonTypeOracle();

    const pythonOracles = listOraclesForLanguage("python");
    expect(pythonOracles).toContain("python-type");
  });
});

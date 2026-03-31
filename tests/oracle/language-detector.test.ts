/**
 * Language Detector Tests — PH5.10
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { detectLanguages } from "../../src/oracle/language-detector.ts";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DIR = join(tmpdir(), `vinyan-lang-detect-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("detectLanguages", () => {
  test("detects TypeScript from package.json", () => {
    writeFileSync(join(TEST_DIR, "package.json"), "{}");

    const langs = detectLanguages(TEST_DIR);
    expect(langs).toEqual([{ language: "typescript", marker: "package.json" }]);
  });

  test("detects Python from pyproject.toml", () => {
    writeFileSync(join(TEST_DIR, "pyproject.toml"), "");

    const langs = detectLanguages(TEST_DIR);
    expect(langs).toEqual([{ language: "python", marker: "pyproject.toml" }]);
  });

  test("detects Go from go.mod", () => {
    writeFileSync(join(TEST_DIR, "go.mod"), "module test");

    const langs = detectLanguages(TEST_DIR);
    expect(langs).toEqual([{ language: "go", marker: "go.mod" }]);
  });

  test("detects Rust from Cargo.toml", () => {
    writeFileSync(join(TEST_DIR, "Cargo.toml"), "[package]");

    const langs = detectLanguages(TEST_DIR);
    expect(langs).toEqual([{ language: "rust", marker: "Cargo.toml" }]);
  });

  test("detects multiple languages", () => {
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    writeFileSync(join(TEST_DIR, "pyproject.toml"), "");
    writeFileSync(join(TEST_DIR, "go.mod"), "module test");

    const langs = detectLanguages(TEST_DIR);
    const langNames = langs.map((l) => l.language);
    expect(langNames).toContain("typescript");
    expect(langNames).toContain("python");
    expect(langNames).toContain("go");
  });

  test("deduplicates same language from multiple markers", () => {
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    writeFileSync(join(TEST_DIR, "tsconfig.json"), "{}");

    const langs = detectLanguages(TEST_DIR);
    // Should deduplicate — only one "typescript" entry
    const tsLangs = langs.filter((l) => l.language === "typescript");
    expect(tsLangs.length).toBe(1);
    expect(tsLangs[0]!.marker).toBe("package.json"); // first match wins
  });

  test("empty directory returns no languages", () => {
    const langs = detectLanguages(TEST_DIR);
    expect(langs).toEqual([]);
  });
});

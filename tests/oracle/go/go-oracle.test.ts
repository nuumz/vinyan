/**
 * Go oracle tests — PH5.12.
 *
 * Tests the Go compiler/vet output mapper and registration.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseGoBuildOutput,
  parseGoModTidyOutput,
  parseGoVetOutput,
} from '../../../src/oracle/go/go-output-mapper.ts';
import { registerGoOracle } from '../../../src/oracle/go/register.ts';
import { clearDynamicOracles, getOracleEntry, listOraclesForLanguage } from '../../../src/oracle/registry.ts';

afterEach(() => {
  clearDynamicOracles();
});

describe('go-output-mapper — parseGoBuildOutput', () => {
  test('clean build (exit 0) -> verified=true', () => {
    const verdict = parseGoBuildOutput('', 0, 150);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(0);
    expect(verdict.durationMs).toBe(150);
  });

  test('single type error -> verified=false with evidence', () => {
    const stderr = `./main.go:15:22: cannot use "hello" (untyped string constant) as int value in argument to Add`;
    const verdict = parseGoBuildOutput(stderr, 2, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe('./main.go');
    expect(verdict.evidence[0]!.line).toBe(15);
    expect(verdict.evidence[0]!.snippet).toContain('cannot use');
    expect(verdict.errorCode).toBe('TYPE_MISMATCH');
  });

  test('multiple errors -> all captured in evidence', () => {
    const stderr = [
      './pkg/api/handler.go:42:10: undefined: Config',
      './pkg/api/handler.go:55:3: too many arguments in call to Process',
      './pkg/db/store.go:12:7: imported and not used: "fmt"',
    ].join('\n');
    const verdict = parseGoBuildOutput(stderr, 2, 300);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(3);
    expect(verdict.evidence[0]!.file).toBe('./pkg/api/handler.go');
    expect(verdict.evidence[0]!.line).toBe(42);
    expect(verdict.evidence[1]!.line).toBe(55);
    expect(verdict.evidence[2]!.file).toBe('./pkg/db/store.go');
    expect(verdict.reason).toContain('3 compilation error(s)');
  });

  test('non-zero exit with no parseable errors -> BUILD_FAILED', () => {
    const stderr = 'build constraints exclude all Go files in /pkg/foo';
    const verdict = parseGoBuildOutput(stderr, 1, 100);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('BUILD_FAILED');
    expect(verdict.confidence).toBe(0.9);
    expect(verdict.reason).toContain('build constraints');
  });

  test('empty stderr with non-zero exit -> BUILD_FAILED with fallback message', () => {
    const verdict = parseGoBuildOutput('', 1, 50);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('BUILD_FAILED');
  });

  test('interface satisfaction error', () => {
    const stderr = `./server.go:23:15: cannot use &myHandler{} (value of type *myHandler) as http.Handler value in argument to http.ListenAndServe: *myHandler does not implement http.Handler (missing method ServeHTTP)`;
    const verdict = parseGoBuildOutput(stderr, 2, 180);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.snippet).toContain('does not implement');
  });

  test('import error', () => {
    const stderr = `./main.go:5:2: imported and not used: "os"`;
    const verdict = parseGoBuildOutput(stderr, 2, 120);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.snippet).toContain('imported and not used');
  });
});

describe('go-output-mapper — parseGoVetOutput', () => {
  test('clean vet (exit 0) -> verified=true', () => {
    const verdict = parseGoVetOutput('', 0, 80);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(0);
  });

  test('vet issue -> verified=false with [vet] prefix in snippet', () => {
    const stderr = `./main.go:10:2: unreachable code`;
    const verdict = parseGoVetOutput(stderr, 1, 100);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.snippet).toContain('[vet]');
    expect(verdict.evidence[0]!.snippet).toContain('unreachable code');
    expect(verdict.errorCode).toBe('VET_VIOLATION');
  });

  test('multiple vet issues', () => {
    const stderr = [
      './pkg/handler.go:22:5: printf format %d has arg name of wrong type string',
      './pkg/handler.go:45:3: unreachable code',
    ].join('\n');
    const verdict = parseGoVetOutput(stderr, 1, 150);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(2);
    expect(verdict.reason).toContain('2 vet issue(s)');
  });
});

describe('go-output-mapper — parseGoModTidyOutput', () => {
  test('tidy module (exit 0, no diff) -> verified=true', () => {
    const verdict = parseGoModTidyOutput('', 0, 50);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(1.0);
  });

  test('untidy module (diff output) -> verified=false', () => {
    const diff = `diff go.mod
--- go.mod
+++ go.mod
@@ -5 +5,2 @@
+	golang.org/x/text v0.14.0`;
    const verdict = parseGoModTidyOutput(diff, 1, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('MODULE_UNTIDY');
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe('go.mod');
    expect(verdict.reason).toContain('go mod tidy');
  });
});

describe('Go oracle — registration', () => {
  test('registerGoOracle adds go-type to registry', () => {
    registerGoOracle();

    const entry = getOracleEntry('go-type');
    expect(entry).not.toBeUndefined();
    expect(entry!.languages).toContain('go');
    expect(entry!.tier).toBe('deterministic');
  });

  test('go oracle listed for go language', () => {
    registerGoOracle();

    const oracles = listOraclesForLanguage('go');
    expect(oracles).toContain('go-type');
  });

  test('go oracle not listed for python', () => {
    registerGoOracle();

    const oracles = listOraclesForLanguage('python');
    expect(oracles).not.toContain('go-type');
  });
});

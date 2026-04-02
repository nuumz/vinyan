/**
 * Rust oracle tests — PH5.13.
 *
 * Tests the Cargo output mapper and registration.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  parseCargoCheckOutput,
  parseCargoOutput,
} from '../../../src/oracle/rust/cargo-output-mapper.ts';
import { registerRustOracle } from '../../../src/oracle/rust/register.ts';
import { clearDynamicOracles, getOracleEntry, listOraclesForLanguage } from '../../../src/oracle/registry.ts';

afterEach(() => {
  clearDynamicOracles();
});

// Helper: build a cargo JSON message line
function cargoMsg(level: string, message: string, code?: string, file?: string, line?: number): string {
  return JSON.stringify({
    reason: 'compiler-message',
    message: {
      message,
      code: code ? { code, explanation: null } : null,
      level,
      spans: file
        ? [
            {
              file_name: file,
              line_start: line ?? 1,
              line_end: line ?? 1,
              column_start: 1,
              column_end: 10,
              is_primary: true,
            },
          ]
        : [],
      children: [],
    },
  });
}

// Non-diagnostic message from cargo (e.g., build artifact)
function cargoArtifact(): string {
  return JSON.stringify({
    reason: 'compiler-artifact',
    target: { name: 'mylib', kind: ['lib'] },
  });
}

describe('cargo-output-mapper — parseCargoOutput', () => {
  test('clean build (exit 0, no errors) -> verified=true', () => {
    const stdout = [cargoArtifact(), cargoArtifact()].join('\n');
    const verdict = parseCargoOutput(stdout, 0, 500);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(0);
    expect(verdict.durationMs).toBe(500);
  });

  test('type error -> verified=false with TYPE_MISMATCH', () => {
    const stdout = cargoMsg('error', 'mismatched types: expected `u32`, found `String`', 'E0308', 'src/main.rs', 15);
    const verdict = parseCargoOutput(stdout, 101, 300);

    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(1.0);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe('src/main.rs');
    expect(verdict.evidence[0]!.line).toBe(15);
    expect(verdict.evidence[0]!.snippet).toContain('E0308');
    expect(verdict.evidence[0]!.snippet).toContain('mismatched types');
    expect(verdict.errorCode).toBe('TYPE_MISMATCH');
  });

  test('borrow checker error -> BORROW_CHECK', () => {
    const stdout = cargoMsg(
      'error',
      'use of moved value: `x`',
      'E0382',
      'src/lib.rs',
      42,
    );
    const verdict = parseCargoOutput(stdout, 101, 250);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('BORROW_CHECK');
    expect(verdict.evidence[0]!.snippet).toContain('E0382');
  });

  test('lifetime error -> LIFETIME_ERROR', () => {
    const stdout = cargoMsg(
      'error',
      'missing lifetime specifier',
      'E0106',
      'src/types.rs',
      8,
    );
    const verdict = parseCargoOutput(stdout, 101, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('LIFETIME_ERROR');
  });

  test('trait not satisfied -> TRAIT_NOT_SATISFIED', () => {
    const stdout = cargoMsg(
      'error',
      'the trait bound `Foo: Display` is not satisfied',
      'E0277',
      'src/display.rs',
      20,
    );
    const verdict = parseCargoOutput(stdout, 101, 180);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('TRAIT_NOT_SATISFIED');
  });

  test('unsafe violation -> UNSAFE_VIOLATION', () => {
    const stdout = cargoMsg(
      'error',
      'call to unsafe function is unsafe and requires unsafe function or block',
      'E0133',
      'src/ffi.rs',
      33,
    );
    const verdict = parseCargoOutput(stdout, 101, 150);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('UNSAFE_VIOLATION');
  });

  test('multiple errors -> all captured in evidence', () => {
    const stdout = [
      cargoMsg('error', 'mismatched types', 'E0308', 'src/a.rs', 10),
      cargoMsg('error', 'use of moved value', 'E0382', 'src/b.rs', 20),
      cargoMsg('warning', 'unused variable: `x`', undefined, 'src/c.rs', 5),
    ].join('\n');
    const verdict = parseCargoOutput(stdout, 101, 400);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(2); // Only errors, not warnings
    expect(verdict.reason).toContain('2 error(s)');
  });

  test('warnings only with exit 0 -> verified=true', () => {
    const stdout = [
      cargoMsg('warning', 'unused variable: `x`', undefined, 'src/main.rs', 5),
      cargoMsg('warning', 'dead code', undefined, 'src/main.rs', 10),
    ].join('\n');
    const verdict = parseCargoOutput(stdout, 0, 200);

    expect(verdict.verified).toBe(true);
  });

  test('error without code -> heuristic classification via message', () => {
    const stdout = cargoMsg(
      'error',
      'value moved here after borrow',
      undefined,
      'src/main.rs',
      30,
    );
    const verdict = parseCargoOutput(stdout, 101, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('BORROW_CHECK');
  });

  test('heuristic: lifetime in message -> LIFETIME_ERROR', () => {
    const stdout = cargoMsg(
      'error',
      "borrowed value doesn't live long enough",
      undefined,
      'src/ref.rs',
      15,
    );
    const verdict = parseCargoOutput(stdout, 101, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('LIFETIME_ERROR');
  });

  test('heuristic: trait not implemented -> TRAIT_NOT_SATISFIED', () => {
    const stdout = cargoMsg(
      'error',
      'the trait `Send` is not implemented for `Rc<String>`',
      undefined,
      'src/async.rs',
      25,
    );
    const verdict = parseCargoOutput(stdout, 101, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('TRAIT_NOT_SATISFIED');
  });

  test('malformed JSON lines are skipped', () => {
    const stdout = [
      'not json at all',
      cargoMsg('error', 'actual error', 'E0308', 'src/main.rs', 10),
      '{bad json',
    ].join('\n');
    const verdict = parseCargoOutput(stdout, 101, 300);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(1);
  });

  test('error with no spans -> file defaults to <unknown>', () => {
    const stdout = JSON.stringify({
      reason: 'compiler-message',
      message: {
        message: 'aborting due to previous error',
        code: null,
        level: 'error',
        spans: [],
        children: [],
      },
    });
    const verdict = parseCargoOutput(stdout, 101, 100);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence[0]!.file).toBe('<unknown>');
  });
});

describe('cargo-output-mapper — parseCargoCheckOutput', () => {
  test('JSON stdout is preferred over stderr', () => {
    const stdout = cargoMsg('error', 'type mismatch', 'E0308', 'src/main.rs', 5);
    const stderr = 'error: aborting due to previous error';
    const verdict = parseCargoCheckOutput(stdout, stderr, 101, 200);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence).toHaveLength(1);
    expect(verdict.evidence[0]!.file).toBe('src/main.rs');
  });

  test('plain-text stderr fallback when no JSON output', () => {
    const stdout = '';
    const stderr = 'error[E0433]: failed to resolve: use of undeclared crate or module `foo`';
    const verdict = parseCargoCheckOutput(stdout, stderr, 101, 150);

    expect(verdict.verified).toBe(false);
    expect(verdict.evidence.length).toBeGreaterThanOrEqual(1);
  });

  test('clean exit with no output -> verified=true', () => {
    const verdict = parseCargoCheckOutput('', '', 0, 100);

    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
  });
});

describe('Rust oracle — registration', () => {
  test('registerRustOracle adds rust-type to registry', () => {
    registerRustOracle();

    const entry = getOracleEntry('rust-type');
    expect(entry).not.toBeUndefined();
    expect(entry!.languages).toContain('rust');
    expect(entry!.tier).toBe('deterministic');
  });

  test('rust oracle listed for rust language', () => {
    registerRustOracle();

    const oracles = listOraclesForLanguage('rust');
    expect(oracles).toContain('rust-type');
  });

  test('rust oracle not listed for go', () => {
    registerRustOracle();

    const oracles = listOraclesForLanguage('go');
    expect(oracles).not.toContain('rust-type');
  });
});

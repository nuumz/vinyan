import { describe, expect, test } from 'bun:test';
import { extractClaims, verifyClaims } from '../../src/hms/claim-grounding.ts';

describe('extractClaims', () => {
  test('extracts file references', () => {
    const text = 'The file src/auth/login.ts contains the auth logic.\nAlso check src/core/bus.ts for events.';
    const claims = extractClaims(text, 20);
    const fileRefs = claims.filter((c) => c.type === 'file_reference');
    expect(fileRefs.length).toBeGreaterThanOrEqual(2);
    expect(fileRefs.some((c) => c.value.includes('login.ts'))).toBe(true);
  });

  test('extracts import claims', () => {
    const text = "import { EventBus } from '@vinyan/core/bus.ts';";
    const claims = extractClaims(text, 20);
    const imports = claims.filter((c) => c.type === 'import_claim');
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });

  test('detects fake tool calls', () => {
    const text = 'Here is the solution:\n<function_calls>\n<invoke name="write_file">';
    const claims = extractClaims(text, 20);
    const fakes = claims.filter((c) => c.type === 'fake_tool_call');
    expect(fakes.length).toBeGreaterThanOrEqual(1);
  });

  test('respects maxClaims limit', () => {
    const text = 'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts';
    const claims = extractClaims(text, 2);
    expect(claims.length).toBeLessThanOrEqual(2);
  });

  test('deduplicates claims', () => {
    const text = 'Check src/foo.ts and also src/foo.ts again.';
    const claims = extractClaims(text, 20);
    const fileRefs = claims.filter((c) => c.type === 'file_reference' && c.value.includes('foo.ts'));
    expect(fileRefs.length).toBe(1);
  });

  test('filters URL-like false positives', () => {
    const text = 'Visit https://example.com/api for docs.';
    const claims = extractClaims(text, 20);
    const fileRefs = claims.filter((c) => c.type === 'file_reference');
    expect(fileRefs.every((c) => !c.value.includes('example.com'))).toBe(true);
  });
});

describe('verifyClaims', () => {
  const workspace = process.cwd();

  test('verifies existing files', () => {
    const claims = [{ type: 'file_reference' as const, value: 'package.json', source_line: 1 }];
    const result = verifyClaims(claims, workspace);
    expect(result.verified).toBe(1);
    expect(result.refuted).toBe(0);
    expect(result.grounding_ratio).toBe(1.0);
  });

  test('refutes non-existing files', () => {
    const claims = [{ type: 'file_reference' as const, value: 'src/nonexistent/fake-file.ts', source_line: 1 }];
    const result = verifyClaims(claims, workspace);
    expect(result.refuted).toBe(1);
    expect(result.grounding_ratio).toBe(0);
    expect(result.refuted_claims).toHaveLength(1);
  });

  test('fake tool calls are always refuted', () => {
    const claims = [{ type: 'fake_tool_call' as const, value: '<function_calls>', source_line: 1 }];
    const result = verifyClaims(claims, workspace);
    expect(result.refuted).toBe(1);
    expect(result.grounding_ratio).toBe(0);
  });

  test('mixed claims produce partial grounding ratio', () => {
    const claims = [
      { type: 'file_reference' as const, value: 'package.json', source_line: 1 },
      { type: 'file_reference' as const, value: 'src/totally-fake.ts', source_line: 2 },
    ];
    const result = verifyClaims(claims, workspace);
    expect(result.verified).toBe(1);
    expect(result.refuted).toBe(1);
    expect(result.grounding_ratio).toBeCloseTo(0.5, 3);
  });

  test('no claims → neutral grounding ratio (0.5)', () => {
    const result = verifyClaims([], workspace);
    expect(result.grounding_ratio).toBe(0.5);
  });
});

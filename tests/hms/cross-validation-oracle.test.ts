import { describe, expect, test } from 'bun:test';
import type { ExtractedClaim } from '../../src/hms/claim-grounding.ts';
import { crossValidate, type ProbeProvider } from '../../src/hms/cross-validation-oracle.ts';
import { generateProbes } from '../../src/hms/probe-templates.ts';

/** Mock provider that confirms everything. */
const confirmProvider: ProbeProvider = {
  async generate(prompt) {
    if (prompt.includes('does NOT')) return 'No, that is incorrect. The file does exist.';
    return 'Yes, it exists.';
  },
};

/** Mock provider that denies everything. */
const denyProvider: ProbeProvider = {
  async generate(prompt) {
    if (prompt.includes('does NOT')) return 'Yes, correct. It does not exist.';
    return 'No, it does not exist.';
  },
};

/** Mock provider that gives inconsistent answers. */
const inconsistentProvider: ProbeProvider = {
  async generate(prompt) {
    if (prompt.includes('Does')) return 'Yes, it exists.';
    if (prompt.includes('does NOT')) return 'Yes, correct. It does not exist.';
    return 'I am not sure.';
  },
};

function makeClaim(type: ExtractedClaim['type'] = 'file_reference', value = 'src/auth/login.ts'): ExtractedClaim {
  return { type, value, source_line: 1 };
}

describe('generateProbes', () => {
  test('generates affirmation + negation + reframe for file refs', () => {
    const probes = generateProbes(makeClaim('file_reference'));
    expect(probes.length).toBe(3);
    expect(probes.some((p) => p.type === 'affirmation')).toBe(true);
    expect(probes.some((p) => p.type === 'negation')).toBe(true);
    expect(probes.some((p) => p.type === 'reframe')).toBe(true);
  });

  test('generates probes for fake tool calls', () => {
    const probes = generateProbes(makeClaim('fake_tool_call', '<function_calls>'));
    expect(probes.length).toBeGreaterThanOrEqual(1);
  });

  test('generates probes for import claims', () => {
    const probes = generateProbes(makeClaim('import_claim', '@vinyan/core/bus'));
    expect(probes.length).toBe(2);
  });
});

describe('crossValidate', () => {
  test('high consistency when provider confirms', async () => {
    const claims = [makeClaim()];
    const result = await crossValidate(claims, confirmProvider, {
      maxProbesPerClaim: 2,
      maxClaims: 5,
      probeBudgetTokens: 2000,
    });
    expect(result.consistency).toBeGreaterThan(0.7);
    expect(result.probes_sent).toBeGreaterThan(0);
  });

  test('low consistency when provider denies', async () => {
    const claims = [makeClaim()];
    const result = await crossValidate(claims, denyProvider, {
      maxProbesPerClaim: 2,
      maxClaims: 5,
      probeBudgetTokens: 2000,
    });
    expect(result.consistency).toBeLessThan(0.5);
  });

  test('medium consistency for inconsistent provider', async () => {
    const claims = [makeClaim()];
    const result = await crossValidate(claims, inconsistentProvider, {
      maxProbesPerClaim: 3,
      maxClaims: 5,
      probeBudgetTokens: 2000,
    });
    // Should be between full confirm and full deny
    expect(result.consistency).toBeGreaterThan(0.2);
    expect(result.consistency).toBeLessThan(0.9);
  });

  test('returns 1.0 consistency for empty claims', async () => {
    const result = await crossValidate([], confirmProvider);
    expect(result.consistency).toBe(1.0);
    expect(result.probes_sent).toBe(0);
  });

  test('respects budget limit', async () => {
    const claims = Array.from({ length: 10 }, (_, i) => makeClaim('file_reference', `src/file${i}.ts`));
    const result = await crossValidate(claims, confirmProvider, {
      maxProbesPerClaim: 3,
      maxClaims: 5,
      probeBudgetTokens: 400,
    });
    // Budget = 400 tokens / 200 per probe = max 2 probes
    expect(result.probes_sent).toBeLessThanOrEqual(2);
  });

  test('prioritizes fake_tool_call and file_reference', async () => {
    const claims = [
      makeClaim('symbol_reference', 'someFunc'),
      makeClaim('fake_tool_call', '<invoke>'),
      makeClaim('file_reference', 'src/main.ts'),
    ];
    // With maxClaims=2, should pick fake_tool_call and file_reference first
    const result = await crossValidate(claims, confirmProvider, {
      maxProbesPerClaim: 1,
      maxClaims: 2,
      probeBudgetTokens: 2000,
    });
    expect(result.probes_sent).toBeLessThanOrEqual(2);
  });
});

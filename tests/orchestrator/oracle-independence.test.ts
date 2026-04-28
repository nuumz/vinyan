import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../src/core/types.ts';
import { deriveOracleIndependenceAudit } from '../../src/orchestrator/oracle-independence.ts';

function verdict(overrides: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: true,
    type: 'known',
    confidence: 0.8,
    evidence: [{ file: 'src/auth.ts', line: 10, snippet: 'export function login() {}' }],
    fileHashes: { 'src/auth.ts': 'sha256:auth' },
    durationMs: 12,
    ...overrides,
  };
}

describe('deriveOracleIndependenceAudit', () => {
  test('records aggregate confidence composition without changing confidence decisions', () => {
    const audit = deriveOracleIndependenceAudit({
      verdicts: {
        ast: verdict({ confidence: 1, evidence: [{ file: 'src/auth.ts', line: 10, snippet: 'ast', contentHash: 'h1' }] }),
        lint: verdict({ confidence: 0.72, evidence: [{ file: 'src/auth.ts', line: 22, snippet: 'lint', contentHash: 'h2' }] }),
      },
      aggregateConfidence: 0.86,
      passed: true,
    });

    expect(audit.compositionMethod).toBe('oracle-gate-aggregate-confidence');
    expect(audit.assumption).toBe('independent');
    expect(audit.primaryOracles).toEqual(['ast']);
    expect(audit.corroboratingOracles).toEqual(['lint']);
    expect(audit.deterministicOracleCount).toBe(1);
    expect(audit.heuristicOracleCount).toBe(1);
  });

  test('flags shared evidence across multiple oracle verdicts', () => {
    const audit = deriveOracleIndependenceAudit({
      verdicts: {
        ast: verdict({ confidence: 1, evidence: [{ file: 'src/auth.ts', line: 10, snippet: 'ast', contentHash: 'h1' }] }),
        type: verdict({ confidence: 1, evidence: [{ file: 'src/auth.ts', line: 40, snippet: 'type', contentHash: 'h1' }] }),
      },
      passed: true,
    });

    expect(audit.compositionMethod).toBe('default-pass-fallback');
    expect(audit.assumption).toBe('shared-evidence');
    expect(audit.sharedEvidenceWarnings).toEqual(['shared evidence h1 used by ast,type']);
  });
});

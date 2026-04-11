/**
 * Tests for STU Phase D: Understanding Calibrator.
 * A7: Measures understanding accuracy — entity overlap, category match, enriched signatures.
 */
import { describe, expect, test } from 'bun:test';
import {
  calibrateUnderstanding,
  computeEnrichedSignature,
  ENRICHMENT_THRESHOLD,
} from '../../src/orchestrator/understanding/understanding-calibrator.ts';
import type { ExecutionTrace, SemanticTaskUnderstanding } from '../../src/orchestrator/types.ts';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeUnderstanding(overrides: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'fix the auth service bug',
    actionVerb: 'fix',
    actionCategory: 'mutation',
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'tool-needed',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'test-fp',
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct fix',
    oracleVerdicts: {},
    modelUsed: 'test-model',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  };
}

// ── calibrateUnderstanding ──────────────────────────────────────────────

describe('calibrateUnderstanding', () => {
  test('all resolved paths match affected files → entityAccuracy = 1.0', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [
        { reference: 'auth', resolvedPaths: ['src/auth/service.ts'], resolution: 'exact', confidence: 1.0, confidenceSource: 'evidence-derived' },
        { reference: 'utils', resolvedPaths: ['src/utils/helper.ts'], resolution: 'fuzzy-path', confidence: 0.8, confidenceSource: 'evidence-derived' },
      ],
    });
    const trace = makeTrace({ affectedFiles: ['src/auth/service.ts', 'src/utils/helper.ts'] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.entityAccuracy).toBe(1.0);
  });

  test('half resolved paths match → entityAccuracy = 0.5', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [
        { reference: 'auth', resolvedPaths: ['src/auth/service.ts', 'src/auth/middleware.ts'], resolution: 'fuzzy-path', confidence: 0.8, confidenceSource: 'evidence-derived' },
      ],
    });
    const trace = makeTrace({ affectedFiles: ['src/auth/service.ts'] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.entityAccuracy).toBe(0.5);
  });

  test('no resolved entities → entityAccuracy = 1.0 (no predictions = no error)', () => {
    const understanding = makeUnderstanding({ resolvedEntities: [] });
    const trace = makeTrace({ affectedFiles: ['src/auth/service.ts'] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.entityAccuracy).toBe(1.0);
  });

  test('no overlap → entityAccuracy = 0.0', () => {
    const understanding = makeUnderstanding({
      resolvedEntities: [
        { reference: 'auth', resolvedPaths: ['src/auth/service.ts'], resolution: 'exact', confidence: 1.0, confidenceSource: 'evidence-derived' },
      ],
    });
    const trace = makeTrace({ affectedFiles: ['src/payment/gateway.ts'] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.entityAccuracy).toBe(0.0);
  });

  test('expectsMutation=true + has affected files → categoryMatch = true', () => {
    const understanding = makeUnderstanding({ expectsMutation: true });
    const trace = makeTrace({ affectedFiles: ['src/auth/service.ts'] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.categoryMatch).toBe(true);
  });

  test('expectsMutation=true + no affected files → categoryMatch = false', () => {
    const understanding = makeUnderstanding({ expectsMutation: true });
    const trace = makeTrace({ affectedFiles: [] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.categoryMatch).toBe(false);
  });

  test('expectsMutation=false + no affected files → categoryMatch = true', () => {
    const understanding = makeUnderstanding({ expectsMutation: false });
    const trace = makeTrace({ affectedFiles: [] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.categoryMatch).toBe(true);
  });

  test('expectsMutation=false + has affected files → categoryMatch = false', () => {
    const understanding = makeUnderstanding({ expectsMutation: false });
    const trace = makeTrace({ affectedFiles: ['src/file.ts'] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.categoryMatch).toBe(false);
  });

  test('predictedIntent populated from semanticIntent', () => {
    const understanding = makeUnderstanding({
      semanticIntent: {
        primaryAction: 'bug-fix',
        secondaryActions: [],
        scope: 'auth',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });
    const trace = makeTrace();
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.predictedIntent).toBe('bug-fix');
    expect(cal.actualBehavior).toBe('success');
  });

  test('no semanticIntent → predictedIntent undefined', () => {
    const understanding = makeUnderstanding({ semanticIntent: undefined });
    const trace = makeTrace();
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.predictedIntent).toBeUndefined();
  });
});

// ── computeEnrichedSignature ────────────────────────────────────────────

describe('computeEnrichedSignature', () => {
  test('no semanticIntent → returns base signature', () => {
    const understanding = makeUnderstanding({ semanticIntent: undefined });
    const result = computeEnrichedSignature('fix::ts::small', understanding, () => 100);
    expect(result).toBe('fix::ts::small');
  });

  test('intent present, 0 observations → returns base signature', () => {
    const understanding = makeUnderstanding({
      semanticIntent: {
        primaryAction: 'security-fix',
        secondaryActions: [],
        scope: 'auth',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });
    const result = computeEnrichedSignature('fix::ts::small', understanding, () => 0);
    expect(result).toBe('fix::ts::small');
  });

  test('intent present, below threshold (9) → returns base signature', () => {
    const understanding = makeUnderstanding({
      semanticIntent: {
        primaryAction: 'security-fix',
        secondaryActions: [],
        scope: 'auth',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });
    const result = computeEnrichedSignature('fix::ts::small', understanding, () => ENRICHMENT_THRESHOLD - 1);
    expect(result).toBe('fix::ts::small');
  });

  test('intent present, at threshold (10) → returns enriched signature', () => {
    const understanding = makeUnderstanding({
      semanticIntent: {
        primaryAction: 'security-fix',
        secondaryActions: [],
        scope: 'auth',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });
    const result = computeEnrichedSignature('fix::ts::small', understanding, () => ENRICHMENT_THRESHOLD);
    expect(result).toBe('fix::ts::small::security-fix');
  });

  test('intent present, above threshold (50) → returns enriched signature', () => {
    const understanding = makeUnderstanding({
      semanticIntent: {
        primaryAction: 'bug-fix',
        secondaryActions: [],
        scope: 'auth',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });
    const result = computeEnrichedSignature('fix::ts::small', understanding, () => 50);
    expect(result).toBe('fix::ts::small::bug-fix');
  });

  test('getObservationCount receives the enriched signature as argument', () => {
    const understanding = makeUnderstanding({
      semanticIntent: {
        primaryAction: 'refactor',
        secondaryActions: [],
        scope: 'payment',
        implicitConstraints: [],
        ambiguities: [],
        confidenceSource: 'llm-self-report',
        tierReliability: 0.4,
      },
    });
    let queriedSig = '';
    computeEnrichedSignature('fix::ts::small', understanding, (sig) => {
      queriedSig = sig;
      return 0;
    });
    expect(queriedSig).toBe('fix::ts::small::refactor');
  });
});

// ── NULL safety (D4.5) ──────────────────────────────────────────────────

describe('NULL safety', () => {
  test('depth 0, no intent, no entities → does not crash, returns valid calibration', () => {
    const understanding = makeUnderstanding({
      understandingDepth: 0,
      semanticIntent: undefined,
      resolvedEntities: [],
      expectsMutation: false,
    });
    const trace = makeTrace({ affectedFiles: [] });
    const cal = calibrateUnderstanding(understanding, trace);
    expect(cal.entityAccuracy).toBe(1.0);
    expect(cal.categoryMatch).toBe(true);
    expect(cal.predictedIntent).toBeUndefined();
    expect(cal.actualBehavior).toBe('success');
  });

  test('enriched signature with depth 0 and no intent → base signature', () => {
    const understanding = makeUnderstanding({
      understandingDepth: 0,
      semanticIntent: undefined,
    });
    const result = computeEnrichedSignature('fix::ts::small', understanding, () => 100);
    expect(result).toBe('fix::ts::small');
  });
});

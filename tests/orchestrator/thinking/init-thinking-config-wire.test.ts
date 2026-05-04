/**
 * T0b wiring contract — `init` turn carries `thinkingConfig` across the
 * subprocess boundary. Pin the wire schema so a regression that drops the
 * field (or accepts an invalid shape) breaks immediately rather than
 * silently dropping extended-thinking budget on every L2+ subprocess turn.
 */
import { describe, expect, test } from 'bun:test';
import { OrchestratorTurnSchema } from '../../../src/orchestrator/protocol.ts';

const baseInit = {
  type: 'init' as const,
  taskId: 't-1',
  goal: 'do the thing',
  taskType: 'code' as const,
  routingLevel: 2 as const,
  perception: {
    taskTarget: { file: 'a.ts', description: 'edit' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v22', os: 'linux', availableTools: [] },
  },
  workingMemory: {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  },
  budget: {
    maxTokens: 50_000,
    maxDurationMs: 60_000,
    maxTurns: 8,
    contextWindow: 200_000,
    base: 50_000,
    negotiable: 0,
    delegation: 0,
  },
  allowedPaths: [],
  toolManifest: [],
};

describe('OrchestratorTurnSchema — init.thinkingConfig (T0b)', () => {
  test('accepts a disabled thinking config', () => {
    const parsed = OrchestratorTurnSchema.safeParse({
      ...baseInit,
      thinkingConfig: { type: 'disabled' },
    });
    expect(parsed.success).toBe(true);
  });

  test('accepts an adaptive thinking config with effort + display', () => {
    const parsed = OrchestratorTurnSchema.safeParse({
      ...baseInit,
      thinkingConfig: { type: 'adaptive', effort: 'high', display: 'summarized' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'init') {
      expect(parsed.data.thinkingConfig).toEqual({
        type: 'adaptive',
        effort: 'high',
        display: 'summarized',
      });
    }
  });

  test('accepts an enabled thinking config with positive budget', () => {
    const parsed = OrchestratorTurnSchema.safeParse({
      ...baseInit,
      thinkingConfig: { type: 'enabled', budgetTokens: 10_000 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'init') {
      expect(parsed.data.thinkingConfig).toEqual({ type: 'enabled', budgetTokens: 10_000 });
    }
  });

  test('rejects an invalid thinking-config shape (zero budget)', () => {
    const parsed = OrchestratorTurnSchema.safeParse({
      ...baseInit,
      thinkingConfig: { type: 'enabled', budgetTokens: 0 },
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects an unknown thinking-config type', () => {
    const parsed = OrchestratorTurnSchema.safeParse({
      ...baseInit,
      thinkingConfig: { type: 'multi-hypothesis', branches: 3 },
    });
    // Multi-hypothesis is orchestrated above the subprocess and is NOT a
    // valid wire variant — the schema must reject it so a future code path
    // can't accidentally ship the exotic mode straight into a per-turn LLM call.
    expect(parsed.success).toBe(false);
  });

  test('init turn without thinkingConfig still validates (forward compat)', () => {
    const parsed = OrchestratorTurnSchema.safeParse(baseInit);
    expect(parsed.success).toBe(true);
  });
});

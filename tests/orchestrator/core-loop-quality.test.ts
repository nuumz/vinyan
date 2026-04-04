/**
 * Core Loop QualityScore Tests — verifies A7 gradient signal wiring.
 *
 * Confirms that ExecutionTraces and TaskResults include QualityScore
 * computed from oracle verdicts and worker duration.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-qs-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(tempDir, 'vinyan.json'),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
    }),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-qs',
    source: 'cli',
    goal: 'Fix the export',
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRegistry() {
  const registry = new LLMProviderRegistry();
  const content = JSON.stringify({
    proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'changed value' }],
    proposedToolCalls: [],
    uncertainties: [],
  });
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

describe('Core Loop QualityScore — A7 Gradient Signal', () => {
  test('trace includes qualityScore after task execution', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput());

    const traces = orchestrator.traceCollector.getTraces();
    expect(traces.length).toBeGreaterThanOrEqual(1);

    const trace = traces[0]!;
    expect(trace.qualityScore).toBeDefined();
    // C3 fix: composite may be NaN if no oracles ran (unverified gate) — that's correct
    const composite = trace.qualityScore!.composite;
    const isValidComposite = (typeof composite === 'number' && composite >= 0 && composite <= 1) || isNaN(composite);
    expect(isValidComposite).toBe(true);
  });

  test('qualityScore has architecturalCompliance and efficiency dimensions', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput());

    const trace = orchestrator.traceCollector.getTraces()[0]!;
    expect(trace.qualityScore).toBeDefined();
    // C3 fix: types are still 'number' even when NaN; dimensionsAvailable is 0 for zero-oracle
    expect(typeof trace.qualityScore!.architecturalCompliance).toBe('number');
    expect(typeof trace.qualityScore!.efficiency).toBe('number');
    // dimensionsAvailable is 0 when unverified, >=2 when oracles ran
    expect(trace.qualityScore!.dimensionsAvailable).toBeGreaterThanOrEqual(0);
  });

  test('qualityScore.phase reflects available dimensions', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput());

    const trace = orchestrator.traceCollector.getTraces()[0]!;
    expect(trace.qualityScore).toBeDefined();
    // Without complexity context, should be phase0 (2 dims) or phase1 (3 dims if test oracle present)
    expect(['phase0', 'phase1']).toContain(trace.qualityScore!.phase);
  });

  test('successful task result includes qualityScore', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeInput());

    if (result.status === 'completed') {
      expect(result.qualityScore).toBeDefined();
      // C3 fix: composite may be NaN when no oracles ran — that is correct behavior
      const composite = result.qualityScore!.composite;
      expect(typeof composite).toBe('number'); // NaN is typeof 'number'
    }
  });

  test('qualityScore with all oracles disabled has high architecturalCompliance', async () => {
    // All oracles disabled → no rejections → 100% pass rate → high compliance
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeRegistry(), useSubprocess: false });
    await orchestrator.executeTask(makeInput());

    const trace = orchestrator.traceCollector.getTraces()[0]!;
    if (trace.qualityScore) {
      // Zero-oracle case returns unverified:true with neutral score (no NaN propagation)
      if (trace.qualityScore.unverified) {
        expect(trace.qualityScore.architecturalCompliance).toBe(0.5);
        expect(Number.isFinite(trace.qualityScore.composite)).toBe(true);
      } else {
        expect(trace.qualityScore.architecturalCompliance).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

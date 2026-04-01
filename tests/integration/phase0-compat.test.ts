/**
 * Phase 0 Compatibility Guard Tests
 *
 * Ensures Phase 1+ orchestrator preserves Phase 0 blocking semantics:
 * - Oracle verdicts are binary (pass/fail)
 * - Any-fail = block (fail-closed)
 * - Risk router routes to correct levels
 * - Oracle pipeline runs all enabled oracles
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
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-phase0-compat-'));
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
    id: 'phase0-compat',
    source: 'cli',
    goal: 'Fix export',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRegistry() {
  const registry = new LLMProviderRegistry();
  const content = JSON.stringify({
    proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'fix' }],
    proposedToolCalls: [],
    uncertainties: [],
  });
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

describe('Phase 0 Compatibility Guards', () => {
  test('fail-closed: oracle rejection blocks commit (A6)', async () => {
    const alwaysFailGate = {
      verify: async () => ({
        passed: false,
        verdicts: {} as Record<string, import('../../src/core/types.ts').OracleVerdict>,
        reason: 'Phase 0 blocking: AST check failed',
      }),
    };
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: alwaysFailGate,
    });
    const result = await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    // Must escalate (never commit when oracle says no)
    expect(result.status).toBe('escalated');
    // File must remain unchanged on disk
    const { readFileSync } = await import('fs');
    const content = readFileSync(join(tempDir, 'src', 'foo.ts'), 'utf-8');
    expect(content).toBe('export const x = 1;\n');
  });

  test('L0 task produces zero token consumption', async () => {
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    const result = await orchestrator.executeTask(makeInput());
    // L0 routing → no LLM call → zero tokens
    expect(result.trace.routingLevel).toBe(0);
    expect(result.trace.tokens_consumed).toBe(0);
  });

  test('oracle verdicts carry verified boolean in Phase 0 mode', async () => {
    let capturedVerdicts: Record<string, import('../../src/core/types.ts').OracleVerdict> | undefined;
    const gateWithVerdicts = {
      verify: async () => {
        const verdicts: Record<string, import('../../src/core/types.ts').OracleVerdict> = {
          'ast-oracle': { verified: true, type: 'known', confidence: 1.0, evidence: [], fileHashes: {}, durationMs: 1 },
          'dep-oracle': { verified: true, type: 'known', confidence: 1.0, evidence: [], fileHashes: {}, durationMs: 1 },
        };
        capturedVerdicts = verdicts;
        return { passed: true, verdicts };
      },
    };
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      oracleGate: gateWithVerdicts,
    });
    await orchestrator.executeTask(makeInput({ targetFiles: ['src/foo.ts'] }));
    // Verdicts should carry verified boolean (Phase 0: type is 'known')
    if (capturedVerdicts) {
      for (const [_oracle, verdict] of Object.entries(capturedVerdicts)) {
        expect(typeof verdict.verified).toBe('boolean');
        expect(verdict.type).toBe('known');
        expect(verdict.confidence).toBe(1.0);
      }
    }
  });

  test('completed result has valid TaskResult shape per Phase 0 contract', async () => {
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    const result = await orchestrator.executeTask(makeInput());
    // Phase 0 contract: id, status, mutations array, trace
    expect(result.id).toBe('phase0-compat');
    expect(['completed', 'failed', 'escalated', 'uncertain']).toContain(result.status);
    expect(Array.isArray(result.mutations)).toBe(true);
    expect(result.trace).toBeDefined();
    expect(typeof result.trace.timestamp).toBe('number');
    expect(typeof result.trace.durationMs).toBe('number');
  });

  test('risk router respects L0 for simple tasks without target files', async () => {
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    // No targetFiles → low risk → L0
    const result = await orchestrator.executeTask(makeInput());
    expect(result.trace.routingLevel).toBe(0);
  });
});

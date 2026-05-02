/**
 * Phase A + A.5 — workflow-executor specialist-format integration tests.
 *
 * Pins the contract:
 *   - When `specialistRegistry` + explicit `specialistTarget` are wired,
 *     the executor formats `synthesizedOutput` through the matching
 *     adapter and stores raw text on `rawSynthesizedOutput`.
 *   - Phase A.5: when `specialistTarget` is unset BUT
 *     `specialistFormatContext.creativeDomain !== 'generic'`, the
 *     executor defaults to `manual-edit-spec` and produces a
 *     domain-specific structured output.
 *   - Failed workflows are NOT formatted — the failure rationale ships
 *     verbatim on `synthesizedOutput`.
 *   - Generic-domain tasks without explicit specialist do NOT format —
 *     legacy behaviour preserved for non-creative goals.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { createSpecialistRegistry } from '../../../src/orchestrator/specialist-prompt/registry.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';

function makeInput(goal: string, id = 'task-spec-1'): TaskInput {
  return {
    id,
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
  };
}

const SIMPLE_PLAN = JSON.stringify({
  goal: 'plan',
  steps: [
    {
      id: 'step1',
      description: 'produce the deliverable',
      strategy: 'llm-reasoning',
      budgetFraction: 1.0,
    },
  ],
  synthesisPrompt: 'Return step1 directly.',
});

function makePlannerProvider(planJson: string, stepOutput = 'Hook + beats + payoff.') {
  let calls = 0;
  return {
    id: 'mock',
    capabilities: { codeGeneration: true, structuredOutput: true },
    generate: async () => {
      calls += 1;
      const content = calls === 1 ? planJson : stepOutput;
      return { content, tokensUsed: { input: 0, output: 0 } };
    },
  };
}

describe('workflow-executor specialist format — Phase A explicit target', () => {
  test('formats output via the requested adapter when specialistTarget is set', async () => {
    const bus = createBus();
    const registry = createSpecialistRegistry();
    const provider = makePlannerProvider(SIMPLE_PLAN);
    const llmRegistry = {
      selectByTier: () => provider,
      register: () => {},
      listProviders: () => [provider],
    } as any;

    const result = await executeWorkflow(makeInput('Write a tagline for a coffee shop'), {
      llmRegistry,
      bus,
      specialistRegistry: registry,
      specialistTarget: 'manual-edit-spec',
      specialistFormatContext: { creativeDomain: 'video' },
    });

    expect(result.status).toBe('completed');
    expect(result.specialistFormatted?.specialistId).toBe('manual-edit-spec');
    expect(result.specialistFormatted?.fellBack).toBe(false);
    // Domain-specific shot-script scaffolding present:
    expect(result.synthesizedOutput).toContain('## Hook (0:00 – 0:01.5)');
    expect(result.synthesizedOutput).toContain('## Shot list');
    // Raw text preserved
    expect(result.rawSynthesizedOutput).toBe('Hook + beats + payoff.');
  });
});

describe('workflow-executor specialist format — Phase A.5 default for creative domains', () => {
  test('defaults to manual-edit-spec when creativeDomain is non-generic and no explicit target supplied', async () => {
    const bus = createBus();
    const registry = createSpecialistRegistry();
    const provider = makePlannerProvider(SIMPLE_PLAN);
    const llmRegistry = {
      selectByTier: () => provider,
      register: () => {},
      listProviders: () => [provider],
    } as any;

    const result = await executeWorkflow(makeInput('Draft a music outline'), {
      llmRegistry,
      bus,
      specialistRegistry: registry,
      // NOTE: specialistTarget intentionally omitted
      specialistFormatContext: { creativeDomain: 'music' },
    });

    expect(result.status).toBe('completed');
    expect(result.specialistFormatted?.specialistId).toBe('manual-edit-spec');
    expect(result.specialistFormatted?.fellBack).toBe(false);
    // Music-domain scaffolding from manual-edit-spec adapter:
    expect(result.synthesizedOutput).toContain('## Structure outline');
    expect(result.synthesizedOutput).toContain('Production notes');
  });

  test('does NOT format when creativeDomain is generic (legacy behaviour preserved)', async () => {
    const bus = createBus();
    const registry = createSpecialistRegistry();
    const provider = makePlannerProvider(SIMPLE_PLAN, 'plain answer text');
    const llmRegistry = {
      selectByTier: () => provider,
      register: () => {},
      listProviders: () => [provider],
    } as any;

    const result = await executeWorkflow(makeInput('list files in /tmp'), {
      llmRegistry,
      bus,
      specialistRegistry: registry,
      specialistFormatContext: { creativeDomain: 'generic' },
    });

    expect(result.status).toBe('completed');
    expect(result.specialistFormatted).toBeUndefined();
    expect(result.rawSynthesizedOutput).toBeUndefined();
    expect(result.synthesizedOutput).toBe('plain answer text');
  });

  test('does NOT format when no specialistRegistry is wired (registry-absent fallthrough)', async () => {
    const bus = createBus();
    const provider = makePlannerProvider(SIMPLE_PLAN, 'plain text');
    const llmRegistry = {
      selectByTier: () => provider,
      register: () => {},
      listProviders: () => [provider],
    } as any;

    const result = await executeWorkflow(makeInput('Write a TikTok script'), {
      llmRegistry,
      bus,
      specialistFormatContext: { creativeDomain: 'video' }, // creative but no registry
    });

    expect(result.status).toBe('completed');
    expect(result.specialistFormatted).toBeUndefined();
    expect(result.synthesizedOutput).toBe('plain text');
  });
});

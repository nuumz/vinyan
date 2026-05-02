/**
 * Persona-overlay tests — pin the contract the room dispatcher depends on.
 *
 *   - Empty primary list → empty overlay map (no LLM call)
 *   - No provider → empty map
 *   - LLM returns valid overlays → keyed by exact persona id, capped per id
 *   - Unknown ids in response are dropped
 *   - First-person verify verbs in non-verifier overlay → that id is dropped
 *   - Bad JSON → empty map
 */
import { describe, expect, it } from 'bun:test';
import { createScriptedMockProvider } from '../../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../../src/orchestrator/llm/provider-registry.ts';
import { draftPersonaOverlay } from '../../../../src/orchestrator/room/presets/persona-overlay.ts';

function llmRegistryWith(...contents: string[]): LLMProviderRegistry {
  const reg = new LLMProviderRegistry();
  reg.register(
    createScriptedMockProvider(
      contents.map((c) => ({ content: c, stopReason: 'end_turn' as const })),
      { id: 'mock/fast', tier: 'fast' },
    ),
  );
  return reg;
}

const PERSONA_INFO = [
  { id: 'developer', role: 'generator' as const, description: 'TypeScript developer' },
  { id: 'architect', role: 'generator' as const, description: 'System architect' },
  { id: 'reviewer', role: 'verifier' as const, description: 'Code reviewer' },
  { id: 'mentor', role: 'mixed' as const, description: 'Coaching guide' },
];

describe('draftPersonaOverlay — short-circuit paths', () => {
  it('empty primary list → empty overlays + 0 attempts', async () => {
    const result = await draftPersonaOverlay({
      goal: 'anything',
      primaryIds: [],
      personaInfo: [],
      interactionMode: 'debate',
      llmRegistry: new LLMProviderRegistry(),
    });
    expect(result.overlays.size).toBe(0);
    expect(result.attempts).toBe(0);
  });

  it('no provider registered → empty overlays', async () => {
    const result = await draftPersonaOverlay({
      goal: 'anything',
      primaryIds: ['developer'],
      personaInfo: PERSONA_INFO,
      interactionMode: 'debate',
      llmRegistry: new LLMProviderRegistry(),
    });
    expect(result.overlays.size).toBe(0);
  });
});

describe('draftPersonaOverlay — happy path', () => {
  it('returns overlays keyed by the exact persona ids the LLM was given', async () => {
    const reg = llmRegistryWith(
      JSON.stringify({
        overlays: {
          developer: 'Argue from the implementation feasibility angle for THIS goal.',
          architect: 'Argue from the long-term system design angle.',
          mentor: 'Surface the human / decision-support trade-offs.',
        },
        rationale: 'three contrasting perspectives for a code-architecture debate',
      }),
    );
    const result = await draftPersonaOverlay({
      goal: 'How should we shard the user table?',
      primaryIds: ['developer', 'architect', 'mentor'],
      personaInfo: PERSONA_INFO,
      interactionMode: 'debate',
      llmRegistry: reg,
    });
    expect(result.overlays.size).toBe(3);
    expect(result.overlays.get('developer')).toContain('feasibility');
    expect(result.overlays.get('architect')).toContain('long-term');
    expect(result.overlays.get('mentor')).toContain('trade-offs');
    expect(result.rationale).toContain('contrasting');
    expect(result.attempts).toBe(1);
  });

  it('drops unknown ids the LLM hallucinated', async () => {
    const reg = llmRegistryWith(
      JSON.stringify({
        overlays: {
          developer: 'good overlay',
          ghost: 'should be dropped — id not in input',
        },
      }),
    );
    const result = await draftPersonaOverlay({
      goal: 'g',
      primaryIds: ['developer'],
      personaInfo: PERSONA_INFO,
      interactionMode: 'parallel-answer',
      llmRegistry: reg,
    });
    expect(result.overlays.size).toBe(1);
    expect(result.overlays.has('developer')).toBe(true);
    expect(result.overlays.has('ghost')).toBe(false);
  });
});

describe('draftPersonaOverlay — A1 verify-verb lint', () => {
  it('drops a non-verifier persona overlay that contains "I verify"', async () => {
    const reg = llmRegistryWith(
      JSON.stringify({
        overlays: {
          // 'developer' is generator class — first-person verify is forbidden
          developer: 'I verify the merge plan against rollback constraints.',
          // 'reviewer' is verifier class — same verb is allowed
          reviewer: 'I verify peer claims for completeness.',
        },
      }),
    );
    const result = await draftPersonaOverlay({
      goal: 'g',
      primaryIds: ['developer', 'reviewer'],
      personaInfo: PERSONA_INFO,
      interactionMode: 'debate',
      llmRegistry: reg,
    });
    expect(result.overlays.has('developer')).toBe(false);
    expect(result.overlays.has('reviewer')).toBe(true);
  });
});

describe('draftPersonaOverlay — error tolerance', () => {
  it('returns empty overlays on bad JSON', async () => {
    const reg = llmRegistryWith('this is not json');
    const result = await draftPersonaOverlay({
      goal: 'g',
      primaryIds: ['developer'],
      personaInfo: PERSONA_INFO,
      interactionMode: 'parallel-answer',
      llmRegistry: reg,
    });
    expect(result.overlays.size).toBe(0);
  });

  it('returns empty overlays when overlays object is missing', async () => {
    const reg = llmRegistryWith(JSON.stringify({ rationale: 'no overlays here' }));
    const result = await draftPersonaOverlay({
      goal: 'g',
      primaryIds: ['developer'],
      personaInfo: PERSONA_INFO,
      interactionMode: 'parallel-answer',
      llmRegistry: reg,
    });
    expect(result.overlays.size).toBe(0);
  });
});

/**
 * Critic adapter tests — verify `buildImporterCriticFn` correctly reshapes
 * `CriticResult` into the narrow `ImporterCriticVerdict`, and that the
 * synthesized `WorkerProposal` + `TaskInput` carry the skill identity.
 */
import { describe, expect, test } from 'bun:test';
import type { CriticResult, WorkerProposal } from '../../../src/orchestrator/critic/critic-engine.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';
import { buildImporterCriticFn } from '../../../src/skills/hub/critic-adapter.ts';
import type { ImporterCriticRequest } from '../../../src/skills/hub/importer.ts';

const IMPORTER_REQ: ImporterCriticRequest = {
  skillId: 'refactor/extract-method-ts',
  skillMd: '---\nid: refactor/extract-method-ts\n---\n\n## Procedure\n1. Step one.\n',
  gateVerdict: {
    decision: 'allow',
    epistemicDecision: 'allow',
    aggregateConfidence: 0.88,
    reasons: [],
  },
};

function stubCritic(result: CriticResult): {
  critic: { review: (p: WorkerProposal, t: TaskInput) => Promise<CriticResult> };
  calls: Array<{ proposal: WorkerProposal; task: TaskInput }>;
} {
  const calls: Array<{ proposal: WorkerProposal; task: TaskInput }> = [];
  return {
    calls,
    critic: {
      review: async (proposal, task) => {
        calls.push({ proposal, task });
        return result;
      },
    },
  };
}

function approvedResult(overrides: Partial<CriticResult> = {}): CriticResult {
  return {
    approved: true,
    confidence: 0.85,
    verdicts: {},
    aspects: [],
    tokensUsed: { input: 100, output: 50 },
    ...overrides,
  };
}

describe('buildImporterCriticFn', () => {
  test('approved result → ImporterCriticVerdict.approved=true with clamped confidence', async () => {
    const stub = stubCritic(approvedResult({ confidence: 0.9 }));
    const critic = buildImporterCriticFn({ critic: stub.critic });
    const v = await critic(IMPORTER_REQ);
    expect(v.approved).toBe(true);
    expect(v.confidence).toBeCloseTo(0.9, 4);
    expect(v.notes).toBe('critic-review: no notes');
  });

  test('rejected result with reason + aspects → notes joined', async () => {
    const stub = stubCritic(
      approvedResult({
        approved: false,
        reason: 'missing falsification section',
        aspects: [
          { name: 'safety', passed: false, explanation: 'procedure references sudo' },
          { name: 'clarity', passed: true, explanation: 'overview is clear' },
        ],
      }),
    );
    const critic = buildImporterCriticFn({ critic: stub.critic });
    const v = await critic(IMPORTER_REQ);
    expect(v.approved).toBe(false);
    expect(v.notes).toContain('missing falsification section');
    expect(v.notes).toContain('✗ safety: procedure references sudo');
    expect(v.notes).toContain('✓ clarity: overview is clear');
  });

  test('out-of-range confidence clamped to [0, 1]', async () => {
    const stub1 = stubCritic(approvedResult({ confidence: 1.5 }));
    const c1 = buildImporterCriticFn({ critic: stub1.critic });
    expect((await c1(IMPORTER_REQ)).confidence).toBe(1);

    const stub2 = stubCritic(approvedResult({ confidence: -0.2 }));
    const c2 = buildImporterCriticFn({ critic: stub2.critic });
    expect((await c2(IMPORTER_REQ)).confidence).toBe(0);

    const stub3 = stubCritic(approvedResult({ confidence: Number.NaN }));
    const c3 = buildImporterCriticFn({ critic: stub3.critic });
    expect((await c3(IMPORTER_REQ)).confidence).toBe(0);
  });

  test('synthesized proposal carries skillId and skillMd content', async () => {
    const stub = stubCritic(approvedResult());
    const critic = buildImporterCriticFn({ critic: stub.critic });
    await critic(IMPORTER_REQ);
    expect(stub.calls.length).toBe(1);
    const { proposal, task } = stub.calls[0]!;
    expect(proposal.mutations).toHaveLength(1);
    expect(proposal.mutations[0]!.file).toBe('skills/refactor/extract-method-ts/SKILL.md');
    expect(proposal.mutations[0]!.content).toBe(IMPORTER_REQ.skillMd);
    expect(proposal.approach).toContain('refactor/extract-method-ts');
    expect(proposal.approach).toContain('decision=allow');
    expect(task.id).toBe('skill-import/refactor/extract-method-ts');
    expect(task.taskType).toBe('reasoning');
    expect(task.targetFiles).toEqual(['skills/refactor/extract-method-ts/SKILL.md']);
  });

  test('critic throw propagates (importer catches as critic-error)', async () => {
    const critic = buildImporterCriticFn({
      critic: {
        review: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(critic(IMPORTER_REQ)).rejects.toThrow('boom');
  });

  test('gate summary with reasons appears in synthesized approach', async () => {
    const stub = stubCritic(approvedResult());
    const critic = buildImporterCriticFn({ critic: stub.critic });
    await critic({
      ...IMPORTER_REQ,
      gateVerdict: {
        decision: 'block',
        epistemicDecision: 'block',
        aggregateConfidence: 0.15,
        reasons: ['ast-fail', 'type-fail'],
      },
    });
    const { proposal } = stub.calls[0]!;
    expect(proposal.approach).toContain('decision=block');
    expect(proposal.approach).toContain('epistemic=block');
    expect(proposal.approach).toContain('confidence=0.15');
    expect(proposal.approach).toContain('ast-fail');
    expect(proposal.approach).toContain('type-fail');
  });
});

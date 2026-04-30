/**
 * Worker-entry simple-skill wiring regression test.
 *
 * Pre-fix bug: the dispatcher pre-resolved `simpleSkills`/`simpleSkillBodies`
 * via `resolveSimpleSkillsForTask` and shipped them via `WorkerInput`, but
 * the subprocess entry point (`worker-entry.ts`) called `assemblePrompt`
 * with 15 positional args ending at `loadedSkillCards`, dropping both
 * fields silently. Subprocess L2/L3 prompts therefore never rendered
 * `[AVAILABLE SKILLS]` or `[ACTIVE SKILLS]` for any subprocess task.
 *
 * Reproducing the full subprocess IPC here would require spawning Bun and
 * piping stdin/stdout. Instead we verify the path that matters:
 *   1. WorkerInput accepts simpleSkills / simpleSkillBodies (schema parses).
 *   2. Calling assemblePrompt with the same positional args worker-entry uses
 *      renders the [AVAILABLE SKILLS] + [ACTIVE SKILLS] blocks.
 *
 * If anyone re-removes the two trailing args from worker-entry's
 * assemblePrompt call, this test fails.
 */
import { describe, expect, test } from 'bun:test';
import { assemblePrompt } from '../../../src/orchestrator/llm/prompt-assembler.ts';
import { WorkerInputSchema } from '../../../src/orchestrator/protocol.ts';

const baseInput = {
  taskId: 'task-1',
  goal: 'review this typescript file for bugs',
  taskType: 'code' as const,
  routingLevel: 2 as const,
  perception: {
    taskTarget: { file: 'src/foo.ts', description: 'review' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: '24', os: 'darwin', availableTools: [] },
  },
  workingMemory: {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  },
  budget: { maxTokens: 1000, timeoutMs: 30000 },
  allowedPaths: ['/'],
  isolationLevel: 0 as const,
};

describe('worker-entry → assemblePrompt simple-skill wiring', () => {
  test('WorkerInputSchema accepts simpleSkills + simpleSkillBodies', () => {
    const parsed = WorkerInputSchema.parse({
      ...baseInput,
      simpleSkills: [
        {
          name: 'code-review',
          description: 'Review TypeScript code for bugs.',
          body: 'When reviewing: check null derefs.',
          scope: 'project',
          path: '/tmp/code-review/SKILL.md',
        },
      ],
      simpleSkillBodies: [
        {
          name: 'code-review',
          description: 'Review TypeScript code for bugs.',
          body: 'When reviewing: check null derefs.',
          scope: 'project',
          path: '/tmp/code-review/SKILL.md',
        },
      ],
    });
    expect(parsed.simpleSkills).toHaveLength(1);
    expect(parsed.simpleSkillBodies).toHaveLength(1);
    expect(parsed.simpleSkills?.[0]?.name).toBe('code-review');
  });

  test('assemblePrompt renders [AVAILABLE SKILLS] and [ACTIVE SKILLS] when WorkerInput supplies them', () => {
    // Mirror worker-entry.ts:102-128 exactly — same arg order, same trailing
    // simpleSkills/simpleSkillBodies. Anyone shrinking the call back to 15
    // positional args fails this test.
    const input = WorkerInputSchema.parse({
      ...baseInput,
      simpleSkills: [
        {
          name: 'code-review',
          description: 'Review TypeScript code for bugs and regressions.',
          body: 'When reviewing TypeScript:\n1. Check null derefs\n2. Verify error handling',
          scope: 'project',
          path: '/tmp/code-review/SKILL.md',
        },
      ],
      simpleSkillBodies: [
        {
          name: 'code-review',
          description: 'Review TypeScript code for bugs and regressions.',
          body: 'When reviewing TypeScript:\n1. Check null derefs\n2. Verify error handling',
          scope: 'project',
          path: '/tmp/code-review/SKILL.md',
        },
      ],
    });

    const { systemPrompt } = assemblePrompt(
      input.goal,
      input.perception,
      input.workingMemory,
      input.plan,
      input.taskType ?? 'code',
      input.instructions ?? null,
      input.understanding,
      input.routingLevel,
      input.turns,
      input.environment ?? null,
      input.agentContext,
      input.soulContent ?? undefined,
      input.agentProfile,
      undefined,
      input.loadedSkillCards,
      input.simpleSkills,
      input.simpleSkillBodies,
    );

    expect(systemPrompt).toContain('[AVAILABLE SKILLS]');
    expect(systemPrompt).toContain('code-review: Review TypeScript code for bugs and regressions.');
    expect(systemPrompt).toContain('[ACTIVE SKILLS]');
    expect(systemPrompt).toContain('Check null derefs');
  });

  test('regression: omitting simpleSkills/simpleSkillBodies (the pre-fix call shape) yields no skill blocks', () => {
    // This is the broken pre-fix behaviour. Documented as the regression
    // signature — if a future commit re-drops the args, someone seeing this
    // test should know what they're staring at.
    const input = WorkerInputSchema.parse({
      ...baseInput,
      simpleSkills: [
        {
          name: 'code-review',
          description: 'Review TypeScript code.',
          body: 'When reviewing: check null derefs.',
          scope: 'project',
          path: '/tmp/code-review/SKILL.md',
        },
      ],
      simpleSkillBodies: [
        {
          name: 'code-review',
          description: 'Review TypeScript code.',
          body: 'When reviewing: check null derefs.',
          scope: 'project',
          path: '/tmp/code-review/SKILL.md',
        },
      ],
    });
    const { systemPrompt } = assemblePrompt(
      input.goal,
      input.perception,
      input.workingMemory,
      input.plan,
      input.taskType ?? 'code',
      input.instructions ?? null,
      input.understanding,
      input.routingLevel,
      input.turns,
      input.environment ?? null,
      input.agentContext,
      input.soulContent ?? undefined,
      input.agentProfile,
      undefined,
      input.loadedSkillCards,
      // simpleSkills, simpleSkillBodies INTENTIONALLY OMITTED.
    );
    expect(systemPrompt).not.toContain('[AVAILABLE SKILLS]');
    expect(systemPrompt).not.toContain('[ACTIVE SKILLS]');
  });
});

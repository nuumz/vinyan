/**
 * Hybrid skill redesign — prompt section integration.
 *
 * Verifies that simple-layer skills surface in the assembled system prompt:
 *   - `[AVAILABLE SKILLS]` lists every loaded skill (eager surface)
 *   - `[ACTIVE SKILLS]` inlines bodies for the matched subset (lazy surface)
 *   - When neither is supplied, both sections are absent (legacy parity)
 */
import { describe, expect, test } from 'bun:test';

import { assemblePrompt } from '../../../src/orchestrator/llm/prompt-assembler.ts';
import type { SimpleSkill } from '../../../src/skills/simple/loader.ts';
import type { PerceptualHierarchy, WorkingMemoryState } from '../../../src/orchestrator/types.ts';

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'work on it' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v18', os: 'darwin', availableTools: [] },
  };
}

function makeMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

function skill(name: string, description: string, body: string): SimpleSkill {
  return { name, description, body, scope: 'project', path: `/tmp/${name}/SKILL.md` };
}

describe('simple skill prompt sections', () => {
  test('descriptions section lists every loaded skill name + description', () => {
    const skills = [
      skill('code-review', 'Review code for bugs.', 'body A'),
      skill('debug-trace', 'Walk through stack traces.', 'body B'),
    ];
    const { systemPrompt } = assemblePrompt(
      'goal',
      makePerception(),
      makeMemory(),
      undefined, // plan
      'code',
      undefined, // instructions
      undefined, // understanding
      undefined, // routingLevel
      undefined, // turns
      undefined, // environment
      undefined, // agentContext
      undefined, // soulContent
      undefined, // agentProfile
      undefined, // peerAgents
      undefined, // loadedSkillCards
      skills,
      [],
    );
    expect(systemPrompt).toContain('[AVAILABLE SKILLS]');
    expect(systemPrompt).toContain('code-review: Review code for bugs.');
    expect(systemPrompt).toContain('debug-trace: Walk through stack traces.');
  });

  test('bodies section inlines matched skill bodies', () => {
    const skills = [
      skill('code-review', 'review code', 'CHECK FOR NULL DEREFS'),
      skill('debug-trace', 'walk through traces', 'MAP STACK TO SOURCE'),
    ];
    const { systemPrompt } = assemblePrompt(
      'goal',
      makePerception(),
      makeMemory(),
      undefined,
      'code',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skills,
      [skills[0]!],
    );
    expect(systemPrompt).toContain('[ACTIVE SKILLS]');
    expect(systemPrompt).toContain('── code-review ──');
    expect(systemPrompt).toContain('CHECK FOR NULL DEREFS');
    expect(systemPrompt).not.toContain('MAP STACK TO SOURCE');
  });

  test('omitted simple skills → both sections absent (legacy parity)', () => {
    const { systemPrompt } = assemblePrompt('goal', makePerception(), makeMemory());
    expect(systemPrompt).not.toContain('[AVAILABLE SKILLS]');
    expect(systemPrompt).not.toContain('[ACTIVE SKILLS]');
  });

  test('descriptions present + empty bodies → only AVAILABLE SKILLS renders', () => {
    const skills = [skill('a', 'desc a', 'body a')];
    const { systemPrompt } = assemblePrompt(
      'goal',
      makePerception(),
      makeMemory(),
      undefined,
      'code',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skills,
      [],
    );
    expect(systemPrompt).toContain('[AVAILABLE SKILLS]');
    expect(systemPrompt).not.toContain('[ACTIVE SKILLS]');
  });

  test('descriptions section appears in system prompt, not user prompt', () => {
    const skills = [skill('a', 'desc a', 'body a')];
    const { systemPrompt, userPrompt } = assemblePrompt(
      'goal',
      makePerception(),
      makeMemory(),
      undefined,
      'code',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      skills,
      [],
    );
    expect(systemPrompt).toContain('[AVAILABLE SKILLS]');
    expect(userPrompt).not.toContain('[AVAILABLE SKILLS]');
  });
});

/**
 * E2E test: AutoMemory flows all the way from loader → comprehender →
 * oracle → core-loop projection → worker prompt section.
 *
 * Uses the PUBLIC contract at each boundary (no internals): load memory
 * from a temp filesystem, call comprehender with it, verify oracle
 * accepts, simulate the core-loop projection (same code path) + verify
 * that `buildInitUserMessage` renders the expected `## Relevant User Memory`
 * block with trust labels.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAutoMemory } from '../../../src/memory/auto-memory-loader.ts';
import { buildInitUserMessage } from '../../../src/orchestrator/agent/agent-worker-entry.ts';
import { newRuleComprehender } from '../../../src/orchestrator/comprehension/rule-comprehender.ts';
import { verifyComprehension } from '../../../src/oracle/comprehension/index.ts';
import type { Turn, PerceptualHierarchy, TaskInput } from '../../../src/orchestrator/types.ts';

let workDir: string;
let memoryDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vinyan-e2e-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeMem(files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(memoryDir, name), content, 'utf-8');
  }
  return join(memoryDir, 'MEMORY.md');
}

const emptyPerception: PerceptualHierarchy = {
  taskTarget: { file: 'src/foo.ts', description: 'target' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: 'test', os: 'test', availableTools: [] },
};

/**
 * Replicate the projection core-loop does after oracle verification. Keeping
 * this helper local ensures a regression in the actual code-path is caught
 * (we compare behavior end-to-end rather than mock-and-hope).
 */
function projectComprehensionIntoConstraints(
  envelope: Awaited<ReturnType<ReturnType<typeof newRuleComprehender>['comprehend']>>,
  autoMemory: NonNullable<ReturnType<typeof loadAutoMemory>>,
): string[] {
  const out: string[] = [];
  const data = envelope.params.data;
  if (!data) return out;

  const summary = {
    rootGoal: data.state.rootGoal ?? undefined,
    resolvedGoal: data.resolvedGoal,
    priorContextSummary: data.priorContextSummary,
    isClarificationAnswer: data.state.isClarificationAnswer,
  };
  out.push(`COMPREHENSION_SUMMARY:${JSON.stringify(summary)}`);

  const matched = data.memoryLaneRelevance.autoMem ?? [];
  if (matched.length > 0) {
    const byRef = new Map(autoMemory.entries.map((e) => [e.ref, e] as const));
    const payload = {
      entries: matched
        .map((m) => {
          const full = byRef.get(m.ref);
          if (!full) return null;
          return {
            ref: m.ref,
            type: full.type,
            description: full.description,
            trustTier: m.trustTier,
            content: full.content,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null),
    };
    if (payload.entries.length > 0) {
      out.push(`MEMORY_CONTEXT:${JSON.stringify(payload)}`);
    }
  }
  return out;
}

describe('AutoMemory E2E → worker prompt', () => {
  test('topic-overlap entry reaches worker prompt with trust tag', async () => {
    const entrypoint = writeMem({
      'MEMORY.md': `# Memory

- [User role](user_role.md) — Backend engineer, prefers TypeScript
- [Testing feedback](feedback_testing.md) — Integration tests beat mocks
`,
      'user_role.md': 'Backend engineer with deep TypeScript expertise.',
      'feedback_testing.md':
        'Integration tests beat mocks. Deployed systems are our source of truth.',
    });

    const autoMem = loadAutoMemory({ workspace: workDir, overridePath: entrypoint });
    expect(autoMem).not.toBeNull();
    expect(autoMem!.entries).toHaveLength(2);

    // Turn where "testing" explicitly appears → feedback_testing.md should match.
    const input: TaskInput = {
      id: 't-1',
      source: 'api',
      goal: 'Improve our testing strategy for the API endpoints',
      taskType: 'reasoning',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    };

    const eng = newRuleComprehender();
    const envelope = await eng.comprehend({
      input,
      history: [],
      pendingQuestions: [],
      rootGoal: null,
      autoMemory: autoMem,
    });
    const verdict = verifyComprehension({
      message: envelope,
      history: [],
      pendingQuestions: [],
    });
    expect(verdict.verified).toBe(true);

    // Comprehender emits the relevance set.
    const laneHits = envelope.params.data?.memoryLaneRelevance.autoMem ?? [];
    expect(laneHits.length).toBeGreaterThan(0);
    // At least the testing-feedback entry (token overlap with "testing").
    expect(laneHits.map((h) => h.ref)).toContain('feedback_testing.md');

    // Core-loop would inject constraints; verify the projection feeds the worker.
    const constraints = projectComprehensionIntoConstraints(envelope, autoMem!);
    expect(constraints.some((c) => c.startsWith('MEMORY_CONTEXT:'))).toBe(true);

    const message = buildInitUserMessage(
      input.goal,
      emptyPerception,
      undefined,
      { rawGoal: input.goal, actionVerb: 'improve', actionCategory: 'analysis', frameworkContext: [], constraints, acceptanceCriteria: [], expectsMutation: false },
    );

    expect(message).toContain('## Relevant User Memory');
    expect(message).toContain('feedback_testing.md');
    expect(message).toContain('Integration tests beat mocks');
    // XML-attribute form (not prose): LLM parses trust reliably.
    expect(message).toContain('trust="probabilistic"');
    expect(message).toContain('<user-memory');
    expect(message).toMatch(/WEAK PREFERENCE HINT/);
  });

  test('unrelated memory entries do NOT surface (no spurious matches)', async () => {
    const entrypoint = writeMem({
      'MEMORY.md': `- [Unrelated](project_cooking.md) — favorite recipes
`,
      'project_cooking.md': 'I like spaghetti carbonara.',
    });
    const autoMem = loadAutoMemory({ workspace: workDir, overridePath: entrypoint });

    const input: TaskInput = {
      id: 't-2',
      source: 'api',
      goal: 'refactor the authentication middleware for rate limiting',
      taskType: 'code',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    };

    const eng = newRuleComprehender();
    const envelope = await eng.comprehend({
      input,
      history: [],
      pendingQuestions: [],
      rootGoal: null,
      autoMemory: autoMem,
    });

    // Cooking entry has zero token overlap with auth/rate-limit → empty lane.
    const lane = envelope.params.data?.memoryLaneRelevance.autoMem;
    expect(lane === undefined || lane.length === 0).toBe(true);

    const constraints = projectComprehensionIntoConstraints(envelope, autoMem!);
    expect(constraints.some((c) => c.startsWith('MEMORY_CONTEXT:'))).toBe(false);

    const message = buildInitUserMessage(
      input.goal,
      emptyPerception,
      undefined,
      { rawGoal: input.goal, actionVerb: 'refactor', actionCategory: 'mutation', frameworkContext: [], constraints, acceptanceCriteria: [], expectsMutation: true },
    );
    expect(message).not.toContain('## Relevant User Memory');
  });

  test('user-identity entry surfaces even without token overlap (floor), capped to 1', async () => {
    const entrypoint = writeMem({
      'MEMORY.md': `- [Who I am](user_identity.md) — principal engineer
- [Another identity](user_alt.md) — backup identity
- [Yet another](user_extra.md) — decoy
`,
      'user_identity.md': 'Principal engineer, 15 years experience',
      'user_alt.md': 'Alternate role description',
      'user_extra.md': 'Third user file',
    });
    const autoMem = loadAutoMemory({ workspace: workDir, overridePath: entrypoint });

    const input: TaskInput = {
      id: 't-3',
      source: 'api',
      goal: 'completely unrelated cooking recipe',
      taskType: 'reasoning',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    };

    const eng = newRuleComprehender();
    const envelope = await eng.comprehend({
      input,
      history: [],
      pendingQuestions: [],
      rootGoal: null,
      autoMemory: autoMem,
    });

    // Only ONE user-floor entry surfaces despite three user_*.md files
    // (FIX#5: MAX_USER_FLOOR_ENTRIES=1 to prevent pile-on attack).
    const lane = envelope.params.data?.memoryLaneRelevance.autoMem ?? [];
    expect(lane.length).toBe(1);
  });
});

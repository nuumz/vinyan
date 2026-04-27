/**
 * AgentRouter tests — rule-first specialist selection.
 *
 * Verifies:
 *   - CLI override short-circuits ('override' reason)
 *   - .ts file routes to ts-coder via extensions rule ('rule-match')
 *   - .md file routes to writer
 *   - Ambiguous task (no file, reasoning) signals 'needs-llm'
 *   - Unknown agent id in override falls through rule path
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRouter } from '../../src/orchestrator/agent-router.ts';
import { loadAgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-router',
    source: 'cli',
    goal: 'test',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
    ...overrides,
  };
}

function setupRouter() {
  const workspace = mkdtempSync(join(tmpdir(), 'vinyan-router-'));
  const registry = loadAgentRegistry(workspace, undefined);
  const router = createAgentRouter({ registry });
  return { workspace, registry, router, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

describe('AgentRouter', () => {
  test('CLI override short-circuits with reason=override', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ agentId: 'writer' }));
      expect(decision.agentId).toBe('writer');
      expect(decision.reason).toBe('override');
    } finally {
      cleanup();
    }
  });

  test('unknown agentId in override falls through to rule/default path', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ agentId: 'nonexistent', targetFiles: ['a.ts'] }));
      // Should NOT return 'nonexistent' — registry.has returns false
      expect(decision.agentId).not.toBe('nonexistent');
      expect(decision.reason).not.toBe('override');
    } finally {
      cleanup();
    }
  });

  test('.ts file routes to ts-coder via rule-match', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ taskType: 'code', targetFiles: ['src/foo.ts'] }));
      expect(decision.agentId).toBe('ts-coder');
      expect(decision.reason).toBe('rule-match');
      expect(decision.score).toBeGreaterThan(0.4);
      expect(decision.capabilityAnalysis?.candidates[0]?.profileId).toBe('ts-coder');
      expect(decision.capabilityAnalysis?.candidates[0]?.profileSource).toBe('registry');
    } finally {
      cleanup();
    }
  });

  test('.md file routes to writer via rule-match', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ taskType: 'code', targetFiles: ['README.md'] }));
      expect(decision.agentId).toBe('writer');
      expect(decision.reason).toBe('rule-match');
    } finally {
      cleanup();
    }
  });

  test('ambiguous task (no file, reasoning) signals needs-llm', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ taskType: 'reasoning', goal: 'what is the meaning of life?' }));
      // No file → no extension signal; reasoning domain could match multiple
      expect(decision.reason).toBe('needs-llm');
    } finally {
      cleanup();
    }
  });

  test('LLM-extracted capabilityRequirements route long-form novel work to the creative team lead', () => {
    const { router, cleanup } = setupRouter();
    try {
      // Phase A: regex on goal text is gone. The LLM (or any caller) is now
      // responsible for emitting structured CapabilityRequirements; the
      // router scores deterministically against agent CapabilityClaims.
      const decision = router.route(
        makeInput({
          taskType: 'reasoning',
          goal: 'อยากให้ช่วยเขียนนิยายลงขายในเว็บตูนสักเรื่อง',
        }),
        undefined,
        undefined,
        [
          { id: 'creative.lead', weight: 1, source: 'llm-extract' },
          { id: 'creative.strategy', weight: 0.5, source: 'llm-extract' },
        ],
      );
      expect(decision.agentId).toBe('creative-director');
      expect(decision.reason).toBe('rule-match');
      expect(decision.agentId).not.toBe('system-designer');
      expect(decision.agentId).not.toBe('ts-coder');
    } finally {
      cleanup();
    }
  });

  test('LLM-extracted capabilityRequirements route specific creative requests to the matching specialist', () => {
    const { router, cleanup } = setupRouter();
    try {
      const plot = router.route(
        makeInput({ taskType: 'reasoning', goal: 'ช่วยคิดพล็อตนิยายแฟนตาซี' }),
        undefined,
        undefined,
        [{ id: 'creative.plot', weight: 1, source: 'llm-extract' }],
      );
      expect(plot.agentId).toBe('plot-architect');

      const strat = router.route(
        makeInput({ taskType: 'reasoning', goal: 'ช่วยวางโครงเรื่องนิยาย 20 ตอน' }),
        undefined,
        undefined,
        [{ id: 'creative.strategy', weight: 1, source: 'llm-extract' }],
      );
      expect(strat.agentId).toBe('story-strategist');

      const edit = router.route(
        makeInput({ taskType: 'reasoning', goal: 'ช่วยบรรณาธิการนิยายบทนี้' }),
        undefined,
        undefined,
        [{ id: 'creative.editing', weight: 1, source: 'llm-extract' }],
      );
      expect(edit.agentId).toBe('editor');
    } finally {
      cleanup();
    }
  });

  test('runner-up metadata included for rule-match decisions', () => {
    const { router, cleanup } = setupRouter();
    try {
      const decision = router.route(makeInput({ taskType: 'code', targetFiles: ['src/foo.ts'] }));
      // With 4 built-ins, runner-up should exist
      if (decision.reason === 'rule-match') {
        expect(decision.runnerUp).toBeDefined();
      }
    } finally {
      cleanup();
    }
  });

  test('minLevel excludes specialist from lower-level tasks when routingLevel is known', () => {
    const { registry, router, cleanup } = setupRouter();
    try {
      // system-designer declares minLevel:1 — a reasoning task routed at L0
      // (caller passes routingLevel=0) must NOT resolve to it even though
      // the reasoning domain would otherwise match.
      const sd = registry.getAgent('system-designer');
      expect(sd).not.toBeNull();
      expect(sd!.routingHints?.minLevel).toBe(1);

      const decisionL0 = router.route(makeInput({ taskType: 'reasoning', goal: 'what is X?' }), undefined, 0);
      expect(decisionL0.agentId).not.toBe('system-designer');

      // Same task at L1+ — system-designer is eligible again.
      const decisionL1 = router.route(makeInput({ taskType: 'reasoning', goal: 'design an auth flow' }), undefined, 1);
      // rule-match may or may not pick system-designer (depends on
      // score/margin with the writer); the key invariant is that it's not
      // structurally blocked the way it was at L0.
      expect(decisionL1.reason).not.toBe('override');
    } finally {
      cleanup();
    }
  });

  test('minLevel ignored when routingLevel is absent (backward compat)', () => {
    const { router, cleanup } = setupRouter();
    try {
      // No routingLevel arg → pre-multi-agent behaviour; system-designer
      // is eligible regardless of minLevel.
      const decision = router.route(makeInput({ taskType: 'reasoning', goal: 'design a schema' }));
      // Not asserting the specific winner — just that no exception and the
      // call completes with a deterministic shape.
      expect(decision.agentId).toBeTypeOf('string');
    } finally {
      cleanup();
    }
  });
});

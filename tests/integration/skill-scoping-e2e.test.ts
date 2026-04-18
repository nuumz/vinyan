/**
 * Phase 3 bug fix — E2E verification of agent-scoped skill lookup.
 *
 * The bug: factory-constructed SkillManager had no agentId, so every task
 * queried the global pool regardless of `input.agentId`. The fix threads
 * agentId per-call at `core-loop.ts:1315` and into `SkillManager.match()`.
 *
 * This test exercises the production wiring (factory → orchestrator.skillManager
 * → skill-store) — not the direct-construction path covered by unit tests.
 *
 * Scenarios:
 *   (A) Agent-owned skill is returned when the calling agent owns it.
 *   (B) Same signature with a DIFFERENT agent's skill: caller with no matching
 *       agent gets null (no cross-agent contamination, no legacy fallback).
 *   (C) Legacy shared skill (agent_id IS NULL) is visible to any agent as fallback.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../../src/core/bus.ts';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import { createScriptedMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import type { CachedSkill } from '../../src/orchestrator/types.ts';

function seedSkill(overrides: Partial<CachedSkill>): CachedSkill {
  return {
    taskSignature: 'sig',
    approach: 'approach',
    successRate: 0.9,
    status: 'active',
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.2,
    depConeHashes: {},
    lastVerifiedAt: Date.now(),
    verificationProfile: 'structural',
    origin: 'local',
    ...overrides,
  };
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-skill-e2e-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function bootstrap() {
  // Mock registry with a noop provider — factory requires at least one LLM
  // provider for some deps but SkillManager path doesn't call LLM.
  const registry = new LLMProviderRegistry();
  registry.register(
    createScriptedMockProvider([{ content: '{}', stopReason: 'end_turn' }], { id: 'mock/test', tier: 'fast' }),
  );
  const bus = createBus();
  const orchestrator = createOrchestrator({
    workspace: tempDir,
    registry,
    bus,
    useSubprocess: false,
    watchWorkspace: false,
  });
  return { orchestrator, bus };
}

describe('Phase 3 E2E — SkillManager agent scoping via factory', () => {
  test('factory-constructed SkillManager is available', () => {
    const { orchestrator } = bootstrap();
    expect(orchestrator.skillManager).toBeDefined();
    expect(orchestrator.skillStore).toBeDefined();
  });

  test('(A) agent-owned skill is returned when caller agent matches', () => {
    const { orchestrator } = bootstrap();
    const store = orchestrator.skillStore!;
    const mgr = orchestrator.skillManager!;

    store.insert(
      seedSkill({ taskSignature: 'task-a::src/foo.ts', approach: 'ts-coder strategy', agentId: 'ts-coder' }),
    );

    const match = mgr.match('task-a::src/foo.ts', 'ts-coder');
    expect(match).not.toBeNull();
    expect(match!.approach).toBe('ts-coder strategy');
    expect(match!.agentId).toBe('ts-coder');
  });

  test('(B) cross-agent isolation — writer cannot see ts-coder-owned skill', () => {
    const { orchestrator } = bootstrap();
    const store = orchestrator.skillStore!;
    const mgr = orchestrator.skillManager!;

    store.insert(
      seedSkill({ taskSignature: 'task-b::src/foo.ts', approach: 'ts-coder private', agentId: 'ts-coder' }),
    );

    // writer has no owned skill and no legacy fallback for this signature → null
    const writerMatch = mgr.match('task-b::src/foo.ts', 'writer');
    expect(writerMatch).toBeNull();

    // ts-coder sees it
    const tsMatch = mgr.match('task-b::src/foo.ts', 'ts-coder');
    expect(tsMatch).not.toBeNull();
    expect(tsMatch!.approach).toBe('ts-coder private');
  });

  test('(C) legacy shared skill (agent_id NULL) visible as fallback to any agent', () => {
    const { orchestrator } = bootstrap();
    const store = orchestrator.skillStore!;
    const mgr = orchestrator.skillManager!;

    // No agentId → stored as agent_id NULL (shared)
    store.insert(seedSkill({ taskSignature: 'task-c::*', approach: 'shared baseline' }));

    const asTs = mgr.match('task-c::*', 'ts-coder');
    expect(asTs?.approach).toBe('shared baseline');

    const asWriter = mgr.match('task-c::*', 'writer');
    expect(asWriter?.approach).toBe('shared baseline');

    const asUnknown = mgr.match('task-c::*');
    expect(asUnknown?.approach).toBe('shared baseline');
  });

  test('createFromPattern with agentId stores agent-owned skill', () => {
    const { orchestrator } = bootstrap();
    const mgr = orchestrator.skillManager!;
    const store = orchestrator.skillStore!;

    const pattern = {
      id: 'pattern-1',
      type: 'success-pattern' as const,
      description: 'repeated extract-method success',
      frequency: 5,
      confidence: 0.9,
      taskTypeSignature: 'pattern-sig',
      approach: 'extract method',
      sourceTraceIds: ['t-1', 't-2'],
      createdAt: Date.now(),
      decayWeight: 1,
    };

    mgr.createFromPattern(pattern, 0.3, {}, 'ts-coder');

    // Scoping by agent returns the new skill
    const owned = store.findBySignature('pattern-sig', 'ts-coder');
    expect(owned).not.toBeNull();
    expect(owned!.agentId).toBe('ts-coder');

    // Different agent doesn't see it
    const otherAgent = store.findBySignature('pattern-sig', 'writer');
    expect(otherAgent).toBeNull();
  });

  test('createFromPattern without agentId stores shared skill (legacy semantics)', () => {
    const { orchestrator } = bootstrap();
    const mgr = orchestrator.skillManager!;
    const store = orchestrator.skillStore!;

    const pattern = {
      id: 'pattern-2',
      type: 'success-pattern' as const,
      description: 'fleet-wide pattern',
      frequency: 5,
      confidence: 0.9,
      taskTypeSignature: 'fleet-sig',
      approach: 'shared approach',
      sourceTraceIds: [],
      createdAt: Date.now(),
      decayWeight: 1,
    };

    mgr.createFromPattern(pattern, 0.3, {});

    const row = store.findBySignature('fleet-sig');
    expect(row).not.toBeNull();
    expect(row!.agentId).toBeUndefined();

    // Still fallback-accessible by any agent
    const asTs = store.findBySignature('fleet-sig', 'ts-coder');
    expect(asTs?.approach).toBe('shared approach');
  });
});

/**
 * Item 4 (Phase-14) — A1 enforcement at agent-loop's delegation surface.
 *
 * Mirrors `tests/orchestrator/workflow/workflow-executor-a1.test.ts` for the
 * parallel dispatch path. When the LLM agent calls the delegate tool with a
 * verify-style goal on a code-mutation parent, `handleDelegation` must
 * force the canonical Verifier persona (overriding any caller-supplied
 * `targetAgentId`) and emit `delegation:a1_verifier_routed`.
 */
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../../src/core/agent-vocabulary.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../../../src/core/bus.ts';
import { AgentBudgetTracker } from '../../../src/orchestrator/agent/agent-budget.ts';
import { handleDelegation } from '../../../src/orchestrator/agent/agent-loop.ts';
import type { AgentLoopDeps } from '../../../src/orchestrator/agent/agent-loop.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import { DelegationRouter } from '../../../src/orchestrator/delegation-router.ts';
import type { DelegationRequest } from '../../../src/orchestrator/protocol.ts';
import type { RoutingDecision, TaskInput, TaskResult } from '../../../src/orchestrator/types.ts';

function makeParent(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'parent-a1',
    source: 'cli',
    goal: 'parent code task',
    taskType: 'code',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 200_000, maxDurationMs: 60_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'mock/sonnet',
    budgetTokens: 200_000,
    latencyBudgetMs: 60_000,
  };
}

function makeBudget(): AgentBudgetTracker {
  return AgentBudgetTracker.fromRouting(makeRouting(), 200_000);
}

function makeChildResult(id: string): TaskResult {
  return {
    id,
    status: 'completed',
    mutations: [],
    trace: {
      id: `trace-${id}`,
      taskId: id,
      timestamp: 0,
      routingLevel: 2,
      approach: 'sub',
      oracleVerdicts: {},
      modelUsed: 'mock',
      tokensConsumed: 100,
      durationMs: 10,
      outcome: 'success',
      affectedFiles: [],
    },
    answer: 'sub-result',
  };
}

function makeRegistry() {
  const ws = mkdtempSync(join(tmpdir(), 'vinyan-a1-aloop-'));
  return { reg: loadAgentRegistry(ws, undefined), cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

interface Harness {
  bus: ReturnType<typeof createBus>;
  events: Array<{ event: string; payload: unknown }>;
  capturedSubInputs: TaskInput[];
  deps: AgentLoopDeps;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const { reg, cleanup } = makeRegistry();
  const bus = createBus();
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.on('delegation:a1_verifier_routed', (p) => events.push({ event: 'delegation:a1_verifier_routed', payload: p }));
  const capturedSubInputs: TaskInput[] = [];
  const deps: AgentLoopDeps = {
    workspace: '/tmp',
    delegationRouter: new DelegationRouter(),
    bus,
    agentRegistry: reg,
    executeTask: async (subInput: TaskInput) => {
      capturedSubInputs.push(subInput);
      return makeChildResult(subInput.id);
    },
  } as AgentLoopDeps;
  return { bus, events, capturedSubInputs, deps, cleanup };
}

describe('Item 4 — handleDelegation A1 verifier routing', () => {
  test('code parent + verify goal → forces canonical verifier', async () => {
    const h = makeHarness();
    try {
      const request: DelegationRequest = {
        goal: 'review the implementation for correctness',
        targetFiles: ['src/foo.ts'],
        requestedTokens: 5000,
      };
      const result = await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), h.deps);
      expect(result.status).toBe('success');
      expect(h.capturedSubInputs).toHaveLength(1);
      expect(h.capturedSubInputs[0]!.agentId).toBe(asPersonaId('reviewer'));
      expect(h.events).toHaveLength(1);
      const ev = h.events[0]!.payload as { verifierAgentId: string; parentAgentId: string | null };
      expect(ev.verifierAgentId).toBe('reviewer');
    } finally {
      h.cleanup();
    }
  });

  test('A1 override beats caller-supplied targetAgentId', async () => {
    const h = makeHarness();
    try {
      const request: DelegationRequest = {
        goal: 'audit the patch',
        targetFiles: ['src/foo.ts'],
        requestedTokens: 5000,
        targetAgentId: asPersonaId('developer'),
      };
      await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), h.deps);
      expect(h.capturedSubInputs[0]!.agentId).toBe(asPersonaId('reviewer'));
      const ev = h.events[0]!.payload as { requestedTargetAgentId: string | null };
      expect(ev.requestedTargetAgentId).toBe('developer');
    } finally {
      h.cleanup();
    }
  });

  test('non-code parent + verify goal → no override', async () => {
    const h = makeHarness();
    try {
      const request: DelegationRequest = {
        goal: 'review the essay',
        targetFiles: [],
        requestedTokens: 5000,
      };
      await handleDelegation(
        request,
        makeParent({ taskType: 'reasoning' }),
        makeBudget(),
        makeRouting(),
        h.deps,
      );
      expect(h.capturedSubInputs[0]!.agentId).toBeUndefined();
      expect(h.events).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test('code parent + non-verify goal → no override', async () => {
    const h = makeHarness();
    try {
      const request: DelegationRequest = {
        goal: 'extract a helper function',
        targetFiles: ['src/foo.ts'],
        requestedTokens: 5000,
      };
      await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), h.deps);
      expect(h.capturedSubInputs[0]!.agentId).toBeUndefined();
      expect(h.events).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test('parent already running as reviewer → no override (no self-route)', async () => {
    const h = makeHarness();
    try {
      const request: DelegationRequest = {
        goal: 'verify the patch',
        targetFiles: ['src/foo.ts'],
        requestedTokens: 5000,
      };
      await handleDelegation(
        request,
        makeParent({ agentId: asPersonaId('reviewer') }),
        makeBudget(),
        makeRouting(),
        h.deps,
      );
      // No override → either undefined (default) or whatever was requested,
      // never 'reviewer' from the A1 path. The event must not fire.
      expect(h.events).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test('agentRegistry omitted → no override (legacy path safe)', async () => {
    const h = makeHarness();
    try {
      // Strip the registry to simulate a legacy / minimal setup.
      const depsNoRegistry = { ...h.deps, agentRegistry: undefined };
      const request: DelegationRequest = {
        goal: 'review the implementation',
        targetFiles: ['src/foo.ts'],
        requestedTokens: 5000,
      };
      await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), depsNoRegistry);
      expect(h.capturedSubInputs[0]!.agentId).toBeUndefined();
      expect(h.events).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('R4 — delegation:capability_token_issued bus event', () => {
  test('every delegated sub-task emits a token-issuance event with policy details', async () => {
    const h = makeHarness();
    const tokenEvents: Array<{
      parentTaskId: string;
      childTaskId: string;
      tokenId: string;
      subagentType: 'explore' | 'plan' | 'general-purpose';
      allowedTools: readonly string[];
      forbiddenTools: readonly string[];
      allowedPaths: readonly string[];
      issuedAt: number;
      expiresAt: number;
    }> = [];
    h.bus.on('delegation:capability_token_issued', (p) => tokenEvents.push(p));
    try {
      const request: DelegationRequest = {
        goal: 'extract a helper function',
        targetFiles: ['src/foo.ts'],
        subagentType: 'general-purpose',
        requiredTools: ['file_read', 'file_edit'],
        requestedTokens: 5000,
      };
      await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), h.deps);
      expect(tokenEvents).toHaveLength(1);
      const ev = tokenEvents[0]!;
      expect(ev.parentTaskId).toBe('parent-a1');
      expect(ev.childTaskId).toMatch(/^parent-a1-child-/);
      expect(ev.tokenId).toMatch(/^capability-token:[0-9a-f]{16}$/);
      expect(ev.subagentType).toBe('general-purpose');
      expect(ev.allowedTools).toEqual(['file_read', 'file_edit']);
      // general-purpose floor forbids shell_exec + delegate_task.
      expect(ev.forbiddenTools).toContain('shell_exec');
      expect(ev.forbiddenTools).toContain('delegate_task');
      expect(ev.allowedPaths).toEqual(['src/foo.ts']);
      expect(ev.expiresAt).toBeGreaterThan(ev.issuedAt);
    } finally {
      h.cleanup();
    }
  });

  test('explore role emits a read-only token (no path scoping, all mutations forbidden)', async () => {
    const h = makeHarness();
    const tokenEvents: Array<{
      subagentType: 'explore' | 'plan' | 'general-purpose';
      allowedPaths: readonly string[];
      forbiddenTools: readonly string[];
    }> = [];
    h.bus.on('delegation:capability_token_issued', (p) =>
      tokenEvents.push({
        subagentType: p.subagentType,
        allowedPaths: p.allowedPaths,
        forbiddenTools: p.forbiddenTools,
      }),
    );
    try {
      const request: DelegationRequest = {
        goal: 'survey imports',
        targetFiles: ['src/foo.ts'],
        subagentType: 'explore',
        requestedTokens: 5000,
      };
      await handleDelegation(request, makeParent(), makeBudget(), makeRouting(), h.deps);
      expect(tokenEvents).toHaveLength(1);
      expect(tokenEvents[0]!.subagentType).toBe('explore');
      expect(tokenEvents[0]!.allowedPaths).toEqual([]);
      expect(tokenEvents[0]!.forbiddenTools).toContain('file_write');
      expect(tokenEvents[0]!.forbiddenTools).toContain('file_edit');
      expect(tokenEvents[0]!.forbiddenTools).toContain('shell_exec');
    } finally {
      h.cleanup();
    }
  });
});

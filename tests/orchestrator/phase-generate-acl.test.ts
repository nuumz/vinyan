/**
 * Phase-generate ACL test — verify agent ACL overlay intersects at dispatch time.
 *
 * This is an indirect test through createContract (the actual integration
 * point). The phase-generate call site passes `agentAcl` to createContract;
 * we verify the resulting contract respects the overlay.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContract } from '../../src/core/agent-contract.ts';
import { loadAgentRegistry } from '../../src/orchestrator/agents/registry.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';

function makeTask(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-acl',
    source: 'cli',
    goal: 'write the README',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeRouting(level: 0 | 1 | 2 | 3): RoutingDecision {
  return {
    level,
    model: null,
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
}

describe('phase-generate ACL overlay (integration via createContract)', () => {
  test("writer's capabilityOverrides.shell=false denies shell_exec at L2", () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acl-'));
    try {
      const registry = loadAgentRegistry(ws, undefined);
      const writer = registry.getAgent('writer');
      expect(writer).not.toBeNull();
      expect(writer!.capabilityOverrides?.shell).toBe(false);

      // Simulate phase-generate's call
      const acl = {
        allowedTools: writer!.allowedTools,
        capabilityOverrides: writer!.capabilityOverrides,
      };
      const contract = createContract(makeTask({ agentId: 'writer' }), makeRouting(2), acl);

      expect(contract.capabilities.some((c) => c.type === 'shell_exec')).toBe(false);
      expect(contract.capabilities.some((c) => c.type === 'shell_read')).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('ts-coder keeps full shell access at L2 (no ACL restrictions)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acl-'));
    try {
      const registry = loadAgentRegistry(ws, undefined);
      const tsCoder = registry.getAgent('ts-coder');
      const acl = tsCoder?.capabilityOverrides || tsCoder?.allowedTools
        ? { allowedTools: tsCoder.allowedTools, capabilityOverrides: tsCoder.capabilityOverrides }
        : undefined;
      const contract = createContract(makeTask({ agentId: 'ts-coder' }), makeRouting(2), acl);

      expect(contract.capabilities.some((c) => c.type === 'shell_exec')).toBe(true);
      expect(contract.capabilities.some((c) => c.type === 'file_write')).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('no agent (no ACL) → default L2 capabilities unchanged', () => {
    const contract = createContract(makeTask(), makeRouting(2));
    expect(contract.capabilities.some((c) => c.type === 'shell_exec')).toBe(true);
    expect(contract.capabilities.some((c) => c.type === 'file_write')).toBe(true);
  });

  test('secretary denies writeAny at L2', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acl-'));
    try {
      const registry = loadAgentRegistry(ws, undefined);
      const secretary = registry.getAgent('secretary');
      const acl = {
        allowedTools: secretary!.allowedTools,
        capabilityOverrides: secretary!.capabilityOverrides,
      };
      const contract = createContract(makeTask({ agentId: 'secretary' }), makeRouting(2), acl);

      expect(contract.capabilities.some((c) => c.type === 'file_write')).toBe(false);
      // Reads still allowed
      expect(contract.capabilities.some((c) => c.type === 'file_read')).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

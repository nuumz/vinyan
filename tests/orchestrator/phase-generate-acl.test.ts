/**
 * Phase-generate ACL test — verify agent ACL overlay intersects at dispatch time.
 *
 * Runs across the role-pure persona roster:
 *   - author has shell:false, network:false → denies shell_exec at L2
 *   - developer has no ACL restrictions → keeps full code-mutation access
 *   - assistant has writeAny:false → denies file_write
 */
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
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
  test("author's capabilityOverrides.shell=false denies shell_exec at L2", () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acl-'));
    try {
      const registry = loadAgentRegistry(ws, undefined);
      const author = registry.getAgent('author');
      expect(author).not.toBeNull();
      expect(author!.capabilityOverrides?.shell).toBe(false);

      const acl = {
        allowedTools: author!.allowedTools,
        capabilityOverrides: author!.capabilityOverrides,
      };
      const contract = createContract(makeTask({ agentId: asPersonaId('author') }), makeRouting(2), acl);

      expect(contract.capabilities.some((c) => c.type === 'shell_exec')).toBe(false);
      expect(contract.capabilities.some((c) => c.type === 'shell_read')).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('developer keeps full shell access at L2 (no ACL restrictions)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acl-'));
    try {
      const registry = loadAgentRegistry(ws, undefined);
      const developer = registry.getAgent('developer');
      expect(developer).not.toBeNull();
      const acl =
        developer?.capabilityOverrides || developer?.allowedTools
          ? { allowedTools: developer!.allowedTools, capabilityOverrides: developer!.capabilityOverrides }
          : undefined;
      const contract = createContract(makeTask({ agentId: asPersonaId('developer') }), makeRouting(2), acl);

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

  test('assistant denies writeAny at L2', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-acl-'));
    try {
      const registry = loadAgentRegistry(ws, undefined);
      const assistant = registry.getAgent('assistant');
      expect(assistant).not.toBeNull();
      const acl = {
        allowedTools: assistant!.allowedTools,
        capabilityOverrides: assistant!.capabilityOverrides,
      };
      const contract = createContract(makeTask({ agentId: asPersonaId('assistant') }), makeRouting(2), acl);

      expect(contract.capabilities.some((c) => c.type === 'file_write')).toBe(false);
      // Reads still allowed
      expect(contract.capabilities.some((c) => c.type === 'file_read')).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

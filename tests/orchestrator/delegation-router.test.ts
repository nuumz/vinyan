import { describe, expect, it } from 'bun:test';
import type { AgentBudget, DelegationRequest } from '../../src/orchestrator/protocol.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/worker/agent-budget.ts';
import { DelegationRouter, buildSubTaskInput } from '../../src/orchestrator/delegation-router.ts';

function makeBudget(overrides: Partial<AgentBudget> = {}): AgentBudget {
  return {
    maxTokens: 10000,
    maxTurns: 30,
    maxDurationMs: 60_000,
    contextWindow: 128_000,
    base: 6000,
    negotiable: 2500,
    delegation: 1500,
    maxExtensionRequests: 3,
    maxToolCallsPerTurn: 10,
    delegationDepth: 0,
    maxDelegationDepth: 2,
    ...overrides,
  };
}

function makeParent(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-parent-1',
    source: 'cli',
    goal: 'Fix the bug',
    targetFiles: ['src/foo.ts', 'src/bar.ts'],
    budget: { maxTokens: 10000, maxDurationMs: 60_000, maxRetries: 3 },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    goal: 'Refactor helper',
    targetFiles: ['src/foo.ts'],
    ...overrides,
  };
}

function makeRouting(level: 0 | 1 | 2 | 3 = 2): RoutingDecision {
  return {
    level,
    model: 'claude-sonnet',
    budgetTokens: 10000,
    latencyBudgetMs: 30000,
  };
}

describe('DelegationRouter', () => {
  const router = new DelegationRouter();

  describe('canDelegate', () => {
    it('R1: blocks when delegation depth limit reached', () => {
      const budget = new AgentBudgetTracker(
        makeBudget({ delegationDepth: 3, maxDelegationDepth: 3 }),
      );
      const result = router.canDelegate(makeRequest(), budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('depth');
      expect(result.allocatedTokens).toBe(0);
    });

    it('R1: blocks when no delegation budget remaining', () => {
      const budget = new AgentBudgetTracker(
        makeBudget({ delegation: 0 }),
      );
      const result = router.canDelegate(makeRequest(), budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.allocatedTokens).toBe(0);
    });

    it('R2: blocks when child files are out of parent scope', () => {
      const budget = new AgentBudgetTracker(makeBudget());
      const request = makeRequest({ targetFiles: ['src/secret.ts'] });
      const parent = makeParent({ targetFiles: ['src/foo.ts'] });

      const result = router.canDelegate(request, budget, parent);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('out of parent scope');
      expect(result.reason).toContain('src/secret.ts');
    });

    it('R2: allows when parent has no targetFiles (unrestricted scope)', () => {
      const budget = new AgentBudgetTracker(makeBudget());
      const request = makeRequest({ targetFiles: ['anywhere/file.ts'] });
      const parent = makeParent({ targetFiles: [] });

      const result = router.canDelegate(request, budget, parent);

      expect(result.allowed).toBe(true);
    });

    it('R4: blocks when delegation budget below minimum viable', () => {
      const budget = new AgentBudgetTracker(
        makeBudget({ delegation: 500 }), // below 1000 minimum
      );
      const result = router.canDelegate(makeRequest(), budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Insufficient delegation budget');
    });

    it('R6: blocks shell_exec in required tools', () => {
      const budget = new AgentBudgetTracker(makeBudget());
      const request = makeRequest({ requiredTools: ['file_read', 'shell_exec'] });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('shell_exec');
      expect(result.reason).toContain('R6');
    });

    it('approves valid delegation with sufficient budget and in-scope files', () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        targetFiles: ['src/foo.ts'],
        requestedTokens: 2000,
      });
      const parent = makeParent({ targetFiles: ['src/foo.ts', 'src/bar.ts'] });

      const result = router.canDelegate(request, budget, parent);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('Delegation approved');
      expect(result.allocatedTokens).toBeGreaterThan(0);
    });

    it('caps allocation at 50% of remaining delegation budget', () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 10000 }));
      const request = makeRequest({ requestedTokens: 8000 });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(true);
      // min(8000, 10000 * 0.5) = 5000
      expect(result.allocatedTokens).toBe(5000);
    });

    it('uses default budget when requestedTokens not specified', () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 20000 }));
      const request = makeRequest(); // no requestedTokens → defaults to 8000

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(true);
      // min(8000, 20000 * 0.5) = 8000
      expect(result.allocatedTokens).toBe(8000);
    });
  });
});

describe('buildSubTaskInput', () => {
  it('creates correct child input from parent and request', () => {
    const request: DelegationRequest = {
      goal: 'Refactor helper',
      targetFiles: ['src/foo.ts'],
    };
    const parent = makeParent({ id: 'parent-42', source: 'cli' });
    const routing = makeRouting(2);
    const childBudget = makeBudget({ maxTokens: 3000, maxDurationMs: 15000 });

    const result = buildSubTaskInput(request, parent, routing, childBudget);

    expect(result.id).toContain('parent-42-child-');
    expect(result.source).toBe('cli');
    expect(result.goal).toBe('Refactor helper');
    expect(result.targetFiles).toEqual(['src/foo.ts']);
    expect(result.budget.maxTokens).toBe(3000);
    expect(result.budget.maxDurationMs).toBe(15000);
    expect(result.budget.maxRetries).toBe(1);
  });

  it('does not inherit parent priorAttempts or constraints', () => {
    const request: DelegationRequest = {
      goal: 'Sub-task',
      targetFiles: ['src/a.ts'],
    };
    const parent = makeParent({ constraints: ['no-refactor'] });
    const result = buildSubTaskInput(request, parent, makeRouting(), makeBudget());

    // Child should not have parent's constraints
    expect(result.constraints).toBeUndefined();
  });
});

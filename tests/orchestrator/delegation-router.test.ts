import { describe, expect, it } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/agent/agent-budget.ts';
import { buildSubTaskInput, DelegationRouter } from '../../src/orchestrator/delegation-router.ts';
import type { AgentBudget, DelegationRequest } from '../../src/orchestrator/protocol.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';

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
    maxToolCalls: 20,
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
    taskType: 'code',
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
      const budget = new AgentBudgetTracker(makeBudget({ delegationDepth: 3, maxDelegationDepth: 3 }));
      const result = router.canDelegate(makeRequest(), budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('depth');
      expect(result.allocatedTokens).toBe(0);
    });

    it('R1: blocks when no delegation budget remaining', () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 0 }));
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

  // ── Phase 7c-1: typed subagent gating ────────────────────────────

  describe('typed subagent roles (Phase 7c-1)', () => {
    it("R2 exemption: 'explore' subagent allowed to walk outside parent scope", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      // Explore is read-only, so out-of-scope reads are safe.
      const request = makeRequest({
        subagentType: 'explore',
        targetFiles: ['src/completely/unrelated.ts'],
      });
      const parent = makeParent({ targetFiles: ['src/foo.ts'] });

      const result = router.canDelegate(request, budget, parent);

      expect(result.allowed).toBe(true);
    });

    it("R2 exemption: 'plan' subagent allowed to walk outside parent scope", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        subagentType: 'plan',
        targetFiles: ['src/other/module.ts'],
      });
      const parent = makeParent({ targetFiles: ['src/foo.ts'] });

      const result = router.canDelegate(request, budget, parent);

      expect(result.allowed).toBe(true);
    });

    it("R2 still enforced for 'general-purpose' subagent", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        subagentType: 'general-purpose',
        targetFiles: ['src/secret.ts'],
      });
      const parent = makeParent({ targetFiles: ['src/foo.ts'] });

      const result = router.canDelegate(request, budget, parent);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('out of parent scope');
    });

    it("R7: 'explore' cannot request file_write", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        subagentType: 'explore',
        requiredTools: ['file_read', 'file_write'],
      });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
      expect(result.reason).toContain('file_write');
    });

    it("R7: 'plan' cannot request file_edit / file_patch / file_delete", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        subagentType: 'plan',
        requiredTools: ['file_edit'],
      });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
      expect(result.reason).toContain('file_edit');
    });

    it("R7: 'explore' cannot re-delegate via delegate_task", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        subagentType: 'explore',
        requiredTools: ['delegate_task'],
      });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });

    it("R7 does NOT block 'general-purpose' from requesting file_write", () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      const request = makeRequest({
        subagentType: 'general-purpose',
        requiredTools: ['file_write'],
      });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(true);
    });

    it('read-only role scope exemption does not override R6 shell_exec block', () => {
      const budget = new AgentBudgetTracker(makeBudget({ delegation: 5000 }));
      // shell_exec is in MUTATION_TOOLS, so it fails R7 before reaching R6 — but
      // it MUST be blocked one way or another. Assert the request is denied.
      const request = makeRequest({
        subagentType: 'explore',
        requiredTools: ['shell_exec'],
      });

      const result = router.canDelegate(request, budget, makeParent());

      expect(result.allowed).toBe(false);
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

  // Phase 7c-1: subagentType plumbing
  it("defaults missing subagentType to 'general-purpose'", () => {
    const request: DelegationRequest = {
      goal: 'Sub-task',
      targetFiles: ['src/foo.ts'],
    };
    const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    expect(result.subagentType).toBe('general-purpose');
  });

  it("propagates explicit 'explore' subagentType and forces reasoning taskType", () => {
    const request: DelegationRequest = {
      goal: 'Survey the codebase',
      targetFiles: ['src/foo.ts'],
      subagentType: 'explore',
    };
    const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    expect(result.subagentType).toBe('explore');
    // Read-only roles always run as reasoning so the prompt assembler picks
    // the reasoning registry path instead of the code/mutation one.
    expect(result.taskType).toBe('reasoning');
  });

  it("propagates 'plan' subagentType and forces reasoning taskType", () => {
    const request: DelegationRequest = {
      goal: 'Design the migration',
      targetFiles: ['src/foo.ts'],
      subagentType: 'plan',
    };
    const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    expect(result.subagentType).toBe('plan');
    expect(result.taskType).toBe('reasoning');
  });

  it("'general-purpose' keeps code taskType when targetFiles present", () => {
    const request: DelegationRequest = {
      goal: 'Refactor',
      targetFiles: ['src/foo.ts'],
      subagentType: 'general-purpose',
    };
    const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    expect(result.subagentType).toBe('general-purpose');
    expect(result.taskType).toBe('code');
  });

  // Parent-linkage propagation tests (round 4 fix). Without these the
  // child loses observability + sessionId routing + explicit agent
  // selection — silent multi-agent dispatch failures.
  it('propagates parent.id to child.parentTaskId so trees can be reconstructed', () => {
    const parent = makeParent({ id: 'task-parent-XYZ' });
    const result = buildSubTaskInput(makeRequest(), parent, makeRouting(), makeBudget());
    expect(result.parentTaskId).toBe('task-parent-XYZ');
  });

  it('inherits parent.sessionId so child events route to the same chat surface', () => {
    const parent = makeParent({ sessionId: 'sess-abc' });
    const result = buildSubTaskInput(makeRequest(), parent, makeRouting(), makeBudget());
    expect(result.sessionId).toBe('sess-abc');
  });

  it('omits sessionId when parent has none (no spurious empty string)', () => {
    const parent = makeParent({ sessionId: undefined });
    const result = buildSubTaskInput(makeRequest(), parent, makeRouting(), makeBudget());
    expect(result.sessionId).toBeUndefined();
  });

  it('forwards request.targetAgentId as child.agentId — the multi-agent dispatch hook', () => {
    const request: DelegationRequest = {
      goal: 'Architect-only task',
      targetFiles: [],
      targetAgentId: asPersonaId('architect'),
    };
    const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
    expect(result.agentId).toBe(asPersonaId('architect'));
  });

  it('omits agentId when no targetAgentId requested (fall through to default routing)', () => {
    const result = buildSubTaskInput(makeRequest(), makeParent(), makeRouting(), makeBudget());
    expect(result.agentId).toBeUndefined();
  });

  // R4 — capability token issuance (closes the runtime delegation gap).
  describe('capability token issuance', () => {
    it("explore: token forbids mutation tools, allowedPaths empty (read-only walks freely)", () => {
      const request: DelegationRequest = {
        goal: 'Survey imports',
        targetFiles: ['src/foo.ts', 'src/bar.ts'],
        subagentType: 'explore',
      };
      const parent = makeParent({ id: 'task-explore-parent' });
      const childBudget = makeBudget({ maxDurationMs: 30_000 });

      const result = buildSubTaskInput(request, parent, makeRouting(), childBudget);

      expect(result.capabilityToken).toBeDefined();
      const token = result.capabilityToken!;
      expect(token.subagentType).toBe('explore');
      expect(token.parentTaskId).toBe('task-explore-parent');
      // Default policy: explore forbids every mutation tool.
      expect(token.forbiddenTools).toContain('file_write');
      expect(token.forbiddenTools).toContain('file_edit');
      expect(token.forbiddenTools).toContain('shell_exec');
      expect(token.forbiddenTools).toContain('delegate_task');
      // Path scoping is intentionally absent for read-only roles.
      expect(token.allowedPaths).toEqual([]);
      // TTL aligned to child wall-clock budget (A9 + A10 grounding).
      expect(token.expiresAt - token.issuedAt).toBe(30_000);
    });

    it('plan: same forbid policy as explore', () => {
      const request: DelegationRequest = {
        goal: 'Plan migration',
        targetFiles: ['src/foo.ts'],
        subagentType: 'plan',
      };
      const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());
      expect(result.capabilityToken!.subagentType).toBe('plan');
      expect(result.capabilityToken!.forbiddenTools).toContain('file_write');
      expect(result.capabilityToken!.allowedPaths).toEqual([]);
    });

    it('general-purpose: allowedPaths matches request.targetFiles, mutation forbids relaxed', () => {
      const request: DelegationRequest = {
        goal: 'Implement helper',
        targetFiles: ['src/foo.ts', 'src/bar.ts'],
        subagentType: 'general-purpose',
        requiredTools: ['file_read', 'file_write', 'file_edit'],
      };
      const result = buildSubTaskInput(request, makeParent(), makeRouting(), makeBudget());

      const token = result.capabilityToken!;
      expect(token.subagentType).toBe('general-purpose');
      expect(token.allowedTools).toEqual(['file_read', 'file_write', 'file_edit']);
      expect(token.allowedPaths).toEqual(['src/foo.ts', 'src/bar.ts']);
      // general-purpose still forbids shell_exec + delegate_task by default
      // (the floor policy in issueCapabilityToken).
      expect(token.forbiddenTools).toContain('shell_exec');
      expect(token.forbiddenTools).toContain('delegate_task');
      // ...but does NOT forbid file_write — this role can mutate.
      expect(token.forbiddenTools).not.toContain('file_write');
    });

    it("provenance carries the delegation rationale for replay (A8)", () => {
      const request: DelegationRequest = {
        goal: 'Refactor helper module',
        targetFiles: ['src/foo.ts'],
        subagentType: 'general-purpose',
        requiredTools: ['file_edit'],
        requestedTokens: 5000,
        context: 'Resolved clarifications: keep alias=no',
      };
      const parent = makeParent({ id: 'parent-XYZ' });
      const result = buildSubTaskInput(request, parent, makeRouting(), makeBudget());

      const prov = result.capabilityToken!.provenance as Record<string, unknown>;
      expect(prov).toBeDefined();
      expect(prov.reason).toBe('sub-task-delegation');
      expect(prov.parentTaskId).toBe('parent-XYZ');
      expect(prov.subagentType).toBe('general-purpose');
      expect(prov.goal).toBe('Refactor helper module');
      expect(prov.requiredTools).toEqual(['file_edit']);
      expect(prov.targetFiles).toEqual(['src/foo.ts']);
      expect(prov.requestedTokens).toBe(5000);
      expect(prov.context).toBe('Resolved clarifications: keep alias=no');
    });

    it('issuedBy identifies the router for audit attribution', () => {
      const result = buildSubTaskInput(makeRequest(), makeParent(), makeRouting(), makeBudget());
      expect(result.capabilityToken!.issuedBy).toBe('delegation-router');
    });

    it('always issues a token (no silent undefined on the delegated path)', () => {
      // Even with the most minimal request, a token must be produced —
      // missing token on the delegated path is forbidden by spec.
      const result = buildSubTaskInput(
        { goal: 'noop', targetFiles: [] },
        makeParent(),
        makeRouting(),
        makeBudget(),
      );
      expect(result.capabilityToken).toBeDefined();
    });
  });
});

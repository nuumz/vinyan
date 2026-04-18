/**
 * Integration tests for K1 contract + tool authorization wiring.
 *
 * Verifies that createContract → AgentBudgetTracker → authorizeToolCall
 * behave consistently as an integrated system across all routing levels.
 *
 * Unit-level tests for individual components live in:
 *   tests/core/agent-contract.test.ts
 *   tests/security/tool-authorization.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { AgentContract } from '../../src/core/agent-contract.ts';
import { createContract } from '../../src/core/agent-contract.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';
import { AgentBudgetTracker } from '../../src/orchestrator/agent/agent-budget.ts';
import { authorizeToolCall } from '../../src/security/tool-authorization.ts';

// ── Shared helpers ───────────────────────────────────────────────────

const BASE_TASK: TaskInput = {
  id: 'k1-wiring-test',
  source: 'cli',
  goal: 'Integration test task',
  taskType: 'code',
  budget: { maxTokens: 50_000, maxRetries: 3, maxDurationMs: 60_000 },
};

function makeRouting(level: 0 | 1 | 2 | 3): RoutingDecision {
  return {
    level,
    model: level === 0 ? null : 'test-model',
    budgetTokens: level * 25_000,
    latencyBudgetMs: level * 15_000,
  };
}

function contractAt(level: 0 | 1 | 2 | 3): AgentContract {
  return createContract(BASE_TASK, makeRouting(level));
}

/**
 * Determines whether a contract's violation policy mandates kill given
 * the current accumulated violation count.
 *
 * - 'kill' policy: kill on first violation (violations > 0)
 * - 'warn_then_kill' policy: warn until tolerance exceeded (violations > tolerance)
 */
function shouldKill(contract: AgentContract, violations: number): boolean {
  if (violations === 0) return false;
  if (contract.onViolation === 'kill') return true;
  return violations > contract.violationTolerance;
}

// ── Suite 1: Contract creation from routing ─────────────────────────

describe('Suite 1: Contract creation from routing', () => {
  test('L0 contract: empty capabilities, zero tool calls, kill policy, immutable', () => {
    const contract = contractAt(0);
    expect(contract.capabilities).toHaveLength(0);
    expect(contract.maxToolCalls).toBe(0);
    expect(contract.onViolation).toBe('kill');
    expect(contract.violationTolerance).toBe(0);
    expect(contract.routingLevel).toBe(0);
    expect(contract.immutable).toBe(true);
  });

  test('L1 contract: 2 capabilities (file_read + shell_read), 5 tool calls, kill policy, immutable', () => {
    const contract = contractAt(1);
    expect(contract.capabilities).toHaveLength(2);
    const types = contract.capabilities.map((c) => c.type);
    expect(types).toContain('file_read');
    expect(types).toContain('shell_read');
    expect(contract.maxToolCalls).toBe(5);
    expect(contract.onViolation).toBe('kill');
    expect(contract.violationTolerance).toBe(0);
    expect(contract.routingLevel).toBe(1);
    expect(contract.immutable).toBe(true);
  });

  test('L2 contract: 6 capabilities (incl. mcp_call), 20 tool calls, warn_then_kill, tolerance 2, immutable', () => {
    const contract = contractAt(2);
    // Phase 7e added `mcp_call` to the default L2 capability set.
    expect(contract.capabilities).toHaveLength(6);
    const types = contract.capabilities.map((c) => c.type);
    expect(types).toContain('file_read');
    expect(types).toContain('file_write');
    expect(types).toContain('shell_exec');
    expect(types).toContain('shell_read');
    expect(types).toContain('llm_call');
    expect(types).toContain('mcp_call');
    expect(contract.maxToolCalls).toBe(20);
    expect(contract.onViolation).toBe('warn_then_kill');
    expect(contract.violationTolerance).toBe(2);
    expect(contract.routingLevel).toBe(2);
    expect(contract.immutable).toBe(true);
  });

  test('L3 contract: 6 capabilities (incl. mcp_call), 50 tool calls, warn_then_kill, tolerance 2, immutable', () => {
    const contract = contractAt(3);
    expect(contract.capabilities).toHaveLength(6);
    const types = contract.capabilities.map((c) => c.type);
    expect(types).toContain('mcp_call');
    expect(contract.maxToolCalls).toBe(50);
    expect(contract.onViolation).toBe('warn_then_kill');
    expect(contract.violationTolerance).toBe(2);
    expect(contract.routingLevel).toBe(3);
    expect(contract.immutable).toBe(true);
  });
});

// ── Suite 2: Budget from contract ────────────────────────────────────

describe('Suite 2: Budget from contract', () => {
  test('fromContract produces tracker with correct remainingToolCalls', () => {
    const contract = contractAt(2);
    const tracker = AgentBudgetTracker.fromContract(contract);
    expect(tracker.remainingToolCalls).toBe(20);
  });

  test('canContinue() is true on a freshly created tracker', () => {
    const contract = contractAt(2);
    const tracker = AgentBudgetTracker.fromContract(contract);
    expect(tracker.canContinue()).toBe(true);
  });

  test('fromContract and fromRouting produce equivalent maxToolCalls for same level', () => {
    for (const level of [0, 1, 2, 3] as const) {
      const routing = makeRouting(level);
      const contract = createContract(BASE_TASK, routing);
      const fromRouting = AgentBudgetTracker.fromRouting(routing, 128_000);
      const fromContract = AgentBudgetTracker.fromContract(contract, 128_000);
      expect(fromContract.remainingToolCalls).toBe(fromRouting.remainingToolCalls);
    }
  });
});

// ── Suite 3: Tool authorization enforcement ──────────────────────────

describe('Suite 3: Tool authorization enforcement', () => {
  test('L0: read_file denied (empty capabilities)', () => {
    const result = authorizeToolCall(contractAt(0), 'read_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(false);
    expect(result.violation).toBeDefined();
  });

  test('L0: write_file denied (empty capabilities)', () => {
    const result = authorizeToolCall(contractAt(0), 'write_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(false);
  });

  test('L1: read_file allowed', () => {
    const result = authorizeToolCall(contractAt(1), 'read_file', { path: 'src/any/path.ts' });
    expect(result.authorized).toBe(true);
  });

  test('L1: write_file denied (no file_write capability)', () => {
    const result = authorizeToolCall(contractAt(1), 'write_file', { path: 'src/foo.ts' });
    expect(result.authorized).toBe(false);
    expect(result.violation).toContain('file_write');
  });

  test('L2: write_file in src/** allowed', () => {
    const result = authorizeToolCall(contractAt(2), 'write_file', { path: 'src/core/foo.ts' });
    expect(result.authorized).toBe(true);
  });

  test('L2: write_file in tests/** allowed', () => {
    const result = authorizeToolCall(contractAt(2), 'write_file', { path: 'tests/core/foo.test.ts' });
    expect(result.authorized).toBe(true);
  });

  test('L2: write_file in config/** denied (outside workspace scope)', () => {
    const result = authorizeToolCall(contractAt(2), 'write_file', { path: 'config/prod.json' });
    expect(result.authorized).toBe(false);
    expect(result.violation).toBeDefined();
  });

  test('L2: run_command "bun test" allowed (shell_exec, first word "bun")', () => {
    const result = authorizeToolCall(contractAt(2), 'run_command', { command: 'bun test' });
    expect(result.authorized).toBe(true);
  });

  test('L2: run_command "rm -rf /tmp" denied (shell_exec, "rm" not in [bun,tsc,biome])', () => {
    const result = authorizeToolCall(contractAt(2), 'run_command', { command: 'rm -rf /tmp' });
    expect(result.authorized).toBe(false);
    expect(result.violation).toBeDefined();
  });

  test('L2: run_command "grep foo src/" allowed (shell_read)', () => {
    const result = authorizeToolCall(contractAt(2), 'run_command', { command: 'grep foo src/' });
    expect(result.authorized).toBe(true);
  });

  test('L3: run_command "rm -rf /old-build" allowed (shell_exec with ** wildcard)', () => {
    const result = authorizeToolCall(contractAt(3), 'run_command', { command: 'rm -rf /old-build' });
    expect(result.authorized).toBe(true);
  });

  test('L3: write_file anywhere allowed (file_write with ** wildcard)', () => {
    const result = authorizeToolCall(contractAt(3), 'write_file', { path: 'config/secrets.json' });
    expect(result.authorized).toBe(true);
  });

  test('Unknown tool denied at L0 (zero-trust default)', () => {
    const result = authorizeToolCall(contractAt(0), 'fancy_tool', {});
    expect(result.authorized).toBe(false);
  });

  test('Unknown tool denied at L2 (zero-trust default)', () => {
    const result = authorizeToolCall(contractAt(2), 'fancy_tool', {});
    expect(result.authorized).toBe(false);
    expect(result.violation).toContain('fancy_tool');
  });

  test('Unknown tool at L3: authorized via shell_exec wildcard (L3 grants shell_exec:**)', () => {
    // Unknown tools classify as shell_exec with scope ['UNKNOWN_TOOL'].
    // L3 has shell_exec: ['**'], so the wildcard matches — this is intentional
    // full-access behavior at L3. Zero-trust unknown-tool denial requires L0-L2.
    const result = authorizeToolCall(contractAt(3), 'fancy_tool', {});
    expect(result.authorized).toBe(true);
  });
});

// ── Suite 4: Violation policy ─────────────────────────────────────────

describe('Suite 4: Violation policy', () => {
  test('kill policy (L1 contract): any violation count > 0 triggers kill', () => {
    const contract = contractAt(1);
    expect(contract.onViolation).toBe('kill');
    expect(contract.violationTolerance).toBe(0);

    // tolerance=0 means first violation (count=1) must kill
    expect(shouldKill(contract, 0)).toBe(false); // before any violation
    expect(shouldKill(contract, 1)).toBe(true); // first violation exceeds tolerance=0
    expect(shouldKill(contract, 5)).toBe(true); // higher counts also kill
  });

  test('warn_then_kill policy (L2 contract): violations 1-2 under tolerance, violation 3 exceeds', () => {
    const contract = contractAt(2);
    expect(contract.onViolation).toBe('warn_then_kill');
    expect(contract.violationTolerance).toBe(2);

    // violations 0-2 are within tolerance (warn, not kill)
    expect(shouldKill(contract, 0)).toBe(false);
    expect(shouldKill(contract, 1)).toBe(false);
    expect(shouldKill(contract, 2)).toBe(false);

    // violation 3 exceeds tolerance of 2 → kill
    expect(shouldKill(contract, 3)).toBe(true);
    expect(shouldKill(contract, 10)).toBe(true);
  });

  test('warn_then_kill policy (L3 contract): same tolerance=2 boundary as L2', () => {
    const contract = contractAt(3);
    expect(contract.onViolation).toBe('warn_then_kill');
    expect(contract.violationTolerance).toBe(2);

    expect(shouldKill(contract, 2)).toBe(false);
    expect(shouldKill(contract, 3)).toBe(true);
  });
});

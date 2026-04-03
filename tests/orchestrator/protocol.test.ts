import { describe, expect, test } from 'bun:test';
import {
  IsolationLevelSchema,
  PerceptualHierarchySchema,
  RoutingLevelSchema,
  TaskDAGSchema,
  TaskInputSchema,
  ToolCallSchema,
  ToolResultSchema,
  WorkerInputSchema,
  WorkerOutputSchema,
  WorkingMemoryStateSchema,
} from '../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  TaskDAG,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkerInput,
  WorkerOutput,
  WorkingMemoryState,
} from '../../src/orchestrator/types.ts';
import { ECP_PROTOCOL_VERSION } from '../../src/orchestrator/types.ts';

// ── Factories (typed against TS interfaces to catch drift) ───────────

function makePerception(overrides?: Partial<PerceptualHierarchy>): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'Fix bug' },
    dependencyCone: {
      directImporters: ['src/bar.ts'],
      directImportees: ['src/utils.ts'],
      transitiveBlastRadius: 3,
    },
    diagnostics: {
      lintWarnings: [],
      typeErrors: [],
      failingTests: [],
    },
    verifiedFacts: [],
    runtime: {
      nodeVersion: 'v18.20.8',
      os: 'darwin',
      availableTools: ['write_file', 'read_file'],
    },
    ...overrides,
  };
}

function makeWorkingMemory(overrides?: Partial<WorkingMemoryState>): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
    ...overrides,
  };
}

function makeWorkerInput(overrides?: Partial<WorkerInput>): WorkerInput {
  return {
    taskId: 'task-001',
    goal: 'Fix the type error in foo.ts',
    taskType: 'code' as const,
    routingLevel: 1 as const,
    perception: makePerception(),
    workingMemory: makeWorkingMemory(),
    budget: { maxTokens: 10_000, timeoutMs: 5_000 },
    allowedPaths: ['src/'],
    isolationLevel: 0 as const,
    ...overrides,
  } as WorkerInput;
}

function makeWorkerOutput(overrides?: Partial<WorkerOutput>): WorkerOutput {
  return {
    taskId: 'task-001',
    proposedMutations: [{ file: 'src/foo.ts', content: 'const x = 1;', explanation: 'Fixed type' }],
    proposedToolCalls: [],
    uncertainties: [],
    tokensConsumed: 500,
    durationMs: 1200,
    ...overrides,
  };
}

// ── ECP_PROTOCOL_VERSION ─────────────────────────────────────────────

describe('ECP_PROTOCOL_VERSION', () => {
  test('is 1', () => {
    expect(ECP_PROTOCOL_VERSION).toBe(1);
  });
});

// ── RoutingLevelSchema / IsolationLevelSchema ────────────────────────

describe('RoutingLevelSchema', () => {
  test('accepts 0, 1, 2, 3', () => {
    for (const v of [0, 1, 2, 3] as const) {
      expect(RoutingLevelSchema.parse(v)).toBe(v);
    }
  });

  test('rejects 4', () => {
    expect(() => RoutingLevelSchema.parse(4)).toThrow();
  });

  test('rejects -1', () => {
    expect(() => RoutingLevelSchema.parse(-1)).toThrow();
  });

  test("rejects string '1'", () => {
    expect(() => RoutingLevelSchema.parse('1')).toThrow();
  });
});

describe('IsolationLevelSchema', () => {
  test('accepts 0, 1, 2', () => {
    for (const v of [0, 1, 2] as const) {
      expect(IsolationLevelSchema.parse(v)).toBe(v);
    }
  });

  test('rejects 3', () => {
    expect(() => IsolationLevelSchema.parse(3)).toThrow();
  });
});

// ── ToolCallSchema / ToolResultSchema ────────────────────────────────

describe('ToolCallSchema', () => {
  test('valid tool call → parses', () => {
    const call: ToolCall = { id: 'tc-1', tool: 'write_file', parameters: { path: 'a.ts', content: 'x' } };
    expect(ToolCallSchema.parse(call)).toEqual(call);
  });

  test('nested object parameters → parses', () => {
    const call: ToolCall = { id: 'tc-2', tool: 'api_call', parameters: { body: { key: [1, 2] } } };
    expect(ToolCallSchema.parse(call)).toEqual(call);
  });

  test('missing id → throws', () => {
    expect(() => ToolCallSchema.parse({ tool: 'x', parameters: {} })).toThrow();
  });
});

describe('ToolResultSchema', () => {
  test('success result → parses', () => {
    const result: ToolResult = { callId: 'tc-1', tool: 'write_file', status: 'success', durationMs: 50 };
    expect(ToolResultSchema.parse(result)).toEqual(result);
  });

  test('error result → parses', () => {
    const result: ToolResult = { callId: 'tc-1', tool: 'write_file', status: 'error', error: 'ENOENT', durationMs: 10 };
    expect(ToolResultSchema.parse(result)).toEqual(result);
  });

  test('denied result with evidence → parses', () => {
    const result: ToolResult = {
      callId: 'tc-1',
      tool: 'shell_exec',
      status: 'denied',
      evidence: { file: 'src/x.ts', line: 1, snippet: 'rm -rf' },
      durationMs: 0,
    };
    expect(ToolResultSchema.parse(result)).toEqual(result);
  });

  test('invalid status → throws', () => {
    expect(() => ToolResultSchema.parse({ callId: 'x', tool: 'x', status: 'unknown', durationMs: 0 })).toThrow();
  });
});

// ── TaskInputSchema ──────────────────────────────────────────────────

describe('TaskInputSchema', () => {
  test('valid CLI input → parses', () => {
    const input: TaskInput = {
      id: 't-1',
      source: 'cli',
      goal: 'Fix bug',
      taskType: 'code',
      budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
    };
    expect(TaskInputSchema.parse(input)).toEqual(input);
  });

  test('valid API input with targetFiles → parses', () => {
    const input: TaskInput = {
      id: 't-2',
      source: 'api',
      goal: 'Refactor module',
      taskType: 'code',
      targetFiles: ['src/foo.ts'],
      constraints: ['Do not change public API'],
      budget: { maxTokens: 100_000, maxDurationMs: 120_000, maxRetries: 5 },
    };
    expect(TaskInputSchema.parse(input)).toEqual(input);
  });

  test('mcp source → parses', () => {
    const input: TaskInput = {
      id: 't-3',
      source: 'mcp',
      goal: 'Verify types',
      taskType: 'code',
      budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    };
    expect(TaskInputSchema.parse(input)).toEqual(input);
  });

  test('invalid source → throws', () => {
    expect(() =>
      TaskInputSchema.parse({
        id: 'x',
        source: 'unknown',
        goal: 'x',
        budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 1 },
      }),
    ).toThrow();
  });
});

// ── Composed schemas ─────────────────────────────────────────────────

describe('PerceptualHierarchySchema', () => {
  test('valid hierarchy → parses', () => {
    const ph = makePerception();
    expect(PerceptualHierarchySchema.parse(ph)).toEqual(ph);
  });

  test('with L2+ optional fields → parses', () => {
    const ph = makePerception({
      dependencyCone: {
        directImporters: ['a.ts'],
        directImportees: ['b.ts'],
        transitiveBlastRadius: 5,
        transitiveImporters: ['c.ts', 'd.ts'],
        affectedTestFiles: ['a.test.ts'],
      },
    });
    expect(PerceptualHierarchySchema.parse(ph)).toEqual(ph);
  });

  test('optional symbol in taskTarget → parses', () => {
    const ph = makePerception({
      taskTarget: { file: 'src/foo.ts', symbol: 'MyClass.method', description: 'Fix method' },
    });
    expect(PerceptualHierarchySchema.parse(ph)).toEqual(ph);
  });
});

describe('WorkingMemoryStateSchema', () => {
  test('empty memory → valid', () => {
    const mem = makeWorkingMemory();
    expect(WorkingMemoryStateSchema.parse(mem)).toEqual(mem);
  });

  test('populated memory → parses', () => {
    const mem = makeWorkingMemory({
      failedApproaches: [
        { approach: 'inline function', oracleVerdict: 'type: type error at line 5', timestamp: Date.now() },
      ],
      activeHypotheses: [{ hypothesis: 'extract to utility', confidence: 0.7, source: 'self-model' }],
      unresolvedUncertainties: [{ area: 'test coverage', selfModelConfidence: 0.3, suggestedAction: 'run tests' }],
      scopedFacts: [{ target: 'src/foo.ts', pattern: 'type-check', verified: true, hash: 'abc123' }],
    });
    expect(WorkingMemoryStateSchema.parse(mem)).toEqual(mem);
  });
});

describe('TaskDAGSchema', () => {
  test('valid DAG → parses', () => {
    const dag: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'Step 1', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['ast'] },
        {
          id: 'n2',
          description: 'Step 2',
          targetFiles: ['b.ts'],
          dependencies: ['n1'],
          assignedOracles: ['type', 'dep'],
        },
      ],
    };
    expect(TaskDAGSchema.parse(dag)).toEqual(dag);
  });

  test('empty nodes → valid', () => {
    expect(TaskDAGSchema.parse({ nodes: [] })).toEqual({ nodes: [] });
  });
});

// ── WorkerInputSchema ────────────────────────────────────────────────

describe('WorkerInputSchema', () => {
  test('valid complete input → parses', () => {
    const input = makeWorkerInput({
      plan: {
        nodes: [{ id: 'n1', description: 'Step 1', targetFiles: ['a.ts'], dependencies: [], assignedOracles: ['ast'] }],
      },
    });
    expect(WorkerInputSchema.parse(input)).toEqual(input);
  });

  test('valid input without optional plan → parses', () => {
    const input = makeWorkerInput();
    expect(WorkerInputSchema.parse(input)).toEqual(input);
  });

  test('round-trip: JSON serialize → parse → identical', () => {
    const input = makeWorkerInput();
    const json = JSON.stringify(input);
    const parsed = WorkerInputSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(input);
  });

  test('missing taskId → throws', () => {
    const { taskId: _, ...rest } = makeWorkerInput();
    expect(() => WorkerInputSchema.parse(rest)).toThrow();
  });

  test('invalid routingLevel (4) → throws', () => {
    expect(() => WorkerInputSchema.parse(makeWorkerInput({ routingLevel: 4 as any }))).toThrow();
  });

  test('invalid isolationLevel (3) → throws', () => {
    expect(() => WorkerInputSchema.parse(makeWorkerInput({ isolationLevel: 3 as any }))).toThrow();
  });

  test('negative budget.maxTokens → throws', () => {
    expect(() => WorkerInputSchema.parse(makeWorkerInput({ budget: { maxTokens: -1, timeoutMs: 5000 } }))).toThrow();
  });

  test('empty allowedPaths → valid', () => {
    const input = makeWorkerInput({ allowedPaths: [] });
    expect(WorkerInputSchema.parse(input)).toEqual(input);
  });
});

// ── WorkerOutputSchema ───────────────────────────────────────────────

describe('WorkerOutputSchema', () => {
  test('valid output → parses', () => {
    const output = makeWorkerOutput();
    expect(WorkerOutputSchema.parse(output)).toEqual(output);
  });

  test('round-trip: JSON serialize → parse → identical', () => {
    const output = makeWorkerOutput();
    const json = JSON.stringify(output);
    const parsed = WorkerOutputSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(output);
  });

  test('empty arrays → valid', () => {
    const output = makeWorkerOutput({
      proposedMutations: [],
      proposedToolCalls: [],
      uncertainties: [],
    });
    expect(WorkerOutputSchema.parse(output)).toEqual(output);
  });

  test('with tool calls and uncertainties → parses', () => {
    const output = makeWorkerOutput({
      proposedToolCalls: [{ id: 'tc-1', tool: 'write_file', parameters: { path: 'x.ts' } }],
      uncertainties: ['Not sure about edge case'],
    });
    expect(WorkerOutputSchema.parse(output)).toEqual(output);
  });

  test('missing taskId → throws', () => {
    const { taskId: _, ...rest } = makeWorkerOutput();
    expect(() => WorkerOutputSchema.parse(rest)).toThrow();
  });
});

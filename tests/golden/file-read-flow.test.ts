/**
 * Golden flow — scripted mock agent reads a fixture file and completes.
 *
 * Regression guard for the tool-call → result → attempt_completion loop.
 * Does NOT snapshot output (scheduling metadata is non-deterministic) —
 * asserts shape only: exactly one file_read, one done, file content reaches
 * the `proposedContent`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createScriptedMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { runAgentWorkerLoop, type WorkerIO } from '../../src/orchestrator/agent/agent-worker-entry.ts';
import type { WorkerTurn } from '../../src/orchestrator/protocol.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'tiny-repo');
const FIXTURE_FILE = 'hello.txt';
const FIXTURE_CONTENT = readFileSync(join(FIXTURE_DIR, FIXTURE_FILE), 'utf-8');

function scriptedIO(inputs: string[]): { io: WorkerIO; outputs: string[] } {
  const queue = [...inputs];
  const outputs: string[] = [];
  return {
    io: {
      async readLine() {
        return queue.shift() ?? null;
      },
      writeLine(line) {
        outputs.push(line);
      },
    },
    outputs,
  };
}

function makeInit(): string {
  return JSON.stringify({
    type: 'init',
    taskId: 'golden-file-read',
    goal: `Read ${FIXTURE_FILE} and quote the first line back.`,
    routingLevel: 2,
    perception: {
      taskTarget: { file: FIXTURE_FILE, description: 'fixture' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '22', os: 'linux', availableTools: ['file_read', 'attempt_completion'] },
    },
    workingMemory: {
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    },
    budget: {
      maxTokens: 10000,
      maxTurns: 5,
      maxDurationMs: 30000,
      contextWindow: 128000,
      base: 5000,
      negotiable: 3000,
      delegation: 2000,
      maxExtensionRequests: 1,
      maxToolCallsPerTurn: 5,
      delegationDepth: 0,
      maxDelegationDepth: 1,
    },
    allowedPaths: [FIXTURE_DIR],
    toolManifest: [
      {
        name: 'file_read',
        description: 'Read a file',
        inputSchema: { file_path: { type: 'string' } },
      },
      {
        name: 'attempt_completion',
        description: 'Signal task completion',
        inputSchema: { status: { type: 'string' }, proposedContent: { type: 'string' } },
      },
    ],
  });
}

describe('Golden: file-read flow', () => {
  test('agent loop emits file_read then done with cited content', async () => {
    const provider = createScriptedMockProvider([
      {
        stopReason: 'tool_use',
        content: 'Reading the fixture',
        toolCalls: [{ id: 'tc1', tool: 'file_read', parameters: { file_path: FIXTURE_FILE } }],
      },
      {
        stopReason: 'tool_use',
        content: 'Here is the first line',
        toolCalls: [
          {
            id: 'tc2',
            tool: 'attempt_completion',
            parameters: {
              status: 'done',
              proposedContent: `First line: ${FIXTURE_CONTENT.split('\n')[0]}`,
            },
          },
        ],
      },
    ]);

    const { io, outputs } = scriptedIO([
      makeInit(),
      JSON.stringify({
        type: 'tool_results',
        turnId: 't1',
        results: [
          { callId: 'tc1', tool: 'file_read', output: FIXTURE_CONTENT, status: 'success', durationMs: 1 },
        ],
      }),
    ]);

    await runAgentWorkerLoop(provider, io);

    const turns: WorkerTurn[] = outputs.map((l) => JSON.parse(l));
    expect(turns).toHaveLength(2);
    expect(turns[0]!.type).toBe('tool_calls');
    expect(turns[1]!.type).toBe('done');

    const done = turns[1] as Extract<WorkerTurn, { type: 'done' }>;
    expect(done.proposedContent).toContain('Hello from Vinyan');
  });
});

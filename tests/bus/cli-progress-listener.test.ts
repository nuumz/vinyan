import { describe, expect, test } from 'bun:test';
import { Writable } from 'stream';
import { attachCLIProgressListener } from '../../src/bus/cli-progress-listener.ts';
import { createBus } from '../../src/core/bus.ts';

function createCapture(): { output: string[]; stream: NodeJS.WritableStream } {
  const output: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      callback();
    },
  });
  return { output, stream };
}

describe('attachCLIProgressListener', () => {
  test('task:start produces expected output', () => {
    const bus = createBus();
    const { output, stream } = createCapture();
    attachCLIProgressListener(bus, { output: stream });

    bus.emit('task:start', {
      input: {
        id: 't-1',
        source: 'cli',
        goal: 'fix bug',
        taskType: 'code',
        budget: { maxTokens: 100, maxDurationMs: 1000, maxRetries: 1 },
      },
      routing: { level: 1, model: 'mock/fast', budgetTokens: 100, latencyBudgetMs: 1000 },
    });

    expect(output.length).toBe(1);
    expect(output[0]).toContain('t-1');
    expect(output[0]).toContain('L1');
    expect(output[0]).toContain('mock/fast');
  });

  test('oracle:verdict shown only in verbose mode', () => {
    const bus = createBus();
    const { output: quietOutput, stream: quietStream } = createCapture();
    const { output: verboseOutput, stream: verboseStream } = createCapture();

    attachCLIProgressListener(bus, { output: quietStream, verbose: false });
    attachCLIProgressListener(bus, { output: verboseStream, verbose: true });

    bus.emit('oracle:verdict', {
      taskId: 't-1',
      oracleName: 'type',
      verdict: {
        verified: false,
        confidence: 0.9,
        evidence: [],
        reason: 'type error',
        type: 'known' as const,
        fileHashes: {},
        durationMs: 10,
      },
    });

    expect(quietOutput.length).toBe(0);
    expect(verboseOutput.length).toBe(1);
    expect(verboseOutput[0]).toContain('FAIL');
    expect(verboseOutput[0]).toContain('type');
  });

  test('task:escalate produces escalation line', () => {
    const bus = createBus();
    const { output, stream } = createCapture();
    attachCLIProgressListener(bus, { output: stream });

    bus.emit('task:escalate', { taskId: 't-1', fromLevel: 1, toLevel: 2, reason: 'retries exhausted' });

    expect(output.length).toBe(1);
    expect(output[0]).toContain('L1');
    expect(output[0]).toContain('L2');
    expect(output[0]).toContain('retries exhausted');
  });

  test('task:complete shows mutation count', () => {
    const bus = createBus();
    const { output, stream } = createCapture();
    attachCLIProgressListener(bus, { output: stream });

    bus.emit('task:complete', {
      result: {
        id: 't-1',
        status: 'completed',
        mutations: [{ file: 'a.ts', diff: '+1', oracleVerdicts: {} }],
        trace: {
          id: 'tr-1',
          taskId: 't-1',
          timestamp: 0,
          routingLevel: 1,
          approach: '',
          oracleVerdicts: {},
          modelUsed: 'm',
          tokensConsumed: 0,
          durationMs: 0,
          outcome: 'success' as const,
          affectedFiles: [],
        },
      },
    });

    expect(output.length).toBe(1);
    expect(output[0]).toContain('1 mutation');
    expect(output[0]).toContain('completed');
  });

  test('detach stops all output', () => {
    const bus = createBus();
    const { output, stream } = createCapture();
    const detach = attachCLIProgressListener(bus, { output: stream });

    bus.emit('task:start', {
      input: { id: 't-1', source: 'cli', goal: 'x', taskType: 'code', budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 1 } },
      routing: { level: 0, model: null, budgetTokens: 0, latencyBudgetMs: 0 },
    });
    expect(output.length).toBe(1);

    detach();

    bus.emit('task:start', {
      input: { id: 't-2', source: 'cli', goal: 'y', taskType: 'code', budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 1 } },
      routing: { level: 0, model: null, budgetTokens: 0, latencyBudgetMs: 0 },
    });
    expect(output.length).toBe(1); // not incremented
  });
});

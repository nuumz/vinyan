/**
 * ChatStreamRenderer unit tests — drive a synthetic bus through a
 * representative turn and assert the rendered output.
 *
 * Captures stdout via a Writable stream to avoid mocking console.
 */
import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { attachChatStreamRenderer } from '../../src/cli/chat-stream-renderer.ts';
import { createBus } from '../../src/core/bus.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape pattern needs control chars
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function captureStream(): {
  stream: NodeJS.WritableStream;
  read: () => string;
} {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  }) as NodeJS.WritableStream;
  return { stream, read: () => buf.replace(ANSI_RE, '') };
}

describe('ChatStreamRenderer', () => {
  test('renders a full turn timeline from synthetic events', () => {
    const bus = createBus();
    const { stream, read } = captureStream();
    const taskId = 'chat-t1';

    const renderer = attachChatStreamRenderer(bus, {
      taskId,
      out: stream,
      color: false,
    });

    bus.emit('intent:resolved', {
      taskId,
      strategy: 'full-pipeline',
      confidence: 0.92,
      reasoning: 'code-mutation detected',
    });
    bus.emit('understanding:layer0_complete', {
      taskId,
      durationMs: 40,
      verb: 'refactor',
      category: 'code',
    });
    bus.emit('task:start', {
      input: { id: taskId } as any,
      routing: { level: 2, model: 'claude-sonnet-4-6' } as any,
    });
    bus.emit('agent:session_start', {
      taskId,
      routingLevel: 2,
      budget: { maxTokens: 50_000, maxTurns: 20, contextWindow: 200_000 },
    });
    bus.emit('agent:tool_started', {
      taskId,
      turnId: 't1',
      toolCallId: 'call-1',
      toolName: 'file_read',
      args: {},
    });
    bus.emit('agent:tool_executed', {
      taskId,
      turnId: 't1',
      toolName: 'file_read',
      toolCallId: 'call-1',
      durationMs: 12,
      isError: false,
    });
    bus.emit('llm:stream_delta', { taskId, turnId: 't1', kind: 'content', text: 'Hello, ' });
    bus.emit('llm:stream_delta', { taskId, turnId: 't1', kind: 'content', text: 'world!' });
    bus.emit('agent:session_end', {
      taskId,
      outcome: 'completed',
      tokensConsumed: 240,
      turnsUsed: 1,
      durationMs: 800,
    });
    bus.emit('task:complete', {
      result: {
        id: taskId,
        status: 'completed',
        mutations: [],
      } as any,
    });

    renderer.detach();

    const output = read();

    // Intent line
    expect(output).toContain('intent');
    expect(output).toContain('full-pipeline');
    expect(output).toContain('conf 0.92');
    // Understanding
    expect(output).toContain('refactor');
    expect(output).toContain('→ code');
    // Task routing
    expect(output).toContain('L2');
    expect(output).toContain('claude-sonnet-4-6');
    // Agent session start
    expect(output).toContain('agent');
    expect(output).toContain('20 turns');
    // Tool start + end
    expect(output).toContain('preparing file_read');
    expect(output).toContain('file_read');
    expect(output).toContain('12ms');
    // Streamed answer
    expect(output).toContain('vinyan:');
    expect(output).toContain('Hello, world!');
    // Final footer
    expect(output).toMatch(/agent completed/);
    expect(output).toMatch(/completed .* mutation/);
  });

  test('filters events from other tasks', () => {
    const bus = createBus();
    const { stream, read } = captureStream();
    const taskId = 'chat-t-me';

    const renderer = attachChatStreamRenderer(bus, {
      taskId,
      out: stream,
      color: false,
    });

    bus.emit('intent:resolved', {
      taskId: 'chat-t-other',
      strategy: 'conversational',
      confidence: 0.5,
      reasoning: 'unrelated',
    });
    bus.emit('llm:stream_delta', { taskId: 'chat-t-other', kind: 'content', text: 'should not appear' });
    bus.emit('llm:stream_delta', { taskId, kind: 'content', text: 'only mine' });

    renderer.detach();
    const output = read();

    expect(output).not.toContain('unrelated');
    expect(output).not.toContain('should not appear');
    expect(output).toContain('only mine');
  });

  test('hides thinking deltas by default, shows when enabled', () => {
    const bus = createBus();
    const { stream, read } = captureStream();
    const taskId = 't-think';

    const renderer = attachChatStreamRenderer(bus, {
      taskId,
      out: stream,
      color: false,
      showThinking: false,
    });

    bus.emit('llm:stream_delta', {
      taskId,
      kind: 'thinking',
      text: 'hidden thoughts',
    });
    bus.emit('llm:stream_delta', {
      taskId,
      kind: 'content',
      text: 'answer-body',
    });

    expect(read()).not.toContain('hidden thoughts');
    expect(read()).toContain('answer-body');

    renderer.setShowThinking(true);
    bus.emit('llm:stream_delta', {
      taskId,
      kind: 'thinking',
      text: 'visible thoughts',
    });

    renderer.detach();
    expect(read()).toContain('visible thoughts');
  });

  test('renders oracle and critic verdicts + escalation', () => {
    const bus = createBus();
    const { stream, read } = captureStream();
    const taskId = 't-verdict';

    const renderer = attachChatStreamRenderer(bus, {
      taskId,
      out: stream,
      color: false,
    });

    bus.emit('oracle:verdict', {
      taskId,
      oracleName: 'ast',
      verdict: { verified: true, confidence: 0.99 } as any,
    });
    bus.emit('critic:verdict', { taskId, accepted: false, confidence: 0.55, reason: 'missed test' });
    bus.emit('task:escalate', { taskId, fromLevel: 1, toLevel: 2, reason: 'contradiction' });

    renderer.detach();
    const output = read();

    expect(output).toContain('oracle ast');
    expect(output).toContain('conf 0.99');
    expect(output).toContain('critic reject');
    expect(output).toContain('missed test');
    expect(output).toContain('L1→L2');
  });
});

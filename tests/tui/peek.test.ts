/**
 * Book-integration Wave 3.1: peek view tests.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { startPeek } from '../../src/tui/views/peek.ts';

describe('startPeek — task id filter', () => {
  test('matches exact task id', () => {
    const bus = createBus();
    const lines: string[] = [];
    const handle = startPeek(bus, {
      taskIdPattern: 'task-42',
      showTimestamps: false,
      write: (line) => lines.push(line),
    });

    bus.emit('task:start', {
      input: {
        id: 'task-42',
        source: 'cli',
        goal: 'x',
        taskType: 'code',
        budget: { maxTokens: 0, maxRetries: 0, maxDurationMs: 0 },
      },
      routing: { level: 1 } as never,
    });
    bus.emit('task:start', {
      input: {
        id: 'task-99',
        source: 'cli',
        goal: 'y',
        taskType: 'code',
        budget: { maxTokens: 0, maxRetries: 0, maxDurationMs: 0 },
      },
      routing: { level: 1 } as never,
    });

    handle.stop();
    expect(handle.matchedCount()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('task-42');
  });

  test('glob prefix matches child tasks', () => {
    const bus = createBus();
    const matches: string[] = [];
    const handle = startPeek(bus, {
      taskIdPattern: 'parent-*',
      showTimestamps: false,
      write: (line) => matches.push(line),
    });

    bus.emit('agent:tool_executed', {
      taskId: 'parent-1',
      turnId: 't1',
      toolName: 'file_read',
      durationMs: 10,
      isError: false,
    });
    bus.emit('agent:tool_executed', {
      taskId: 'parent-child-1',
      turnId: 't2',
      toolName: 'file_read',
      durationMs: 10,
      isError: false,
    });
    bus.emit('agent:tool_executed', {
      taskId: 'other-1',
      turnId: 't3',
      toolName: 'file_read',
      durationMs: 10,
      isError: false,
    });

    handle.stop();
    expect(handle.matchedCount()).toBe(2);
  });

  test('silent-agent events surface through peek', () => {
    const bus = createBus();
    const lines: string[] = [];
    const handle = startPeek(bus, {
      taskIdPattern: 'task-7',
      showTimestamps: false,
      write: (line) => lines.push(line),
    });

    bus.emit('guardrail:silent_agent', {
      taskId: 'task-7',
      state: 'silent',
      silentForMs: 20000,
      lastEvent: 'tool_calls',
    });

    handle.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SILENT');
  });

  test('stop() unsubscribes from further events', () => {
    const bus = createBus();
    const lines: string[] = [];
    const handle = startPeek(bus, {
      taskIdPattern: '*',
      showTimestamps: false,
      write: (line) => lines.push(line),
    });
    handle.stop();

    bus.emit('task:uncertain', { taskId: 'ghost', reason: 'after stop', maxCapability: 0 });
    expect(lines).toHaveLength(0);
  });
});

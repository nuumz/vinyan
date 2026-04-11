/**
 * TUI tests — PH5.2.
 *
 * Tests renderer utilities, event rendering, and audit replay.
 */
import { describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { EventRenderer } from '../../src/tui/event-renderer.ts';
import {
  ANSI,
  bold,
  box,
  color,
  dim,
  formatTimestamp,
  progressBar,
  statusBadge,
  table,
} from '../../src/tui/renderer.ts';
import { parseAuditLog, summarizeAuditLog } from '../../src/tui/replay.ts';

describe('Renderer utilities', () => {
  test('color wraps text in ANSI codes', () => {
    const result = color('hello', ANSI.red);
    expect(result).toContain('\x1b[31m');
    expect(result).toContain('hello');
    expect(result).toContain(ANSI.reset);
  });

  test('bold wraps text', () => {
    const result = bold('test');
    expect(result).toContain(ANSI.bold);
    expect(result).toContain('test');
  });

  test('dim wraps text', () => {
    const result = dim('test');
    expect(result).toContain(ANSI.dim);
  });

  test('box renders with title and content', () => {
    const result = box('Title', 'line 1\nline 2', 30);
    expect(result).toContain('Title');
    expect(result).toContain('line 1');
    expect(result).toContain('line 2');
    expect(result).toContain('┌');
    expect(result).toContain('└');
  });

  test('table renders headers and rows', () => {
    const result = table(
      ['Name', 'Value'],
      [
        ['foo', '42'],
        ['bar', '99'],
      ],
    );
    expect(result).toContain('Name');
    expect(result).toContain('foo');
    expect(result).toContain('42');
  });

  test('progressBar renders at various levels', () => {
    const full = progressBar(100, 100);
    expect(full).toContain('100%');
    expect(full).toContain(ANSI.green);

    const mid = progressBar(50, 100);
    expect(mid).toContain('50%');
    expect(mid).toContain(ANSI.yellow);

    const low = progressBar(20, 100);
    expect(low).toContain('20%');
    expect(low).toContain(ANSI.red);
  });

  test('statusBadge applies correct colors', () => {
    const active = statusBadge('active');
    expect(active).toContain(ANSI.bgGreen);

    const failed = statusBadge('failed');
    expect(failed).toContain(ANSI.bgRed);

    const probation = statusBadge('probation');
    expect(probation).toContain(ANSI.bgYellow);
  });

  test('formatTimestamp produces HH:MM:SS.mmm format', () => {
    const ts = new Date(2026, 3, 2, 14, 30, 45, 123).getTime();
    const result = formatTimestamp(ts);
    expect(result).toBe('14:30:45.123');
  });
});

describe('EventRenderer', () => {
  test('captures events from bus', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const renderer = new EventRenderer({ showTimestamps: false });

    renderer.attach(bus);

    bus.emit('task:start', { input: { id: 't1', source: 'cli', goal: 'test', budget: {} }, routing: {} } as any);

    const events = renderer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe('task');

    renderer.detach();
  });

  test('respects category filter', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const renderer = new EventRenderer({ categories: ['oracle'], showTimestamps: false });

    renderer.attach(bus);

    bus.emit('task:start', { input: {}, routing: {} } as any);
    bus.emit('oracle:verdict', { taskId: 't1', oracleName: 'type', verdict: { verified: true } } as any);

    const events = renderer.getEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.category).toBe('oracle');

    renderer.detach();
  });

  test('clear removes all events', () => {
    const renderer = new EventRenderer();
    const bus = new EventBus<VinyanBusEvents>();

    renderer.attach(bus);
    bus.emit('task:start', { input: {}, routing: {} } as any);

    expect(renderer.getEvents().length).toBe(1);
    renderer.clear();
    expect(renderer.getEvents().length).toBe(0);

    renderer.detach();
  });

  test('maxEvents caps buffer size', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const renderer = new EventRenderer({ maxEvents: 3, showTimestamps: false });

    renderer.attach(bus);
    for (let i = 0; i < 5; i++) {
      bus.emit('task:start', { input: { id: `t${i}` }, routing: {} } as any);
    }

    expect(renderer.getEvents().length).toBe(3);
    renderer.detach();
  });
});

describe('Audit log replay', () => {
  test('parseAuditLog parses JSONL format', () => {
    const content = [
      JSON.stringify({ event: 'task:started', payload: { taskId: 't1' }, timestamp: 1000 }),
      JSON.stringify({ event: 'task:complete', payload: { taskId: 't1' }, timestamp: 2000 }),
      '', // empty line
      'not json', // malformed
    ].join('\n');

    const entries = parseAuditLog(content);
    expect(entries.length).toBe(2);
    expect(entries[0]!.event).toBe('task:started');
    expect(entries[1]!.timestamp).toBe(2000);
  });

  test('parseAuditLog handles empty content', () => {
    const entries = parseAuditLog('');
    expect(entries.length).toBe(0);
  });

  test('summarizeAuditLog produces readable summary', () => {
    const entries = [
      { event: 'task:started', payload: {}, timestamp: 1000 },
      { event: 'task:complete', payload: {}, timestamp: 2000 },
      { event: 'task:started', payload: {}, timestamp: 3000 },
      { event: 'oracle:complete', payload: {}, timestamp: 4000 },
    ];

    const summary = summarizeAuditLog(entries);
    expect(summary).toContain('Audit Log Summary');
    expect(summary).toContain('Total events:');
    expect(summary).toContain('task:started');
    expect(summary).toContain('oracle:complete');
  });

  test('summarizeAuditLog handles empty log', () => {
    const summary = summarizeAuditLog([]);
    expect(summary).toContain('No audit entries');
  });
});

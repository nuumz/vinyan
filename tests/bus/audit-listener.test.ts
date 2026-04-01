import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { attachAuditListener } from '../../src/bus/audit-listener.ts';
import { createBus } from '../../src/core/bus.ts';

let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('attachAuditListener', () => {
  test('writes JSONL lines for emitted events', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-audit-'));
    const auditPath = join(tempDir, '.vinyan', 'audit.jsonl');
    const bus = createBus();

    attachAuditListener(bus, auditPath);

    bus.emit('task:start', {
      input: {
        id: 't-1',
        source: 'cli' as const,
        goal: 'test',
        budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 1 },
      },
      routing: { level: 1, model: 'mock', budgetTokens: 1, latencyBudgetMs: 1 },
    });
    bus.emit('task:complete', {
      result: {
        id: 't-1',
        status: 'completed' as const,
        mutations: [],
        trace: {
          id: 'tr-1',
          taskId: 't-1',
          timestamp: 0,
          routingLevel: 1,
          approach: '',
          oracleVerdicts: {},
          model_used: 'm',
          tokens_consumed: 0,
          durationMs: 0,
          outcome: 'success' as const,
          affected_files: [],
        },
      },
    });

    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!);
    expect(first.event).toBe('task:start');
    expect(first.ts).toBeGreaterThan(0);
    expect(first.payload.input.id).toBe('t-1');

    const second = JSON.parse(lines[1]!);
    expect(second.event).toBe('task:complete');
  });

  test('each line is valid JSON with ts, event, payload', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-audit-'));
    const auditPath = join(tempDir, '.vinyan', 'audit.jsonl');
    const bus = createBus();

    attachAuditListener(bus, auditPath);

    bus.emit('oracle:verdict', {
      taskId: 't-1',
      oracleName: 'type',
      verdict: { verified: true, confidence: 1.0, evidence: [], type: 'known' as const, fileHashes: {}, durationMs: 5 },
    });

    const line = JSON.parse(readFileSync(auditPath, 'utf-8').trim());
    expect(line).toHaveProperty('ts');
    expect(line).toHaveProperty('event');
    expect(line).toHaveProperty('payload');
    expect(typeof line.ts).toBe('number');
    expect(line.event).toBe('oracle:verdict');
  });

  test('detach stops writing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-audit-'));
    const auditPath = join(tempDir, '.vinyan', 'audit.jsonl');
    const bus = createBus();

    const detach = attachAuditListener(bus, auditPath);

    bus.emit('task:start', {
      input: {
        id: 't-1',
        source: 'cli' as const,
        goal: 'x',
        budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 1 },
      },
      routing: { level: 0, model: null, budgetTokens: 0, latencyBudgetMs: 0 },
    });

    detach();

    bus.emit('task:start', {
      input: {
        id: 't-2',
        source: 'cli' as const,
        goal: 'y',
        budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 1 },
      },
      routing: { level: 0, model: null, budgetTokens: 0, latencyBudgetMs: 0 },
    });

    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1); // only the first event
  });
});

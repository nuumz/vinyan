/**
 * A2A Streaming tests — Phase F1.
 */
import { describe, expect, test } from 'bun:test';
import {
  createA2AStreamingChannel,
  ECPPartialVerdictSchema,
  ECPProgressUpdateSchema,
} from '../../src/a2a/streaming.ts';

// ── Schema Validation ─────────────────────────────────────────────────

describe('ECPProgressUpdateSchema', () => {
  test('validates correct progress update', () => {
    const update = {
      ecp_version: 1,
      message_type: 'progress',
      task_id: 'task-001',
      phase: 'oracle_execution',
      progress_pct: 60,
      oracle_name: 'ast-oracle',
      timestamp: Date.now(),
    };
    expect(ECPProgressUpdateSchema.safeParse(update).success).toBe(true);
  });

  test('rejects invalid phase', () => {
    const update = {
      ecp_version: 1,
      message_type: 'progress',
      task_id: 'task-001',
      phase: 'invalid_phase',
      progress_pct: 50,
      timestamp: Date.now(),
    };
    expect(ECPProgressUpdateSchema.safeParse(update).success).toBe(false);
  });

  test('rejects progress_pct > 100', () => {
    const update = {
      ecp_version: 1,
      message_type: 'progress',
      task_id: 'task-001',
      phase: 'routing',
      progress_pct: 150,
      timestamp: Date.now(),
    };
    expect(ECPProgressUpdateSchema.safeParse(update).success).toBe(false);
  });
});

describe('ECPPartialVerdictSchema', () => {
  test('validates correct partial verdict', () => {
    const verdict = {
      ecp_version: 1,
      message_type: 'partial_verdict',
      task_id: 'task-001',
      oracle_name: 'type-oracle',
      verified: true,
      confidence: 0.85,
      oracles_completed: 2,
      oracles_total: 5,
      is_final: false,
      timestamp: Date.now(),
    };
    expect(ECPPartialVerdictSchema.safeParse(verdict).success).toBe(true);
  });

  test('rejects confidence > 1', () => {
    const verdict = {
      ecp_version: 1,
      message_type: 'partial_verdict',
      task_id: 'task-001',
      oracle_name: 'type-oracle',
      verified: true,
      confidence: 1.5,
      is_final: false,
      timestamp: Date.now(),
    };
    expect(ECPPartialVerdictSchema.safeParse(verdict).success).toBe(false);
  });
});

// ── SSE Channel ───────────────────────────────────────────────────────

describe('createA2AStreamingChannel', () => {
  test('sends SSE-formatted progress data', async () => {
    const chunks: string[] = [];
    const stream = new ReadableStream({
      start(controller) {
        const channel = createA2AStreamingChannel(controller);
        channel.sendProgress({
          ecp_version: 1,
          message_type: 'progress',
          task_id: 't1',
          phase: 'oracle_execution',
          progress_pct: 50,
          timestamp: Date.now(),
        });
        channel.close();
      },
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const output = chunks.join('');
    expect(output).toContain('event: progress');
    expect(output).toContain('oracle_execution');
  });

  test('sends SSE-formatted partial verdict', async () => {
    const chunks: string[] = [];
    const stream = new ReadableStream({
      start(controller) {
        const channel = createA2AStreamingChannel(controller);
        channel.sendPartialVerdict({
          ecp_version: 1,
          message_type: 'partial_verdict',
          task_id: 't1',
          oracle_name: 'ast-oracle',
          verified: true,
          confidence: 0.9,
          is_final: false,
          timestamp: Date.now(),
        });
        channel.close();
      },
    });

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    const output = chunks.join('');
    expect(output).toContain('event: partial_verdict');
    expect(output).toContain('ast-oracle');
  });

  test('close prevents further sends', () => {
    let channelRef: any;
    new ReadableStream({
      start(controller) {
        channelRef = createA2AStreamingChannel(controller);
        channelRef.close();
      },
    });

    expect(channelRef.isClosed).toBe(true);
    // Should not throw
    channelRef.sendProgress({
      ecp_version: 1,
      message_type: 'progress',
      task_id: 't1',
      phase: 'routing',
      progress_pct: 0,
      timestamp: Date.now(),
    });
  });
});

/**
 * HumanECPBridge Tests
 *
 * Tests interface compliance, bus event flow (review_requested → review_completed),
 * and timeout behavior.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { HumanECPBridge } from '../../src/orchestrator/engines/human-ecp-bridge.ts';
import type { RERequest, ReasoningEngine } from '../../src/orchestrator/types.ts';

function makeRequest(overrides?: Partial<RERequest>): RERequest {
  return {
    systemPrompt: 'You are reviewing a code change.',
    userPrompt: 'Please review this refactor of the auth module.',
    maxTokens: 1000,
    ...overrides,
  };
}

describe('HumanECPBridge — interface compliance', () => {
  test('implements ReasoningEngine interface', () => {
    const bus = createBus();
    const engine: ReasoningEngine = new HumanECPBridge({ bus });

    expect(engine.id).toBe('human-bridge');
    expect(engine.engineType).toBe('external');
    expect(engine.capabilities).toContain('human-review');
    expect(engine.capabilities).toContain('approval');
    expect(engine.capabilities).toContain('domain-expertise');
    expect(typeof engine.execute).toBe('function');
  });

  test('tier is undefined (non-LLM engine)', () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus });
    expect(engine.tier).toBeUndefined();
  });

  test('maxContextTokens is undefined (non-LLM engine)', () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus });
    expect(engine.maxContextTokens).toBeUndefined();
  });
});

describe('HumanECPBridge — configuration', () => {
  test('default timeout is 5 minutes (300_000ms)', () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus });
    expect((engine as any).timeoutMs).toBe(300_000);
  });

  test('custom timeout overrides default', () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 60_000 });
    expect((engine as any).timeoutMs).toBe(60_000);
  });
});

describe('HumanECPBridge — execute() with bus events', () => {
  test('emits review_requested and resolves on review_completed', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 5_000 });
    const reviewContent = 'LGTM — approved with minor nit on naming';

    // Listen for the review request and simulate human response
    bus.on('human:review_requested', (payload) => {
      // Simulate human responding after a short delay
      setTimeout(() => {
        bus.emit('human:review_completed', {
          taskId: payload.taskId,
          content: reviewContent,
        });
      }, 10);
    });

    const response = await engine.execute(makeRequest());

    expect(response.content).toBe(reviewContent);
    expect(response.engineId).toBe('human-bridge');
    expect(response.terminationReason).toBe('completed');
    expect(response.toolCalls).toEqual([]);
    expect(response.providerMeta?.source).toBe('human-review');
  });

  test('review_requested payload contains prompt and timeout', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 2_000 });
    const prompt = 'Review this critical security patch.';

    let capturedPayload: any = null;
    bus.on('human:review_requested', (payload) => {
      capturedPayload = payload;
      // Respond after microtask — execute() subscribes to review_completed after emitting review_requested
      setTimeout(() => {
        bus.emit('human:review_completed', {
          taskId: payload.taskId,
          content: 'reviewed',
        });
      }, 5);
    });

    await engine.execute(makeRequest({ userPrompt: prompt }));

    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload.prompt).toBe(prompt);
    expect(capturedPayload.timeoutMs).toBe(2_000);
    expect(typeof capturedPayload.taskId).toBe('string');
  });

  test('tokensUsed reflects input and output lengths', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 2_000 });
    const userPrompt = 'Short review request';
    const reviewResponse = 'Approved';

    bus.on('human:review_requested', (payload) => {
      setTimeout(() => {
        bus.emit('human:review_completed', {
          taskId: payload.taskId,
          content: reviewResponse,
        });
      }, 5);
    });

    const response = await engine.execute(makeRequest({ userPrompt }));

    expect(response.tokensUsed.input).toBe(userPrompt.length);
    expect(response.tokensUsed.output).toBe(reviewResponse.length);
  });

  test('ignores review_completed for different taskId', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 500 });
    const correctContent = 'correct response';

    bus.on('human:review_requested', (payload) => {
      // Emit a response with wrong taskId first
      bus.emit('human:review_completed', {
        taskId: 'wrong-task-id',
        content: 'wrong response',
      });
      // Then emit with correct taskId
      setTimeout(() => {
        bus.emit('human:review_completed', {
          taskId: payload.taskId,
          content: correctContent,
        });
      }, 10);
    });

    const response = await engine.execute(makeRequest());
    expect(response.content).toBe(correctContent);
  });
});

describe('HumanECPBridge — timeout behavior', () => {
  test('rejects with timeout error when human does not respond', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 50 }); // Very short timeout

    // Do NOT emit review_completed — simulate human not responding
    await expect(engine.execute(makeRequest())).rejects.toThrow(/timed out/i);
  });

  test('timeout error message includes duration', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 50 });

    try {
      await engine.execute(makeRequest());
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain('50ms');
    }
  });
});

describe('HumanECPBridge — response shape', () => {
  test('response conforms to REResponse', async () => {
    const bus = createBus();
    const engine = new HumanECPBridge({ bus, timeoutMs: 2_000 });

    bus.on('human:review_requested', (payload) => {
      setTimeout(() => {
        bus.emit('human:review_completed', {
          taskId: payload.taskId,
          content: 'looks good',
        });
      }, 5);
    });

    const response = await engine.execute(makeRequest());

    // Verify all required REResponse fields
    expect(typeof response.content).toBe('string');
    expect(Array.isArray(response.toolCalls)).toBe(true);
    expect(typeof response.tokensUsed.input).toBe('number');
    expect(typeof response.tokensUsed.output).toBe('number');
    expect(typeof response.engineId).toBe('string');
    expect(response.terminationReason).toBe('completed');
    expect(typeof response.providerMeta!.durationMs).toBe('number');
  });
});

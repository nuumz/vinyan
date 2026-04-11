/**
 * Tests for RemediationEngine — fast-tier LLM command correction.
 */
import { describe, expect, test } from 'bun:test';
import { RemediationEngine } from '../../src/orchestrator/remediation-engine.ts';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/orchestrator/types.ts';
import type { ToolFailureAnalysis } from '../../src/orchestrator/tool-failure-classifier.ts';

function makeProvider(response: string): LLMProvider {
  return {
    id: 'mock/fast',
    tier: 'fast',
    async generate(_req: LLMRequest): Promise<LLMResponse> {
      return {
        content: response,
        toolCalls: [],
        tokensUsed: { input: 10, output: 10 },
        model: 'mock',
        stopReason: 'end_turn',
      };
    },
  };
}

function makeAnalysis(overrides?: Partial<ToolFailureAnalysis>): ToolFailureAnalysis {
  return {
    type: 'not_found',
    recoverable: true,
    retryable: false,
    originalError: "Unable to find application named 'outlook'",
    exitCode: 1,
    ...overrides,
  };
}

describe('RemediationEngine', () => {
  test('parses retry_corrected suggestion from LLM', async () => {
    const provider = makeProvider(JSON.stringify({
      action: 'retry_corrected',
      correctedCommand: 'open -a "Microsoft Outlook"',
      reasoning: 'macOS app is named "Microsoft Outlook"',
      confidence: 0.9,
    }));
    const engine = new RemediationEngine(provider);

    const result = await engine.suggest(
      'เปิดแอพ outlook',
      'open -a outlook',
      makeAnalysis(),
      'darwin',
    );

    expect(result.action).toBe('retry_corrected');
    expect(result.correctedCommand).toBe('open -a "Microsoft Outlook"');
    expect(result.confidence).toBe(0.9);
  });

  test('parses escalate suggestion from LLM', async () => {
    const provider = makeProvider(JSON.stringify({
      action: 'escalate',
      reasoning: 'Cannot determine correct app name',
      confidence: 0.3,
    }));
    const engine = new RemediationEngine(provider);

    const result = await engine.suggest(
      'open some-app',
      'open -a some-app',
      makeAnalysis(),
      'darwin',
    );

    expect(result.action).toBe('escalate');
  });

  test('handles malformed LLM response gracefully', async () => {
    const provider = makeProvider('not valid json at all');
    const engine = new RemediationEngine(provider);

    const result = await engine.suggest('goal', 'cmd', makeAnalysis(), 'darwin');
    expect(result.action).toBe('escalate');
    expect(result.reasoning).toContain('parse');
  });

  test('handles LLM error gracefully', async () => {
    const provider: LLMProvider = {
      id: 'error-provider',
      tier: 'fast',
      async generate(): Promise<LLMResponse> {
        throw new Error('API error');
      },
    };
    const engine = new RemediationEngine(provider);

    const result = await engine.suggest('goal', 'cmd', makeAnalysis(), 'darwin');
    expect(result.action).toBe('escalate');
  });

  test('circuit breaker opens after 3 consecutive failures', async () => {
    const provider: LLMProvider = {
      id: 'failing-provider',
      tier: 'fast',
      async generate(): Promise<LLMResponse> {
        throw new Error('API error');
      },
    };
    const engine = new RemediationEngine(provider);

    // 3 failures to trip circuit breaker
    await engine.suggest('goal', 'cmd', makeAnalysis(), 'darwin');
    await engine.suggest('goal', 'cmd', makeAnalysis(), 'darwin');
    await engine.suggest('goal', 'cmd', makeAnalysis(), 'darwin');

    // 4th call should be circuit-broken without calling provider
    const result = await engine.suggest('goal', 'cmd', makeAnalysis(), 'darwin');
    expect(result.action).toBe('escalate');
    expect(result.reasoning).toContain('circuit breaker');
  });

  test('providerId returns provider id', () => {
    const provider = makeProvider('{}');
    const engine = new RemediationEngine(provider);
    expect(engine.providerId).toBe('mock/fast');
  });

  test('confidenceThreshold is 0.6', () => {
    const provider = makeProvider('{}');
    const engine = new RemediationEngine(provider);
    expect(engine.confidenceThreshold).toBe(0.6);
  });
});

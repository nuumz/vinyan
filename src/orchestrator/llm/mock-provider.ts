/**
 * Mock LLM Provider — returns structured responses for testing.
 * Implements the LLMProvider interface without calling any external API.
 */
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from '../types.ts';

export interface MockProviderOptions {
  id?: string;
  tier?: LLMProvider['tier'];
  /** Override the default response content. */
  responseContent?: string;
  /** Override the tool calls in the response. */
  responseToolCalls?: ToolCall[];
  /** Simulate a failure. */
  shouldFail?: boolean;
  /** Simulate latency in ms. */
  latencyMs?: number;
  /** Override the stop reason. */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens';
  /** Simulate thinking output (Anthropic extended thinking). */
  thinking?: string;
}

export interface ScriptedMockResponse {
  content?: string;
  toolCalls?: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  tokensUsed?: { input: number; output: number };
  thinking?: string;
}

/**
 * Create a mock provider that returns scripted responses in sequence.
 * Pops one response per generate() call. Throws if exhausted.
 */
export function createScriptedMockProvider(
  responses: ScriptedMockResponse[],
  options?: { id?: string; tier?: LLMProvider['tier'] },
): LLMProvider {
  const queue = [...responses];
  return {
    id: options?.id ?? 'mock/scripted',
    tier: options?.tier ?? 'fast',
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      const next = queue.shift();
      if (!next) throw new Error('ScriptedMockProvider: no more responses in queue');
      return {
        content: next.content ?? '',
        thinking: next.thinking,
        toolCalls: next.toolCalls ?? [],
        tokensUsed: next.tokensUsed ?? { input: 100, output: 50 },
        model: 'mock-scripted',
        stopReason: next.stopReason,
      };
    },
  };
}

export function createMockProvider(options: MockProviderOptions = {}): LLMProvider {
  return {
    id: options.id ?? 'mock/test',
    tier: options.tier ?? 'fast',
    async generate(_request: LLMRequest): Promise<LLMResponse> {
      if (options.latencyMs) {
        await new Promise((r) => setTimeout(r, options.latencyMs));
      }

      if (options.shouldFail) {
        throw new Error('Mock provider: simulated failure');
      }

      const content =
        options.responseContent ??
        JSON.stringify({
          proposedMutations: [],
          proposedToolCalls: options.responseToolCalls ?? [],
          uncertainties: [],
        });

      return {
        content,
        thinking: options.thinking,
        toolCalls: options.responseToolCalls ?? [],
        tokensUsed: { input: 100, output: 50 },
        model: 'mock-model',
        stopReason: options.stopReason ?? (options.responseToolCalls?.length ? 'tool_use' : 'end_turn'),
      };
    },
  };
}

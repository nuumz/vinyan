/**
 * Mock LLM Provider — returns structured responses for testing.
 * Implements the LLMProvider interface without calling any external API.
 * Also provides createMockReasoningEngine for RE-agnostic testing.
 */
import type { LLMProvider, LLMRequest, LLMResponse, OnTextDelta, ReasoningEngine, ToolCall } from '../types.ts';
import { LLMReasoningEngine } from './llm-reasoning-engine.ts';

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
  const buildResponse = (): LLMResponse => {
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
  };
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

      return buildResponse();
    },
    async generateStream(_request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse> {
      if (options.shouldFail) throw new Error('Mock provider: simulated failure');
      const response = buildResponse();
      // Chunk content into ~8-char pieces to simulate streaming.
      const chunkSize = 8;
      for (let i = 0; i < response.content.length; i += chunkSize) {
        const text = response.content.slice(i, i + chunkSize);
        onDelta({ text });
        if (options.latencyMs !== undefined)
          await new Promise((r) => setTimeout(r, Math.max(1, Math.floor(options.latencyMs! / 10))));
      }
      return response;
    },
  };
}

/**
 * Create a mock ReasoningEngine for RE-agnostic testing.
 * Wraps createMockProvider via LLMReasoningEngine adapter so tests can exercise
 * the full RE dispatch path without calling external APIs.
 */
export function createMockReasoningEngine(options: MockProviderOptions & { capabilities?: string[] } = {}): ReasoningEngine {
  const provider = createMockProvider(options);
  return new LLMReasoningEngine(provider, options.capabilities);
}

/**
 * Create a scripted mock ReasoningEngine that returns responses in sequence.
 * Useful for testing multi-turn RE dispatch and capability routing.
 */
export function createScriptedMockReasoningEngine(
  responses: ScriptedMockResponse[],
  options?: { id?: string; tier?: LLMProvider['tier']; capabilities?: string[] },
): ReasoningEngine {
  const provider = createScriptedMockProvider(responses, options);
  return new LLMReasoningEngine(provider, options?.capabilities);
}

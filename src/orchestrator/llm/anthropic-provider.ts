/**
 * Anthropic LLM Provider — wraps @anthropic-ai/sdk for Claude models.
 *
 * Optional dependency: install with `bun add @anthropic-ai/sdk` to enable.
 * OpenRouter (openrouter-provider.ts) is the recommended primary provider.
 * Guarded by ANTHROPIC_API_KEY environment variable.
 * Source of truth: spec/tdd.md §17.1
 */
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from '../types.ts';
import { normalizeMessages } from './provider-format.ts';
import type { AnthropicMessage } from './provider-format.ts';

export interface AnthropicProviderConfig {
  id?: string;
  tier?: LLMProvider['tier'];
  model?: string;
  apiKey?: string;
}

export function createAnthropicProvider(config: AnthropicProviderConfig = {}): LLMProvider | null {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Dynamic import to avoid hard dependency when API key is not set
  let Anthropic: any;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return null;
  }

  const client = new Anthropic({ apiKey });
  const model = config.model ?? 'claude-sonnet-4-20250514';

  return {
    id: config.id ?? `anthropic/${model}`,
    tier: config.tier ?? 'balanced',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      // Build tool definitions for Anthropic format
      const tools = request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: 'object' as const, properties: t.parameters },
      }));

      const messages = request.messages?.length
        ? (normalizeMessages(request.messages, 'anthropic') as AnthropicMessage[])
        : [{ role: 'user' as const, content: request.userPrompt }];

      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens,
        system: request.systemPrompt,
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      });

      // Extract tool calls and thinking from response
      const toolCalls: ToolCall[] = [];
      let textContent = '';
      let thinking: string | undefined;

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            tool: block.name,
            parameters: block.input as Record<string, unknown>,
          });
        } else if ((block as any).type === 'thinking') {
          thinking = (block as any).thinking;
        }
      }

      return {
        content: textContent,
        thinking,
        toolCalls,
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        model: response.model,
        stopReason:
          response.stop_reason === 'tool_use'
            ? 'tool_use'
            : response.stop_reason === 'max_tokens'
              ? 'max_tokens'
              : 'end_turn',
      };
    },
  };
}

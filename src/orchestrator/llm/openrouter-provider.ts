/**
 * OpenRouter LLM Provider — uses OpenAI-compatible API via raw fetch.
 *
 * No SDK dependency. Guarded by OPENROUTER_API_KEY env var.
 * Models configurable via OPENROUTER_{FAST,BALANCED,POWERFUL}_MODEL env vars.
 *
 * Source of truth: spec/tdd.md §17.1, https://openrouter.ai/docs
 */
import { PromptTooLargeError } from '../types.ts';
import type { LLMProvider, LLMRequest, LLMResponse, ToolCall } from '../types.ts';
import { normalizeMessages } from './provider-format.ts';
import type { OpenAIMessage } from './provider-format.ts';
import { retryWithBackoff, DEFAULT_RETRYABLE_STATUSES } from './retry.ts';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS: Record<LLMProvider['tier'], number> = {
  fast: 15_000,
  balanced: 60_000,
  powerful: 60_000,
};

const DEFAULT_MODELS: Record<LLMProvider['tier'], string> = {
  fast: 'google/gemini-2.0-flash-001',
  balanced: 'anthropic/claude-sonnet-4',
  powerful: 'anthropic/claude-opus-4',
};

export interface OpenRouterProviderConfig {
  tier: LLMProvider['tier'];
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export function createOpenRouterProvider(config: OpenRouterProviderConfig): LLMProvider | null {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const envModelKey = `OPENROUTER_${config.tier.toUpperCase()}_MODEL`;
  const model = config.model ?? process.env[envModelKey] ?? DEFAULT_MODELS[config.tier];
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS[config.tier];

  return {
    id: `openrouter/${config.tier}/${model}`,
    tier: config.tier,

    async generate(request: LLMRequest): Promise<LLMResponse> {
      const body: Record<string, unknown> = {
        model,
        max_tokens: request.maxTokens,
        messages: request.messages?.length
          ? [
              { role: 'system', content: request.systemPrompt },
              ...(normalizeMessages(request.messages, 'openai-compat') as OpenAIMessage[]),
            ]
          : [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
      };

      if (request.temperature !== undefined) {
        body.temperature = request.temperature;
      }

      // Convert tools to OpenAI function-calling format
      if (request.tools?.length) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
      }

      return retryWithBackoff(
        async (signal) => {
          const response = await fetch(OPENROUTER_BASE_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/vinyan-agent',
              'X-Title': 'Vinyan Agent',
            },
            body: JSON.stringify(body),
            signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 413 || errorText.includes('context_length_exceeded') || errorText.includes('too large')) {
              const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
              throw new PromptTooLargeError(estimate, `openrouter/${model}`, new Error(errorText));
            }
            // Attach status for retry logic
            const err = new Error(`OpenRouter API error ${response.status}: ${errorText}`);
            (err as any).status = response.status;
            // Attach retry-after header for backoff
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) (err as any).retryAfterHeader = retryAfter;
            throw err;
          }

          const data = (await response.json()) as OpenRouterResponse;
          const choice = data.choices?.[0];
          if (!choice) throw new Error('OpenRouter returned empty choices');

          const toolCalls: ToolCall[] = [];
          if (choice.message?.tool_calls) {
            for (const tc of choice.message.tool_calls) {
              if (tc.type === 'function') {
                let params: Record<string, unknown> = {};
                try { params = JSON.parse(tc.function.arguments); } catch {
                  console.warn(`[openrouter] Malformed tool arguments for ${tc.function.name}, using empty params`);
                }
                toolCalls.push({ id: tc.id, tool: tc.function.name, parameters: params });
              }
            }
          }

          const stopReason: LLMResponse['stopReason'] =
            choice.finish_reason === 'tool_calls' ? 'tool_use'
              : choice.finish_reason === 'length' ? 'max_tokens'
                : 'end_turn';

          return {
            content: choice.message?.content ?? '',
            toolCalls,
            tokensUsed: {
              input: data.usage?.prompt_tokens ?? 0,
              output: data.usage?.completion_tokens ?? 0,
            },
            model: data.model ?? model,
            stopReason,
          };
        },
        {
          maxRetries: 3,
          baseDelayMs: 1_000,
          retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
          timeoutMs,
          parseRetryAfter: (error: unknown) => {
            const header = (error as any)?.retryAfterHeader;
            if (!header) return undefined;
            const parsed = parseInt(header, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
          },
        },
      );
    },
  };
}

/** Register all 3 tiers from a single API key. */
export function registerOpenRouterProviders(
  registry: { register(provider: LLMProvider): void },
  apiKey?: string,
): number {
  let count = 0;
  for (const tier of ['fast', 'balanced', 'powerful'] as const) {
    const provider = createOpenRouterProvider({ tier, apiKey });
    if (provider) {
      registry.register(provider);
      count++;
    }
  }
  return count;
}

// ── OpenRouter response types ────────────────────────────────────────

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model?: string;
}

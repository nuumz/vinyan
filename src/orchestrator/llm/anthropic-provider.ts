/**
 * Anthropic LLM Provider — wraps @anthropic-ai/sdk for Claude models.
 *
 * Optional dependency: install with `bun add @anthropic-ai/sdk` to enable.
 * OpenRouter (openrouter-provider.ts) is the recommended primary provider.
 * Guarded by ANTHROPIC_API_KEY environment variable.
 * Source of truth: spec/tdd.md §17.1
 */
import type { LLMProvider, LLMRequest, LLMResponse, ThinkingConfig, ToolCall } from '../types.ts';
import { normalizeMessages } from './provider-format.ts';
import type { AnthropicMessage } from './provider-format.ts';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const DEFAULT_TIMEOUT_MS: Record<LLMProvider['tier'], number> = {
  fast: 30_000,
  balanced: 60_000,
  powerful: 60_000,
};

function isAnthropicRetryable(error: unknown): boolean {
  if (error instanceof Error && error.message.includes('timeout')) return true;
  const status = (error as any)?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  const msg = (error as Error)?.message ?? '';
  return msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
}

export interface AnthropicProviderConfig {
  id?: string;
  tier?: LLMProvider['tier'];
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
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
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS[config.tier ?? 'balanced'];

  return {
    id: config.id ?? `anthropic/${model}`,
    tier: config.tier ?? 'balanced',
    async generate(request: LLMRequest): Promise<LLMResponse> {
      // Build tool definitions for Anthropic format
      const tools = request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as { type: 'object'; properties: Record<string, unknown> },
      }));

      const messages = request.messages?.length
        ? (normalizeMessages(request.messages, 'anthropic') as AnthropicMessage[])
        : [{ role: 'user' as const, content: request.userPrompt }];

      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const thinkingEnabled = isThinkingEnabled(request.thinking);
          const response = await client.messages.create({
            model,
            max_tokens: request.maxTokens,
            system: request.cacheControl
              ? [{ type: 'text' as const, text: request.systemPrompt, cache_control: request.cacheControl }]
              : request.systemPrompt,
            messages,
            ...(tools?.length ? { tools } : {}),
            ...(!thinkingEnabled && request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...buildThinkingParams(request.thinking),
            signal: controller.signal as any,
          });
          clearTimeout(timer);

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
              thinking = thinking ? `${thinking}\n---\n${(block as any).thinking}` : (block as any).thinking;
            }
          }

          return {
            content: textContent,
            thinking,
            toolCalls,
            tokensUsed: {
              input: response.usage.input_tokens,
              output: response.usage.output_tokens,
              cacheRead: (response.usage as any).cache_read_input_tokens,
              cacheCreation: (response.usage as any).cache_creation_input_tokens,
            },
            model: response.model,
            stopReason:
              response.stop_reason === 'tool_use'
                ? 'tool_use'
                : response.stop_reason === 'max_tokens'
                  ? 'max_tokens'
                  : 'end_turn',
          };
        } catch (error) {
          clearTimeout(timer);
          controller.abort(); // Cancel in-flight request on error
          lastError = error instanceof Error ? error
            : new Error(controller.signal.aborted ? `Anthropic API timeout after ${timeoutMs}ms` : String(error));
          if (attempt < MAX_RETRIES && isAnthropicRetryable(error)) {
            const retryAfter = (error as any)?.headers?.get?.('retry-after');
            const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
            const delay = Number.isFinite(parsed) && parsed > 0
              ? parsed * 1000
              : BASE_DELAY_MS * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw lastError;
        }
      }
      throw lastError!;
    },
  };
}

/** Check if thinking is active (adaptive or enabled). */
function isThinkingEnabled(thinking?: ThinkingConfig): boolean {
  return thinking?.type === 'adaptive' || thinking?.type === 'enabled';
}

/** Build thinking-related API params from ThinkingConfig. */
function buildThinkingParams(thinking?: ThinkingConfig): Record<string, unknown> {
  if (!thinking || thinking.type === 'disabled') return {};
  if (thinking.type === 'adaptive') {
    return {
      thinking: { type: 'adaptive', ...(thinking.display ? { display: thinking.display } : {}) },
      output_config: { effort: thinking.effort },
    };
  }
  // type === 'enabled'
  return {
    thinking: { type: 'enabled', budget_tokens: thinking.budgetTokens, ...(thinking.display ? { display: thinking.display } : {}) },
  };
}

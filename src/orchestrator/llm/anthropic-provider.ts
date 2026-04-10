/**
 * Anthropic LLM Provider — wraps @anthropic-ai/sdk for Claude models.
 *
 * Optional dependency: install with `bun add @anthropic-ai/sdk` to enable.
 * OpenRouter (openrouter-provider.ts) is the recommended primary provider.
 * Guarded by ANTHROPIC_API_KEY environment variable.
 * Source of truth: spec/tdd.md §17.1
 */
import { PromptTooLargeError } from '../types.ts';
import type { CacheControl, LLMProvider, LLMRequest, LLMResponse, ThinkingConfig, ToolCall } from '../types.ts';
import { normalizeMessages } from './provider-format.ts';
import type { AnthropicMessage } from './provider-format.ts';
import { retryWithBackoff, DEFAULT_RETRYABLE_STATUSES } from './retry.ts';

/**
 * Map CacheControl tier to Anthropic cache_control decision.
 * static/session → cache_control: { type: 'ephemeral' } (Anthropic's only cache type — content stability drives hits)
 * ephemeral → NO cache_control (dynamic per-task content, don't pollute cache)
 */
function shouldCache(cc?: CacheControl): boolean {
  return cc?.type === 'static' || cc?.type === 'session';
}

const DEFAULT_TIMEOUT_MS: Record<LLMProvider['tier'], number> = {
  fast: 30_000,
  balanced: 60_000,
  powerful: 60_000,
  'tool-uses': 30_000,
};

const INSTRUCTION_HEADER = '[PROJECT INSTRUCTIONS]';

/**
 * Build user messages with optional instruction cache block splitting.
 * When instructionCacheControl is set and the user prompt contains a
 * [PROJECT INSTRUCTIONS] section, split into two content blocks so
 * Anthropic can cache the instruction prefix separately (session-stable).
 */
function buildUserMessages(request: LLMRequest): AnthropicMessage[] {
  const icc = request.instructionCacheControl;
  if (icc && shouldCache(icc)) {
    const idx = request.userPrompt.indexOf(INSTRUCTION_HEADER);
    if (idx > -1) {
      // Find end of instruction block — next section header or end of prompt
      const nextHeader = request.userPrompt.indexOf('\n[', idx + INSTRUCTION_HEADER.length);
      const instructionEnd = nextHeader > -1 ? nextHeader : request.userPrompt.length;
      const instructionBlock = request.userPrompt.slice(0, instructionEnd);
      const taskBlock = request.userPrompt.slice(instructionEnd);
      const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
        { type: 'text', text: instructionBlock, cache_control: { type: 'ephemeral' } },
      ];
      if (taskBlock.trim()) {
        blocks.push({ type: 'text', text: taskBlock });
      }
      return [{ role: 'user', content: blocks }];
    }
  }
  return [{ role: 'user', content: request.userPrompt }];
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
        : buildUserMessages(request);

      return retryWithBackoff(
        async (signal) => {
          const thinkingEnabled = isThinkingEnabled(request.thinking);
          const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
            {
              type: 'text' as const,
              text: request.systemPrompt,
              ...(shouldCache(request.cacheControl) ? { cache_control: { type: 'ephemeral' as const } } : {}),
            },
          ];

          const response = await client.messages.create({
            model,
            max_tokens: request.maxTokens,
            system: systemBlocks,
            messages,
            ...(tools?.length ? { tools } : {}),
            ...(!thinkingEnabled && request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...buildThinkingParams(request.thinking),
            signal: signal as any,
          });

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
        },
        {
          maxRetries: 3,
          baseDelayMs: 1_000,
          retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
          timeoutMs,
          isRetryableError: (error: Error) => {
            if (error.message.includes('timeout')) return true;
            const msg = error.message;
            return msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
          },
          parseRetryAfter: (error: unknown) => {
            // PromptTooLargeError should not be retried
            if (error instanceof PromptTooLargeError) return undefined;
            // Check for 413 before retry
            const status = (error as any)?.status;
            const msg = (error as Error)?.message ?? '';
            if (status === 413 || msg.includes('too large') || msg.includes('maximum context length')) {
              const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
              throw new PromptTooLargeError(estimate, `anthropic/${model}`, error);
            }
            const retryAfter = (error as any)?.headers?.get?.('retry-after');
            if (!retryAfter) return undefined;
            const parsed = parseInt(retryAfter, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
          },
        },
      );
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
  if (thinking.type === 'enabled') {
    return {
      thinking: { type: 'enabled', budget_tokens: thinking.budgetTokens, ...(thinking.display ? { display: thinking.display } : {}) },
    };
  }
  // Future thinking types (multi-hypothesis, counterfactual, etc.) — types defined in types.ts, provider support not yet implemented
  return {};
}

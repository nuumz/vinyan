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

/**
 * Map CacheControl tier to Anthropic cache_control decision.
 * static/session → cache_control: { type: 'ephemeral' } (Anthropic's only cache type — content stability drives hits)
 * ephemeral → NO cache_control (dynamic per-task content, don't pollute cache)
 */
function shouldCache(cc?: CacheControl): boolean {
  return cc?.type === 'static' || cc?.type === 'session';
}

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

      let lastError: Error | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const thinkingEnabled = isThinkingEnabled(request.thinking);
          // Build system blocks with tier-aware cache_control
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
          // 413 Payload Too Large → throw PromptTooLargeError for worker-level recovery
          const status = (error as any)?.status;
          const msg = lastError.message;
          if (status === 413 || msg.includes('too large') || msg.includes('maximum context length')) {
            const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
            throw new PromptTooLargeError(estimate, `anthropic/${model}`, error);
          }
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
  if (thinking.type === 'enabled') {
    return {
      thinking: { type: 'enabled', budget_tokens: thinking.budgetTokens, ...(thinking.display ? { display: thinking.display } : {}) },
    };
  }
  // Future thinking types (multi-hypothesis, counterfactual, etc.) — not yet implemented
  return {};
}

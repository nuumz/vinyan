/**
 * Anthropic LLM Provider — wraps @anthropic-ai/sdk for Claude models.
 *
 * Optional dependency: install with `bun add @anthropic-ai/sdk` to enable.
 * OpenRouter (openrouter-provider.ts) is the recommended primary provider.
 * Guarded by ANTHROPIC_API_KEY environment variable.
 * Source of truth: spec/tdd.md §17.1
 */

import type { LLMProvider, LLMRequest, LLMResponse, OnTextDelta, ThinkingConfig, ToolCall } from '../types.ts';
import { PromptTooLargeError } from '../types.ts';
import type { AnthropicMessage } from './provider-format.ts';
import { normalizeMessages } from './provider-format.ts';
import { DEFAULT_RETRYABLE_STATUSES, retryStreamWithBackoff, retryWithBackoff } from './retry.ts';

/**
 * Wall-clock timeout for non-streaming `generate()`. Long because the caller
 * has no progress signal during the request — Anthropic holds the connection
 * open until thinking + output are both fully composed. Streaming callers use
 * `DEFAULT_STREAM_TIMEOUTS` (idle-timer based) instead.
 */
const DEFAULT_TIMEOUT_MS: Record<LLMProvider['tier'], number> = {
  fast: 30_000,
  balanced: 180_000,
  powerful: 180_000,
  'tool-uses': 30_000,
};

interface StreamTimeouts {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  wallClockMs: number;
}

const DEFAULT_STREAM_TIMEOUTS: Record<LLMProvider['tier'], StreamTimeouts> = {
  fast: { connectTimeoutMs: 15_000, idleTimeoutMs: 60_000, wallClockMs: 300_000 },
  balanced: { connectTimeoutMs: 30_000, idleTimeoutMs: 90_000, wallClockMs: 600_000 },
  powerful: { connectTimeoutMs: 30_000, idleTimeoutMs: 90_000, wallClockMs: 600_000 },
  'tool-uses': { connectTimeoutMs: 15_000, idleTimeoutMs: 60_000, wallClockMs: 300_000 },
};

/** Anthropic content block with optional cache marker — used for both system and user paths. */
export type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Plan commit B: split a rendered prompt into Anthropic content blocks at
 * tier boundaries. Attaches `cache_control: { type: 'ephemeral' }` at the
 * frozen boundary and session boundary so the stable prefix stays cached
 * while the turn-volatile suffix is sent fresh every request.
 *
 * Behaviour:
 *   - Empty text → empty block array (caller handles "no messages").
 *   - frozen-only  → one block, cache marker at the end.
 *   - frozen + session → two blocks, each with a cache marker.
 *   - frozen + session + turn → three blocks; markers on the first two.
 *   - session-only / turn-only variants degrade symmetrically.
 *
 * Invariant: blocks are joined in order to reproduce the original text, and
 * there are at most 2 cache markers per prompt (well within Anthropic's
 * 4-breakpoint limit per request across system + messages).
 *
 * Exported for unit-testing without spinning up the Anthropic SDK.
 */
export function splitAtTiers(
  text: string,
  offsets?: { frozenEnd: number; sessionEnd: number; totalEnd: number },
): AnthropicTextBlock[] {
  if (text.length === 0) return [];
  if (!offsets) return [{ type: 'text', text }];

  const { frozenEnd, sessionEnd, totalEnd } = offsets;
  const blocks: AnthropicTextBlock[] = [];

  const frozenText = text.slice(0, frozenEnd);
  const sessionText = text.slice(frozenEnd, sessionEnd);
  const turnText = text.slice(sessionEnd, totalEnd);

  if (frozenText.length > 0) {
    blocks.push({
      type: 'text',
      text: frozenText,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (sessionText.length > 0) {
    blocks.push({
      type: 'text',
      text: sessionText,
      cache_control: { type: 'ephemeral' },
    });
  }
  if (turnText.length > 0) {
    blocks.push({ type: 'text', text: turnText });
  }

  return blocks;
}

/**
 * Build user messages. Plan commit B: when `request.tiers.user` is set the
 * user prompt is split at tier boundaries (see splitAtTiers). Otherwise a
 * single unsplit block is returned (no cache markers — caller didn't
 * supply tier offsets).
 *
 * Exported for unit tests.
 */
export function buildUserMessages(request: LLMRequest): AnthropicMessage[] {
  const userTiers = request.tiers?.user;
  if (userTiers && request.userPrompt.length > 0) {
    const blocks = splitAtTiers(request.userPrompt, userTiers);
    return [
      {
        role: 'user',
        content: blocks.length > 0 ? blocks : [{ type: 'text', text: request.userPrompt }],
      },
    ];
  }
  return [{ role: 'user', content: request.userPrompt }];
}

/**
 * Build system content blocks. Plan commit B: when `request.tiers.system` is
 * set, split the system prompt into frozen / session / turn segments and
 * place cache markers at tier boundaries. Without tiers, a single unsplit
 * block with no cache marker is returned.
 *
 * Exported for unit tests.
 */
export function buildSystemBlocks(request: LLMRequest): AnthropicTextBlock[] {
  const systemTiers = request.tiers?.system;
  if (systemTiers && request.systemPrompt.length > 0) {
    const blocks = splitAtTiers(request.systemPrompt, systemTiers);
    if (blocks.length > 0) return blocks;
  }

  return [{ type: 'text', text: request.systemPrompt }];
}

export interface AnthropicProviderConfig {
  id?: string;
  tier?: LLMProvider['tier'];
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  streamTimeouts?: Partial<StreamTimeouts>;
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
  const tier = config.tier ?? 'balanced';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS[tier];
  const streamTimeouts: StreamTimeouts = {
    ...DEFAULT_STREAM_TIMEOUTS[tier],
    ...config.streamTimeouts,
  };

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
          const systemBlocks = buildSystemBlocks(request);

          const response = await client.messages.create({
            model,
            max_tokens: request.maxTokens,
            system: systemBlocks,
            messages,
            ...(tools?.length ? { tools } : {}),
            ...(!thinkingEnabled && request.temperature !== undefined ? { temperature: request.temperature } : {}),
            // G3 per-phase sampling: forward top_p / top_k / stop_sequences when set.
            // Anthropic forbids top_p + temperature together when thinking is on; the
            // SDK already nulls temperature in that case so top_p stands alone.
            ...(request.topP !== undefined ? { top_p: request.topP } : {}),
            ...(request.topK !== undefined ? { top_k: request.topK } : {}),
            ...(request.stopSequences && request.stopSequences.length > 0
              ? { stop_sequences: request.stopSequences }
              : {}),
            // G4 structured output: when the caller declares a response_format,
            // pin tool_choice so the model MUST emit the named tool. Anthropic
            // does not have a direct json_schema parameter, so json_schema is
            // mapped onto a tool whose name = `responseFormat.name ?? 'output'`
            // (the caller is responsible for including a matching tool
            // definition in `tools[]`).
            ...buildAnthropicToolChoice(request.responseFormat),
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

    async generateStream(request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse> {
      const tools = request.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as { type: 'object'; properties: Record<string, unknown> },
      }));
      const messages = request.messages?.length
        ? (normalizeMessages(request.messages, 'anthropic') as AnthropicMessage[])
        : buildUserMessages(request);
      const thinkingEnabled = isThinkingEnabled(request.thinking);
      const systemBlocks = buildSystemBlocks(request);

      return retryStreamWithBackoff(
        async (signal, hooks) => {
          const stream = client.messages.stream(
            {
              model,
              max_tokens: request.maxTokens,
              system: systemBlocks,
              messages,
              ...(tools?.length ? { tools } : {}),
              ...(!thinkingEnabled && request.temperature !== undefined ? { temperature: request.temperature } : {}),
              // G3 per-phase sampling — same forwarding as the non-streaming path.
              ...(request.topP !== undefined ? { top_p: request.topP } : {}),
              ...(request.topK !== undefined ? { top_k: request.topK } : {}),
              ...(request.stopSequences && request.stopSequences.length > 0
                ? { stop_sequences: request.stopSequences }
                : {}),
              // G4 structured output — same tool_choice enforcement as the
              // non-streaming path so callers that opt into responseFormat get
              // the same shape guarantee on streaming.
              ...buildAnthropicToolChoice(request.responseFormat),
              ...buildThinkingParams(request.thinking),
            },
            { signal },
          );

          // Every event off the wire — text delta, ping, content_block_start,
          // anything — counts as activity so the idle timer doesn't fire
          // mid-stream on a slow-but-healthy generation.
          stream.on('streamEvent', () => hooks.activity());
          stream.on('text', (textDelta: string) => {
            if (textDelta) onDelta({ text: textDelta });
          });

          const final = await stream.finalMessage();
          const toolCalls: ToolCall[] = [];
          let textContent = '';
          let thinking: string | undefined;
          for (const block of final.content) {
            if (block.type === 'text') textContent += block.text;
            else if (block.type === 'tool_use') {
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
              input: final.usage.input_tokens,
              output: final.usage.output_tokens,
              cacheRead: (final.usage as any).cache_read_input_tokens,
              cacheCreation: (final.usage as any).cache_creation_input_tokens,
            },
            model: final.model,
            stopReason:
              final.stop_reason === 'tool_use'
                ? 'tool_use'
                : final.stop_reason === 'max_tokens'
                  ? 'max_tokens'
                  : 'end_turn',
          };
        },
        {
          maxRetries: 3,
          baseDelayMs: 1_000,
          retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
          ...streamTimeouts,
          isRetryableError: (error: Error) => {
            if (error.message.includes('timeout')) return true;
            const msg = error.message;
            return msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
          },
          parseRetryAfter: (error: unknown) => {
            if (error instanceof PromptTooLargeError) return undefined;
            const status = (error as { status?: number })?.status;
            const msg = (error as Error)?.message ?? '';
            if (status === 413 || msg.includes('too large') || msg.includes('maximum context length')) {
              const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
              throw new PromptTooLargeError(estimate, `anthropic/${model}`, error);
            }
            const retryAfter = (error as { headers?: { get?: (k: string) => string | null } })?.headers?.get?.(
              'retry-after',
            );
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
      thinking: {
        type: 'enabled',
        budget_tokens: thinking.budgetTokens,
        ...(thinking.display ? { display: thinking.display } : {}),
      },
    };
  }
  // Future thinking types (multi-hypothesis, counterfactual, etc.) — types defined in types.ts, provider support not yet implemented
  return {};
}

/**
 * G4 structured output: translate `LLMRequest.responseFormat` into an Anthropic
 * `tool_choice` clause. Returns `{}` when the caller didn't ask for structured
 * output so the existing call sites stay bit-exact.
 *
 * Anthropic does not expose a direct `response_format: json_schema` field;
 * the supported pattern is "force a specific tool call". Both `tool_use_required`
 * and `json_schema` therefore resolve to a `tool_choice: { type: 'tool', name }`.
 *
 * Caller responsibility: include the matching tool definition in `tools[]`. The
 * provider does NOT synthesize a tool — that would hide the contract from the
 * caller and from the prompt cache (the tool description matters for caching).
 */
function buildAnthropicToolChoice(responseFormat?: import('../types.ts').ResponseFormat): Record<string, unknown> {
  if (!responseFormat) return {};
  if (responseFormat.type === 'tool_use_required') {
    return { tool_choice: { type: 'tool', name: responseFormat.toolName } };
  }
  if (responseFormat.type === 'json_schema') {
    const name = responseFormat.name ?? 'output';
    return { tool_choice: { type: 'tool', name } };
  }
  return {};
}

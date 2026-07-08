/**
 * Anthropic LLM Provider — uses the Messages API via raw fetch.
 *
 * No SDK dependency (mirrors openrouter-provider.ts). Guarded by
 * ANTHROPIC_API_KEY env var; model configurable via ANTHROPIC_MODEL.
 *
 * Source of truth: spec/tdd.md §17.1, https://platform.claude.com/docs/en/api
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { LLMProvider, LLMRequest, LLMResponse, OnTextDelta, ThinkingConfig, ToolCall } from '../types.ts';
import { PromptTooLargeError } from '../types.ts';
import { getCurrentLLMTrace } from './llm-trace-context.ts';
import { classifyProviderError, LLMProviderError } from './provider-errors.ts';
import type { AnthropicMessage } from './provider-format.ts';
import { normalizeMessages } from './provider-format.ts';
import {
  DEFAULT_RETRYABLE_STATUSES,
  type OnRetryAttempt,
  type OnRetryHeartbeat,
  retryStreamWithBackoff,
  retryWithBackoff,
} from './retry.ts';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Default model. Must stay on a 4.6-family model: this provider forwards
 * per-phase sampling params (temperature / top_p / top_k), which Anthropic
 * rejects with a 400 on Opus 4.7+ / Sonnet 5. The previous default
 * (`claude-sonnet-4-20250514`) is retired and 404s on every request.
 */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
  // tool-uses: aligned with balanced/powerful. Tool-schema-laden requests
  // routinely take >15s to first byte under load; 15s caused false-positive
  // connect timeouts that surfaced as `completed` tasks with empty output.
  'tool-uses': { connectTimeoutMs: 30_000, idleTimeoutMs: 90_000, wallClockMs: 600_000 },
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
 * Exported for unit-testing without hitting the Anthropic API.
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
  /**
   * Optional bus reference. When supplied, the provider emits
   * `llm:retry_attempt` per backoff sleep so downstream watchdogs can
   * treat retries as live activity. Omit for tests / standalone use.
   */
  bus?: VinyanBus;
}

export function createAnthropicProvider(config: AnthropicProviderConfig = {}): LLMProvider | null {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = config.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const tier = config.tier ?? 'balanced';
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS[tier];
  const streamTimeouts: StreamTimeouts = {
    ...DEFAULT_STREAM_TIMEOUTS[tier],
    ...config.streamTimeouts,
  };
  const providerId = config.id ?? `anthropic/${model}`;

  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };

  // Emit `llm:retry_attempt` per backoff sleep so the delegate watchdog
  // and dashboards see retry behaviour as live activity. taskId is
  // resolved via request.trace.traceId → ambient `runWithLLMTrace`. When
  // neither is set we suppress (no orphan event).
  const buildOnAttempt = (request: LLMRequest): OnRetryAttempt | undefined => {
    const bus = config.bus;
    if (!bus) return undefined;
    return (info) => {
      const taskId = request.trace?.traceId ?? getCurrentLLMTrace()?.traceId;
      if (!taskId) return;
      bus.emit('llm:retry_attempt', {
        taskId,
        providerId,
        attempt: info.attempt,
        delayMs: info.delayMs,
        reason: info.reason,
        ...(info.status !== undefined ? { status: info.status } : {}),
      });
    };
  };
  // In-flight heartbeat — emits `llm:request_alive` every 30s while the
  // request is awaiting. Closes the watchdog gap for long single LLM
  // calls (long-form author, large reasoning) that emit no other event.
  const buildOnHeartbeat = (request: LLMRequest): OnRetryHeartbeat | undefined => {
    const bus = config.bus;
    if (!bus) return undefined;
    return (info) => {
      const taskId = request.trace?.traceId ?? getCurrentLLMTrace()?.traceId;
      if (!taskId) return;
      bus.emit('llm:request_alive', {
        taskId,
        providerId,
        attempt: info.attempt,
        durationMs: info.durationMs,
      });
    };
  };

  /** Request body shared by generate/generateStream — identical wire shape, only `stream` differs. */
  const buildRequestBody = (request: LLMRequest, messages: AnthropicMessage[], stream: boolean) => {
    const thinkingEnabled = isThinkingEnabled(request.thinking);
    // Build tool definitions for Anthropic format
    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as { type: 'object'; properties: Record<string, unknown> },
    }));

    return {
      model,
      max_tokens: request.maxTokens,
      system: buildSystemBlocks(request),
      messages,
      ...(stream ? { stream: true } : {}),
      ...(tools?.length ? { tools } : {}),
      // Anthropic forbids temperature alongside thinking; suppress it when
      // thinking is on so top_p (if set) stands alone.
      ...(!thinkingEnabled && request.temperature !== undefined ? { temperature: request.temperature } : {}),
      // G3 per-phase sampling: forward top_p / top_k / stop_sequences when set.
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.topK !== undefined ? { top_k: request.topK } : {}),
      ...(request.stopSequences && request.stopSequences.length > 0 ? { stop_sequences: request.stopSequences } : {}),
      // G4 structured output: when the caller declares a response_format,
      // pin tool_choice so the model MUST emit the named tool. Anthropic
      // does not have a direct json_schema parameter, so json_schema is
      // mapped onto a tool whose name = `responseFormat.name ?? 'output'`
      // (the caller is responsible for including a matching tool
      // definition in `tools[]`).
      ...buildAnthropicToolChoice(request.responseFormat),
      ...buildThinkingParams(request.thinking),
    };
  };

  /** Map a non-2xx response to PromptTooLargeError or a normalized LLMProviderError. */
  const raiseHttpError = (response: Response, errorText: string, request: LLMRequest): never => {
    if (
      response.status === 413 ||
      errorText.includes('too large') ||
      errorText.includes('prompt is too long') ||
      errorText.includes('maximum context length')
    ) {
      const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
      throw new PromptTooLargeError(estimate, `anthropic/${model}`, new Error(errorText));
    }
    const normalized = classifyProviderError({
      kind: 'http',
      providerId,
      tier,
      providerName: 'Anthropic',
      model,
      status: response.status,
      bodyText: errorText,
      retryAfterHeader: response.headers.get('retry-after'),
    });
    throw new LLMProviderError(normalized);
  };

  const parseRetryAfter = (error: unknown): number | undefined => {
    if (error instanceof LLMProviderError && error.normalized.retryAfterMs !== undefined) {
      return error.normalized.retryAfterMs;
    }
    const header = (error as { retryAfterHeader?: string })?.retryAfterHeader;
    if (!header) return undefined;
    const parsed = parseInt(header, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
  };

  const isRetryableError = (error: Error): boolean => {
    if (error.message.includes('timeout')) return true;
    const msg = error.message;
    return msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT');
  };

  return {
    id: providerId,
    tier,

    async generate(request: LLMRequest): Promise<LLMResponse> {
      const requestTimeoutMs = request.timeoutMs ?? timeoutMs;
      const onAttempt = buildOnAttempt(request);
      const onHeartbeat = buildOnHeartbeat(request);
      const messages = request.messages?.length
        ? (normalizeMessages(request.messages, 'anthropic') as AnthropicMessage[])
        : buildUserMessages(request);
      const body = buildRequestBody(request, messages, false);

      return retryWithBackoff(
        async (signal) => {
          const response = await fetch(ANTHROPIC_BASE_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            raiseHttpError(response, errorText, request);
          }

          const data = (await response.json()) as AnthropicResponse;
          const { textContent, thinking, toolCalls } = collectResponseBlocks(data.content ?? []);

          return {
            content: textContent,
            thinking,
            toolCalls,
            tokensUsed: {
              input: data.usage?.input_tokens ?? 0,
              output: data.usage?.output_tokens ?? 0,
              cacheRead: data.usage?.cache_read_input_tokens,
              cacheCreation: data.usage?.cache_creation_input_tokens,
            },
            model: data.model ?? model,
            stopReason: mapStopReason(data.stop_reason),
          };
        },
        {
          maxRetries: 3,
          baseDelayMs: 1_000,
          retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
          timeoutMs: requestTimeoutMs,
          isRetryableError,
          parseRetryAfter,
          ...(onAttempt ? { onAttempt } : {}),
          ...(onHeartbeat ? { onHeartbeat } : {}),
        },
      );
    },

    async generateStream(request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse> {
      const onAttempt = buildOnAttempt(request);
      const onHeartbeat = buildOnHeartbeat(request);
      const effectiveStreamTimeouts = request.timeoutMs
        ? {
            connectTimeoutMs: Math.max(streamTimeouts.connectTimeoutMs, request.timeoutMs),
            idleTimeoutMs: Math.max(streamTimeouts.idleTimeoutMs, request.timeoutMs),
            wallClockMs: Math.max(streamTimeouts.wallClockMs, request.timeoutMs * 5),
          }
        : streamTimeouts;
      const messages = request.messages?.length
        ? (normalizeMessages(request.messages, 'anthropic') as AnthropicMessage[])
        : buildUserMessages(request);
      const body = buildRequestBody(request, messages, true);

      return retryStreamWithBackoff(
        async (signal, hooks) => {
          const response = await fetch(ANTHROPIC_BASE_URL, {
            method: 'POST',
            headers: { ...headers, accept: 'text/event-stream' },
            body: JSON.stringify(body),
            signal,
          });

          // Headers received → connection is alive. Idle timer takes over from
          // here; the connect timer is cancelled by firstByte().
          hooks.firstByte();

          if (!response.ok || !response.body) {
            const errorText = await response.text().catch(() => '');
            raiseHttpError(response, errorText, request);
            throw new Error('unreachable'); // raiseHttpError always throws; keeps tsc's body-null narrowing happy
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          const state = createStreamState();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Any bytes off the wire — content, ping, or empty heartbeat —
              // count as activity. This is the contract that prevents a
              // healthy-but-slow stream from being killed.
              hooks.activity();
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                const chunk = parseSSELine(line);
                if (chunk) applyStreamChunk(chunk, state, onDelta);
              }
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              /* ignore */
            }
          }

          return finalizeStreamResponse(state, model);
        },
        {
          maxRetries: 3,
          baseDelayMs: 1_000,
          retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
          ...effectiveStreamTimeouts,
          isRetryableError,
          parseRetryAfter,
          ...(onAttempt ? { onAttempt } : {}),
          ...(onHeartbeat ? { onHeartbeat } : {}),
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

/** Fold response content blocks into text / thinking / toolCalls accumulators. */
function collectResponseBlocks(blocks: AnthropicResponseBlock[]): {
  textContent: string;
  thinking: string | undefined;
  toolCalls: ToolCall[];
} {
  const toolCalls: ToolCall[] = [];
  let textContent = '';
  let thinking: string | undefined;

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? '',
        tool: block.name ?? '',
        parameters: (block.input ?? {}) as Record<string, unknown>,
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinking = thinking ? `${thinking}\n---\n${block.thinking}` : block.thinking;
    }
  }

  return { textContent, thinking, toolCalls };
}

function mapStopReason(stopReason: string | null | undefined): LLMResponse['stopReason'] {
  return stopReason === 'tool_use' ? 'tool_use' : stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
}

// ── SSE stream state machine ─────────────────────────────────────────

/**
 * Mutable accumulator for one streaming attempt. Thinking / tool_use blocks
 * accumulate per content-block index — Anthropic streams `thinking_delta` /
 * `input_json_delta` fragments scoped to the block announced by
 * `content_block_start`.
 */
interface StreamState {
  contentAcc: string;
  thinkingAcc: Map<number, string>;
  toolAcc: Map<number, { id: string; name: string; args: string }>;
  stopReasonRaw?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheCreation?: number;
  modelId?: string;
}

function createStreamState(): StreamState {
  return {
    contentAcc: '',
    thinkingAcc: new Map(),
    toolAcc: new Map(),
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Extract the JSON payload from one SSE line. Returns undefined for event:/comment/heartbeat/malformed lines. */
function parseSSELine(line: string): AnthropicStreamChunk | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return undefined;
  try {
    return JSON.parse(trimmed.slice(5).trim()) as AnthropicStreamChunk;
  } catch {
    return undefined;
  }
}

/** Fold one Anthropic SSE event into the stream state. Throws on `error` events so retry classification applies. */
function applyStreamChunk(chunk: AnthropicStreamChunk, state: StreamState, onDelta: OnTextDelta): void {
  switch (chunk.type) {
    case 'message_start': {
      const usage = chunk.message?.usage;
      if (chunk.message?.model) state.modelId = chunk.message.model;
      if (usage) {
        state.inputTokens = usage.input_tokens ?? 0;
        state.cacheRead = usage.cache_read_input_tokens;
        state.cacheCreation = usage.cache_creation_input_tokens;
      }
      break;
    }
    case 'content_block_start': {
      const block = chunk.content_block;
      if (block?.type === 'tool_use' && chunk.index !== undefined) {
        state.toolAcc.set(chunk.index, { id: block.id ?? '', name: block.name ?? '', args: '' });
      }
      break;
    }
    case 'content_block_delta':
      if (chunk.delta && chunk.index !== undefined) applyContentDelta(chunk.delta, chunk.index, state, onDelta);
      break;
    case 'message_delta': {
      if (chunk.delta?.stop_reason) state.stopReasonRaw = chunk.delta.stop_reason;
      if (chunk.usage?.output_tokens !== undefined) state.outputTokens = chunk.usage.output_tokens;
      break;
    }
    case 'error':
      throw new Error(`Anthropic stream error: ${chunk.error?.message ?? 'unknown'}`);
    default:
      // ping / content_block_stop / message_stop — no state to record
      break;
  }
}

function applyContentDelta(
  delta: NonNullable<AnthropicStreamChunk['delta']>,
  index: number,
  state: StreamState,
  onDelta: OnTextDelta,
): void {
  if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
    state.contentAcc += delta.text;
    onDelta({ text: delta.text });
  } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    state.thinkingAcc.set(index, (state.thinkingAcc.get(index) ?? '') + delta.thinking);
  } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
    const existing = state.toolAcc.get(index);
    if (existing) existing.args += delta.partial_json;
  }
}

/** Convert the accumulated stream state into the provider-neutral LLMResponse. */
function finalizeStreamResponse(state: StreamState, fallbackModel: string): LLMResponse {
  const toolCalls: ToolCall[] = [];
  for (const { id, name, args } of state.toolAcc.values()) {
    if (!name) continue;
    let params: Record<string, unknown> = {};
    try {
      params = args ? (JSON.parse(args) as Record<string, unknown>) : {};
    } catch {
      /* use empty */
    }
    toolCalls.push({ id: id || `tc_${name}`, tool: name, parameters: params });
  }
  const thinking = state.thinkingAcc.size > 0 ? [...state.thinkingAcc.values()].join('\n---\n') : undefined;

  return {
    content: state.contentAcc,
    thinking,
    toolCalls,
    tokensUsed: {
      input: state.inputTokens,
      output: state.outputTokens,
      cacheRead: state.cacheRead,
      cacheCreation: state.cacheCreation,
    },
    model: state.modelId ?? fallbackModel,
    stopReason: mapStopReason(state.stopReasonRaw),
  };
}

// ── Anthropic wire types ─────────────────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponseBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicResponseBlock[];
  usage?: AnthropicUsage;
  model?: string;
  stop_reason?: string | null;
}

interface AnthropicStreamChunk {
  type: string;
  index?: number;
  message?: { model?: string; usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

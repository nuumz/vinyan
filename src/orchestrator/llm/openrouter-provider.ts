/**
 * OpenRouter LLM Provider — uses OpenAI-compatible API via raw fetch.
 *
 * No SDK dependency. Guarded by OPENROUTER_API_KEY env var.
 * Models configurable via OPENROUTER_{FAST,BALANCED,POWERFUL}_MODEL env vars.
 *
 * Source of truth: spec/tdd.md §17.1, https://openrouter.ai/docs
 */

import type { LLMProvider, LLMRequest, LLMResponse, OnTextDelta, ToolCall } from '../types.ts';
import { PromptTooLargeError } from '../types.ts';
import { clampOpenRouterId, type LLMTraceMetadata, resolveLLMTrace } from './llm-trace-context.ts';
import type { OpenAIMessage } from './provider-format.ts';
import { normalizeMessages } from './provider-format.ts';
import { DEFAULT_RETRYABLE_STATUSES, retryStreamWithBackoff, retryWithBackoff } from './retry.ts';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Wall-clock timeout for non-streaming `generate()` calls. Generous because the
 * caller has no progress signal during the request — the provider holds the
 * connection open until the full response is composed. Streaming callers use
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

const DEFAULT_MODELS: Record<LLMProvider['tier'], string> = {
  fast: 'google/gemma-4-26b-a4b-it:free',
  balanced: 'google/gemma-4-31b-it:free',
  powerful: 'anthropic/claude-opus-4.6',
  'tool-uses': 'nvidia/nemotron-3-super-120b-a12b:free',
};

export interface OpenRouterProviderConfig {
  tier: LLMProvider['tier'];
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  streamTimeouts?: Partial<StreamTimeouts>;
}

export function createOpenRouterProvider(config: OpenRouterProviderConfig): LLMProvider | null {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const envModelKey = `OPENROUTER_${config.tier.toUpperCase().replace(/-/g, '_')}_MODEL`;
  const model = config.model ?? process.env[envModelKey] ?? DEFAULT_MODELS[config.tier];
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS[config.tier];
  const streamTimeouts: StreamTimeouts = {
    ...DEFAULT_STREAM_TIMEOUTS[config.tier],
    ...config.streamTimeouts,
  };

  return {
    id: `openrouter/${config.tier}/${model}`,
    tier: config.tier,

    async generate(request: LLMRequest): Promise<LLMResponse> {
      const requestTimeoutMs = request.timeoutMs ?? timeoutMs;
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

      // G3 per-phase sampling — OpenAI-compatible. top_k is intentionally
      // omitted: standard chat completions don't accept it (Anthropic-only).
      if (request.topP !== undefined) body.top_p = request.topP;
      if (request.stopSequences && request.stopSequences.length > 0) {
        body.stop = request.stopSequences;
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

      // G4 structured output — OpenAI-compatible. tool_use_required maps to
      // `tool_choice: { type: 'function', function: { name } }`. json_schema
      // maps to `response_format: { type: 'json_schema', ... }` which most
      // OpenRouter backends now honor (passes through to OpenAI / Anthropic
      // as the underlying provider supports). Backends that ignore it fall
      // back gracefully — the structured-output validator catches parse fail
      // and retries with feedback (PR #30 semantics).
      const fmt = request.responseFormat;
      if (fmt) {
        if (fmt.type === 'tool_use_required') {
          body.tool_choice = { type: 'function', function: { name: fmt.toolName } };
        } else if (fmt.type === 'json_schema') {
          body.response_format = {
            type: 'json_schema',
            json_schema: {
              name: fmt.name ?? 'output',
              schema: fmt.schema,
              strict: true,
            },
          };
        }
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/vinyan-agent',
        'X-Title': 'Vinyan Agent',
      };
      applyTraceMetadata(body, headers, request.trace);

      return retryWithBackoff(
        async (signal) => {
          const response = await fetch(OPENROUTER_BASE_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });

          if (!response.ok) {
            const errorText = await response.text();
            if (
              response.status === 413 ||
              errorText.includes('context_length_exceeded') ||
              errorText.includes('too large')
            ) {
              // When the caller passed `messages`, the provider sends those
              // and IGNORES `userPrompt` (see body builder above). Estimating
              // from `systemPrompt + userPrompt` would be wildly off in that
              // case and starve compress-and-retry logic. Serialize the body
              // messages instead when present.
              const messagesText =
                Array.isArray(body.messages) && body.messages.length > 0 ? JSON.stringify(body.messages) : undefined;
              const estimateText = messagesText ?? `${request.systemPrompt}${request.userPrompt}`;
              const estimate = Math.ceil(estimateText.length / 4);
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
                try {
                  params = JSON.parse(tc.function.arguments);
                } catch {
                  console.warn(`[openrouter] Malformed tool arguments for ${tc.function.name}, using empty params`);
                }
                toolCalls.push({ id: tc.id, tool: tc.function.name, parameters: params });
              }
            }
          }

          const stopReason: LLMResponse['stopReason'] =
            choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
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
          timeoutMs: requestTimeoutMs,
          parseRetryAfter: (error: unknown) => {
            const header = (error as any)?.retryAfterHeader;
            if (!header) return undefined;
            const parsed = parseInt(header, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
          },
        },
      );
    },

    async generateStream(request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse> {
      const effectiveStreamTimeouts = request.timeoutMs
        ? {
            connectTimeoutMs: Math.max(streamTimeouts.connectTimeoutMs, request.timeoutMs),
            idleTimeoutMs: Math.max(streamTimeouts.idleTimeoutMs, request.timeoutMs),
            wallClockMs: Math.max(streamTimeouts.wallClockMs, request.timeoutMs * 5),
          }
        : streamTimeouts;
      const body: Record<string, unknown> = {
        model,
        stream: true,
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
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.topP !== undefined) body.top_p = request.topP;
      if (request.stopSequences && request.stopSequences.length > 0) {
        body.stop = request.stopSequences;
      }
      if (request.tools?.length) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      // G4 structured output — same wire-up as the non-streaming path so
      // streaming callers also get the shape guarantee.
      const streamFmt = request.responseFormat;
      if (streamFmt) {
        if (streamFmt.type === 'tool_use_required') {
          body.tool_choice = { type: 'function', function: { name: streamFmt.toolName } };
        } else if (streamFmt.type === 'json_schema') {
          body.response_format = {
            type: 'json_schema',
            json_schema: {
              name: streamFmt.name ?? 'output',
              schema: streamFmt.schema,
              strict: true,
            },
          };
        }
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'HTTP-Referer': 'https://github.com/vinyan-agent',
        'X-Title': 'Vinyan Agent',
      };
      applyTraceMetadata(body, headers, request.trace);

      return retryStreamWithBackoff(
        async (signal, hooks) => {
          const response = await fetch(OPENROUTER_BASE_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
          });

          // Headers received → connection is alive. Idle timer takes over from
          // here; the connect timer is cancelled by firstByte().
          hooks.firstByte();

          if (!response.ok || !response.body) {
            const errorText = await response.text().catch(() => '');
            if (response.status === 413 || errorText.includes('context_length_exceeded')) {
              const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
              throw new PromptTooLargeError(estimate, `openrouter/${model}`, new Error(errorText));
            }
            const err = new Error(`OpenRouter stream error ${response.status}: ${errorText}`);
            (err as { status?: number }).status = response.status;
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) (err as { retryAfterHeader?: string }).retryAfterHeader = retryAfter;
            throw err;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let contentAcc = '';
          const toolArgAcc: Map<number, { id: string; name: string; args: string }> = new Map();
          let finishReason: string | undefined;
          let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
          let modelId: string | undefined;

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
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') continue;
                let chunk: any;
                try {
                  chunk = JSON.parse(data);
                } catch {
                  continue;
                }
                if (chunk.model) modelId = chunk.model;
                if (chunk.usage) usage = chunk.usage;
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta;
                if (!delta) continue;
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                  contentAcc += delta.content;
                  onDelta({ text: delta.content });
                }
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const existing = toolArgAcc.get(idx) ?? { id: '', name: '', args: '' };
                    if (tc.id) existing.id = tc.id;
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                    toolArgAcc.set(idx, existing);
                  }
                }
              }
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {
              /* ignore */
            }
          }

          const toolCalls: ToolCall[] = [];
          for (const { id, name, args } of toolArgAcc.values()) {
            if (!name) continue;
            let params: Record<string, unknown> = {};
            try {
              params = args ? JSON.parse(args) : {};
            } catch {
              /* use empty */
            }
            toolCalls.push({ id: id || `tc_${name}`, tool: name, parameters: params });
          }
          const stopReason: LLMResponse['stopReason'] =
            finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn';

          return {
            content: contentAcc,
            toolCalls,
            tokensUsed: {
              input: usage?.prompt_tokens ?? 0,
              output: usage?.completion_tokens ?? 0,
            },
            model: modelId ?? model,
            stopReason,
          };
        },
        {
          maxRetries: 3,
          baseDelayMs: 1_000,
          retryableStatuses: DEFAULT_RETRYABLE_STATUSES,
          ...effectiveStreamTimeouts,
          parseRetryAfter: (error: unknown) => {
            const header = (error as { retryAfterHeader?: string })?.retryAfterHeader;
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
  for (const tier of ['fast', 'balanced', 'powerful', 'tool-uses'] as const) {
    const provider = createOpenRouterProvider({ tier, apiKey });
    if (provider) {
      registry.register(provider);
      count++;
    }
  }
  return count;
}

/**
 * Resolve ambient + per-request trace metadata and write it onto the
 * outbound payload using OpenRouter's broadcast/trace conventions:
 *   - top-level `session_id` and `user` (max 128 chars)
 *   - top-level `trace` object (free-form key/value)
 *   - `x-session-id` header as a redundant transport hint
 *
 * https://openrouter.ai/docs/guides/features/broadcast/overview
 */
function applyTraceMetadata(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  explicit: LLMTraceMetadata | undefined,
): void {
  const trace = resolveLLMTrace(explicit);
  if (!trace) return;

  const sessionId = clampOpenRouterId(trace.sessionId);
  const userId = clampOpenRouterId(trace.userId);
  if (sessionId) {
    body.session_id = sessionId;
    headers['x-session-id'] = sessionId;
  }
  if (userId) body.user = userId;

  const traceObj: Record<string, unknown> = { ...(trace.extra ?? {}) };
  if (trace.traceId) traceObj.trace_id = trace.traceId;
  if (trace.traceName) traceObj.trace_name = trace.traceName;
  if (trace.spanName) traceObj.span_name = trace.spanName;
  if (trace.generationName) traceObj.generation_name = trace.generationName;
  if (trace.parentSpanId) traceObj.parent_span_id = trace.parentSpanId;
  if (trace.environment) traceObj.environment = trace.environment;
  if (Object.keys(traceObj).length > 0) body.trace = traceObj;
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

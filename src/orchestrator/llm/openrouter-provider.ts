/**
 * OpenRouter LLM Provider — uses OpenAI-compatible API via raw fetch.
 *
 * No SDK dependency. Guarded by OPENROUTER_API_KEY env var.
 * Models configurable via OPENROUTER_{FAST,BALANCED,POWERFUL}_MODEL env vars.
 *
 * Source of truth: spec/tdd.md §17.1, https://openrouter.ai/docs
 */
import { PromptTooLargeError } from '../types.ts';
import type { LLMProvider, LLMRequest, LLMResponse, OnTextDelta, ToolCall } from '../types.ts';
import { normalizeMessages } from './provider-format.ts';
import type { OpenAIMessage } from './provider-format.ts';
import { retryWithBackoff, DEFAULT_RETRYABLE_STATUSES } from './retry.ts';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS: Record<LLMProvider['tier'], number> = {
  fast: 15_000,
  balanced: 60_000,
  powerful: 60_000,
  'tool-uses': 15_000,
};

const DEFAULT_MODELS: Record<LLMProvider['tier'], string> = {
  fast: 'google/gemma-4-31b-it:free',
  balanced: 'anthropic/claude-sonnet-4.6',
  powerful: 'anthropic/claude-opus-4.6',
  'tool-uses': 'anthropic/claude-haiku-4.5',
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

  const envModelKey = `OPENROUTER_${config.tier.toUpperCase().replace(/-/g, '_')}_MODEL`;
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

    async generateStream(request: LLMRequest, onDelta: OnTextDelta): Promise<LLMResponse> {
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
      if (request.tools?.length) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(OPENROUTER_BASE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'HTTP-Referer': 'https://github.com/vinyan-agent',
            'X-Title': 'Vinyan Agent',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // Fall back to non-streaming path on transport error.
        return this.generate(request);
      }

      if (!response.ok || !response.body) {
        clearTimeout(timer);
        const errorText = await response.text().catch(() => '');
        if (response.status === 413 || errorText.includes('context_length_exceeded')) {
          const estimate = Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4);
          throw new PromptTooLargeError(estimate, `openrouter/${model}`, new Error(errorText));
        }
        // Transient error — fall back to non-streaming retry path.
        return this.generate(request);
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
            try { chunk = JSON.parse(data); } catch { continue; }
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
        clearTimeout(timer);
        try { reader.releaseLock(); } catch { /* ignore */ }
      }

      const toolCalls: ToolCall[] = [];
      for (const { id, name, args } of toolArgAcc.values()) {
        if (!name) continue;
        let params: Record<string, unknown> = {};
        try { params = args ? JSON.parse(args) : {}; } catch { /* use empty */ }
        toolCalls.push({ id: id || `tc_${name}`, tool: name, parameters: params });
      }
      const stopReason: LLMResponse['stopReason'] =
        finishReason === 'tool_calls' ? 'tool_use'
          : finishReason === 'length' ? 'max_tokens'
            : 'end_turn';

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

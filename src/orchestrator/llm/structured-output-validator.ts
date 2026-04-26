/**
 * Structured-output validator (G4 — interior LLM control).
 *
 * Anthropic's `tool_choice: { type: 'tool', name }` already pins the tool the
 * model emits, so a structured-output call usually succeeds on the first try.
 * This module covers the residual failure mode: the response payload didn't
 * pass the caller's schema (e.g., a Zod parse), AND the caller wants ONE
 * targeted retry that hands the parse error back to the model as feedback.
 *
 * Why not retry inside the provider? The provider is wire-protocol-only and
 * doesn't know what shape the caller expects. The Zod schema lives at the
 * call site (each phase has its own contract). The validator is a small
 * reusable helper that the call site wires:
 *
 *   const { value, attempts } = await runWithStructuredOutput({
 *     attempt: () => provider.generate(buildRequest()),
 *     parse: (resp) => MySchema.safeParse(extractToolInput(resp)),
 *     buildRetryPrompt: (err) => `Previous response invalid: ${err}. Re-emit valid JSON.`,
 *     maxAttempts: 2, // one retry
 *   });
 *
 * If retries are exhausted the validator returns `{ value: null, attempts,
 * lastError }` so the caller can fall back to A2's `type: 'unknown'`
 * (uncertainty over hallucination).
 *
 * Axioms: A1 (validation lives outside the LLM, not inside its prompt), A2
 * (a final parse failure surfaces honestly as null, never silently coerced).
 */

import type { LLMRequest, LLMResponse } from '../types.ts';

export interface StructuredOutputAttempt<T> {
  /**
   * Call the provider. The validator passes a feedback string on retries — the
   * call site decides whether to fold it into systemPrompt, userPrompt, or a
   * new appended message.
   */
  attempt: (feedback: string | null) => Promise<LLMResponse>;
  /**
   * Parse the raw response into the structured value. Return `{ ok: true, value }`
   * on success, `{ ok: false, error }` to trigger a retry. Throwing is also
   * supported and treated as a parse failure with the error message.
   */
  parse: (response: LLMResponse) => StructuredParseResult<T>;
  /**
   * Caller-supplied prompt fragment for the retry. Receives the previous
   * parse error string so the model can correct its mistake. Default:
   *   `Your previous response was malformed: ${err}. Re-emit valid JSON.`
   */
  buildRetryPrompt?: (parseError: string) => string;
  /** Total attempts including the first. Default 2 (one retry). Min 1. */
  maxAttempts?: number;
}

export type StructuredParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** What kind of failure ended the last attempt. */
export type AttemptFailureKind = 'parse' | 'transport';

export interface StructuredOutputResult<T> {
  /** Parsed value when one of the attempts succeeded; null when all failed. */
  value: T | null;
  /** Number of `attempt()` calls made. Always >= 1, <= maxAttempts. */
  attempts: number;
  /**
   * Error message from the most recent failure.
   * @see lastErrorKind to disambiguate transport vs parse failure.
   */
  lastError?: string;
  /** Whether `lastError` came from `attempt()` throwing or from `parse()` rejecting. */
  lastErrorKind?: AttemptFailureKind;
  /** Successful provider responses (attempts that didn't throw). */
  responses: LLMResponse[];
  /**
   * Per-attempt error trace — one entry per failed attempt in scan order.
   * Successful attempts don't append. Useful for observability when a
   * transport hiccup recovers on retry.
   */
  errors: Array<{ kind: AttemptFailureKind; message: string }>;
}

const DEFAULT_MAX_ATTEMPTS = 2;

const defaultRetryPrompt = (err: string): string =>
  `Your previous response was malformed: ${err}. Re-emit a valid JSON object that matches the declared schema. Output ONLY the JSON, no prose, no markdown fences.`;

/**
 * Run an LLM call that's expected to return a structured payload. Retry once
 * on parse failure with the parse error fed back as guidance to the model.
 *
 * Retry feedback is keyed off the LAST PARSE failure only — when an attempt
 * throws (transport error, timeout, rate limit), the next call is sent with
 * `feedback = null` so the model isn't told its non-existent previous response
 * was malformed. This keeps the retry prompt honest about what actually
 * happened.
 */
export async function runWithStructuredOutput<T>(
  config: StructuredOutputAttempt<T>,
): Promise<StructuredOutputResult<T>> {
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const buildRetryPrompt = config.buildRetryPrompt ?? defaultRetryPrompt;
  const responses: LLMResponse[] = [];
  const errors: Array<{ kind: AttemptFailureKind; message: string }> = [];
  let lastParseError: string | undefined;
  let lastError: string | undefined;
  let lastErrorKind: AttemptFailureKind | undefined;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    // Retry feedback is keyed strictly off the last PARSE failure so a prior
    // transport error doesn't trigger a misleading "your previous response
    // was malformed" prompt.
    const feedback = lastParseError !== undefined ? buildRetryPrompt(lastParseError) : null;
    let response: LLMResponse;
    try {
      response = await config.attempt(feedback);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ kind: 'transport', message });
      lastError = message;
      lastErrorKind = 'transport';
      // Do NOT update lastParseError — transport failure leaves parse state
      // unchanged so the next retry can still feed back the original parse
      // problem if there was one.
      continue;
    }
    responses.push(response);

    let parsed: StructuredParseResult<T>;
    try {
      parsed = config.parse(response);
    } catch (err) {
      parsed = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (parsed.ok) {
      return { value: parsed.value, attempts, responses, errors };
    }
    errors.push({ kind: 'parse', message: parsed.error });
    lastParseError = parsed.error;
    lastError = parsed.error;
    lastErrorKind = 'parse';
  }

  return {
    value: null,
    attempts,
    lastError,
    ...(lastErrorKind ? { lastErrorKind } : {}),
    responses,
    errors,
  };
}

/**
 * Helper: extract the tool_use input from a structured-output response. Use
 * with `responseFormat: { type: 'tool_use_required', toolName }` so the
 * provider returns the value in `toolCalls[0].parameters` rather than
 * free-form text.
 */
export function extractToolUseInput(response: LLMResponse, toolName: string): Record<string, unknown> | null {
  const call = response.toolCalls.find((c) => c.tool === toolName);
  return call ? (call.parameters ?? {}) : null;
}

/**
 * Helper: assemble a default request augmented with a feedback string. Folds
 * the feedback into a trailing user-message turn so the prompt cache prefix
 * stays stable across retries.
 *
 * Both Anthropic and OpenRouter providers ignore `request.userPrompt` whenever
 * `messages` is non-empty. So when the input request has no `messages` yet,
 * we seed the messages array with `{ role: 'user', content: userPrompt }`
 * before appending the feedback turn — otherwise the original user prompt
 * would silently disappear on the retry call.
 */
export function appendFeedbackTurn(request: LLMRequest, feedback: string | null): LLMRequest {
  if (feedback == null) return request;
  const seeded = request.messages?.length
    ? request.messages
    : request.userPrompt
      ? [{ role: 'user' as const, content: request.userPrompt }]
      : [];
  return {
    ...request,
    messages: [
      ...seeded,
      { role: 'assistant' as const, content: 'Acknowledged.' },
      { role: 'user' as const, content: feedback },
    ],
  };
}

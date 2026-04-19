export type { BypassResult } from './bypass-detection.ts';
export { BYPASS_PATTERNS, containsBypassAttempt } from './bypass-detection.ts';
export type { InjectionResult } from './prompt-injection.ts';
export { detectPromptInjection, INJECTION_PATTERNS } from './prompt-injection.ts';
export type {
  SilentAgentConfig,
  SilentAgentRecord,
  SilentAgentState,
  SilentAgentTransition,
} from './silent-agent.ts';
export { SilentAgentDetector } from './silent-agent.ts';
export { extractStrings, normalizeForScan } from './text-utils.ts';

import { BYPASS_PATTERNS, containsBypassAttempt } from './bypass-detection.ts';
import { detectPromptInjection, INJECTION_PATTERNS } from './prompt-injection.ts';
import { normalizeForScan } from './text-utils.ts';

// ── Input Validation Gate (K1.5: block, don't strip) ────────────────

/**
 * Result of input validation — discriminated union.
 * 'clean' means input is safe; 'rejected' means injection was detected.
 */
export type GuardrailResult =
  | { status: 'clean'; text: string }
  | { status: 'rejected'; detections: string[]; reason: string };

/**
 * Validate input text for prompt injection and bypass attempts.
 * Unlike sanitizeForPrompt(), this function REJECTS malicious input
 * instead of stripping patterns — input never reaches the LLM.
 *
 * A6 compliance: zero-trust — detected injection = rejected, not sanitized.
 */
export function validateInput(text: string): GuardrailResult {
  const normalized = normalizeForScan(text);
  const injection = detectPromptInjection(normalized);
  const bypass = containsBypassAttempt(normalized);
  const detections = [...injection.patterns, ...bypass.patterns];

  if (detections.length === 0) {
    return { status: 'clean', text };
  }

  return {
    status: 'rejected',
    detections,
    reason: `Prompt injection detected: ${detections.join(', ')}`,
  };
}

// ── Legacy Sanitization (defense-in-depth at storage/prompt layer) ───

export interface SanitizeResult {
  cleaned: string;
  detections: string[];
}

/**
 * Run injection + bypass detection on text WITHOUT replacing anything.
 * Returns the original text unchanged plus the list of detection labels.
 *
 * Use this on first-party user intent (chat goals, conversation turns) and
 * for prompt-path content derived from the user — redacting legitimate
 * phrases like "act as reviewer" or file paths mangles intent before the
 * LLM sees it. Detections are still reported so the bus/audit layer can
 * surface a warning.
 */
export function sanitizeForPromptPassthrough(text: string): SanitizeResult {
  const normalized = normalizeForScan(text);
  const injection = detectPromptInjection(normalized);
  const bypass = containsBypassAttempt(normalized);
  const detections = [...injection.patterns, ...bypass.patterns];
  return { cleaned: text, detections };
}

/**
 * Sanitize a string for safe inclusion in LLM prompts.
 * Runs injection + bypass detection on Unicode-normalized text.
 * Replaces detected patterns with [REDACTED: <label>].
 *
 * @deprecated Use validateInput() as the primary input gate, and
 * sanitizeForPromptPassthrough() for prompt-path content that should not be
 * mangled. This function is retained for storage/trust-boundary defense
 * (auto-memory loader, working-memory archive) where untrusted disk content
 * crosses into prompt context.
 */
export function sanitizeForPrompt(text: string): SanitizeResult {
  const normalized = normalizeForScan(text);
  const injection = detectPromptInjection(normalized);
  const bypass = containsBypassAttempt(normalized);

  const detections = [...injection.patterns, ...bypass.patterns];

  if (detections.length === 0) {
    return { cleaned: text, detections: [] };
  }

  // Replace ALL occurrences of matched patterns in the normalized text
  let cleaned = normalized;
  const allPatterns = [...INJECTION_PATTERNS, ...BYPASS_PATTERNS];
  for (const { pattern, label } of allPatterns) {
    if (detections.includes(label)) {
      const globalPattern = new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
      );
      cleaned = cleaned.replace(globalPattern, `[REDACTED: ${label}]`);
    }
  }

  return { cleaned, detections };
}

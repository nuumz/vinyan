export type { BypassResult } from './bypass-detection.ts';
export { BYPASS_PATTERNS, containsBypassAttempt } from './bypass-detection.ts';
export type { InjectionResult } from './prompt-injection.ts';
export { detectPromptInjection, INJECTION_PATTERNS } from './prompt-injection.ts';
export { extractStrings, normalizeForScan } from './text-utils.ts';

import { BYPASS_PATTERNS, containsBypassAttempt } from './bypass-detection.ts';
import { detectPromptInjection, INJECTION_PATTERNS } from './prompt-injection.ts';
import { normalizeForScan } from './text-utils.ts';

export interface SanitizeResult {
  cleaned: string;
  detections: string[];
}

/**
 * Sanitize a string for safe inclusion in LLM prompts.
 * Runs injection + bypass detection on Unicode-normalized text.
 * Replaces detected patterns with [REDACTED: <label>].
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

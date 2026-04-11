/**
 * Bypass Detection — scans for attempts to circumvent Oracle validation.
 *
 * Based on architecture.md Decision A6: Worker output referencing
 * "skip Oracle" / "bypass validation" rejected by Orchestrator.
 */
import { extractStrings } from './text-utils.ts';

/** Patterns that indicate attempts to bypass Oracle validation. */
export const BYPASS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /skip\s+oracle/i, label: 'skip-oracle' },
  { pattern: /bypass\s+(the\s+)?validation/i, label: 'bypass-validation' },
  { pattern: /ignore\s+(the\s+)?verification/i, label: 'ignore-verification' },
  { pattern: /disable\s+(the\s+)?check/i, label: 'disable-check' },
  { pattern: /skip\s+(the\s+)?verification/i, label: 'skip-verification' },
  { pattern: /bypass\s+(the\s+)?oracle/i, label: 'bypass-oracle' },
  { pattern: /no\s+need\s+to\s+verify/i, label: 'no-verify' },
  { pattern: /don'?t\s+(need\s+to\s+)?validate/i, label: 'dont-validate' },
  { pattern: /trust\s+me,?\s+(it|this)('s|\s+is)\s+(correct|right|fine)/i, label: 'trust-claim' },
  { pattern: /already\s+verified/i, label: 'false-verification-claim' },
  { pattern: /pre-?verified/i, label: 'false-verification-claim' },
  { pattern: /oracle\s+not\s+needed/i, label: 'oracle-dismissal' },
];

export interface BypassResult {
  detected: boolean;
  patterns: string[];
}

/**
 * Scan an object's string values for Oracle bypass attempts.
 * Recursively inspects all string values in the params object.
 * Strings are Unicode-normalized before scanning (see text-utils.ts).
 */
export function containsBypassAttempt(params: unknown): BypassResult {
  const strings = extractStrings(params);
  const matched = new Set<string>();

  for (const str of strings) {
    for (const { pattern, label } of BYPASS_PATTERNS) {
      if (pattern.test(str)) {
        matched.add(label);
      }
    }
  }

  return {
    detected: matched.size > 0,
    patterns: Array.from(matched),
  };
}

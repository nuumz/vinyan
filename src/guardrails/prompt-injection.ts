/**
 * Prompt Injection Detection — scans string values for instruction-like patterns
 * that could manipulate AI workers into bypassing validation.
 *
 * Based on architecture.md Decision A6: Content entering worker prompts
 * stripped of instruction-like patterns at perception boundary.
 */
import { extractStrings } from "./text-utils.ts";

/** Patterns that indicate prompt injection attempts. */
export const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // System prompt markers
  { pattern: /\[SYSTEM\]/i, label: "system-prompt-marker" },
  { pattern: /<<\s*SYS\s*>>/i, label: "llama-system-tag" },
  { pattern: /<\|im_start\|>system/i, label: "chatml-system-tag" },

  // Role injection
  { pattern: /you\s+are\s+(now\s+)?a\b/i, label: "role-injection" },
  { pattern: /act\s+as\s+(a\s+|an\s+)?/i, label: "role-injection" },
  { pattern: /pretend\s+(you('re|\s+are)\s+)/i, label: "role-injection" },

  // Instruction override
  { pattern: /ignore\s+(all\s+)?previous\s+(instructions?|rules?|prompts?)/i, label: "instruction-override" },
  { pattern: /disregard\s+(all\s+)?previous/i, label: "instruction-override" },
  { pattern: /forget\s+(all\s+)?previous/i, label: "instruction-override" },
  { pattern: /new\s+instructions?:/i, label: "instruction-override" },

  // Delimiter escape
  { pattern: /---\s*(END|BEGIN)\s*(OF\s+)?(SYSTEM|PROMPT)/i, label: "delimiter-escape" },
  { pattern: /```\s*(system|prompt|instruction)/i, label: "delimiter-escape" },

  // Base64-encoded payload (long base64 strings that look like encoded instructions)
  { pattern: /[A-Za-z0-9+/]{100,}={0,2}/i, label: "base64-payload" },
];

export interface InjectionResult {
  detected: boolean;
  patterns: string[];
}

/**
 * Scan an object's string values for prompt injection patterns.
 * Recursively inspects all string values in the params object.
 * Strings are Unicode-normalized before scanning (see text-utils.ts).
 */
export function detectPromptInjection(params: unknown): InjectionResult {
  const strings = extractStrings(params);
  const matched = new Set<string>();

  for (const str of strings) {
    for (const { pattern, label } of INJECTION_PATTERNS) {
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

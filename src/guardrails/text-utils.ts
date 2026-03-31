/**
 * Text Utilities — shared helpers for guardrail scanners.
 *
 * Provides Unicode normalization, zero-width character stripping,
 * and percent-decoding to harden regex-based detection against
 * common bypass techniques (homoglyphs, invisible chars, encoding).
 */

// Zero-width and invisible characters used to break regex patterns
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF\u2060\u200E\u200F\u00AD]/g;

// Percent-encoded sequences (e.g., %69%67%6E%6F%72%65 → ignore)
const PERCENT_ENCODED_RE = /(%[0-9A-Fa-f]{2})+/g;

/**
 * Normalize text before scanning for injection/bypass patterns.
 * - Strip zero-width characters
 * - NFKC normalize (collapses homoglyphs like Cyrillic а → Latin a)
 * - Decode percent-encoded sequences
 */
export function normalizeForScan(text: string): string {
  let normalized = text.replace(ZERO_WIDTH_RE, "");
  normalized = normalized.normalize("NFKC");
  normalized = normalized.replace(PERCENT_ENCODED_RE, (match) => {
    try {
      return decodeURIComponent(match);
    } catch {
      return match;
    }
  });
  return normalized;
}

/** Recursively extract all string values from an object, normalizing each for scanning. */
export function extractStrings(value: unknown): string[] {
  if (typeof value === "string") return [normalizeForScan(value)];
  if (Array.isArray(value)) return value.flatMap(extractStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(extractStrings);
  }
  return [];
}

/**
 * Pure-function pattern + abnormality predicate evaluator.
 *
 * No LLM. No I/O. Deterministic given (predicate, context). Used by both
 * pattern matching and abnormality checking — the two share a shape.
 *
 * See `docs/design/commonsense-substrate-system-design.md` §3.3.
 */
import type { ApplicationContext, Pattern } from './types.ts';

/** Evaluate a pattern against an application context. Returns true on match. */
export function evaluatePattern(pattern: Pattern, ctx: ApplicationContext): boolean {
  const haystack = ctx[pattern.target_field];
  if (haystack === undefined) return false;

  switch (pattern.kind) {
    case 'literal-substring': {
      const caseSensitive = pattern.case_sensitive ?? true;
      const h = caseSensitive ? haystack : haystack.toLowerCase();
      const n = caseSensitive ? pattern.needle : pattern.needle.toLowerCase();
      return h.includes(n);
    }
    case 'exact-match':
      return haystack === pattern.value;
    case 'regex':
      try {
        return new RegExp(pattern.pattern, pattern.flags).test(haystack);
      } catch {
        return false; // malformed regex never matches (defensive — schema validates at insert)
      }
  }
}

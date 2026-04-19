/**
 * Content-addressed hashing helpers.
 *
 * A4 (Content-Addressed Truth): a fact is bound to its content, so the moment
 * the content changes the fact is auto-invalidated. Used by the Commitment
 * Ledger (O2) to bind a commitment to its goal — rewording the goal produces
 * a new hash, which means a different commitment.
 */

import { createHash } from 'crypto';

/**
 * Compute a stable SHA-256 hash of a task goal + target files.
 *
 * Normalization rules:
 *  - Goal: trimmed. Case is preserved (task goals are human-written and
 *    case can carry meaning, e.g. camelCase identifiers).
 *  - Target files: sorted lexicographically and deduped.
 *  - Serialization: JSON with deterministic key order
 *    (`{ goal, targetFiles }`).
 *
 * Returns a lowercase 64-char hex string.
 */
export function computeGoalHash(goal: string, targetFiles: readonly string[] = []): string {
  const normalizedFiles = [...new Set(targetFiles)].sort();
  const payload = JSON.stringify({
    goal: goal.trim(),
    targetFiles: normalizedFiles,
  });
  return createHash('sha256').update(payload).digest('hex');
}

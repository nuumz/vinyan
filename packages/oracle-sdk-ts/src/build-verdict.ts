/**
 * buildVerdict — construct a valid OracleVerdict.
 *
 * EHD C1: 'type' and 'confidence' are REQUIRED — no silent defaults.
 * Oracles must explicitly declare their epistemic state.
 */

import type { OracleVerdict } from './schemas.ts';

/**
 * Build an OracleVerdict.
 *
 * @example
 * ```ts
 * const verdict = buildVerdict({
 *   verified: true,
 *   type: 'known',
 *   confidence: 1.0,
 *   evidence: [],
 *   fileHashes: {},
 *   durationMs: 150,
 * });
 * ```
 */
export function buildVerdict(fields: OracleVerdict): OracleVerdict {
  return fields;
}

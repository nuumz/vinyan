/**
 * @vinyan/oracle-sdk — SDK for building Vinyan oracles.
 *
 * An oracle is a standalone process that:
 * 1. Reads a HypothesisTuple from stdin (JSON)
 * 2. Verifies the hypothesis using language-specific tools
 * 3. Writes an OracleVerdict to stdout (JSON)
 *
 * @example
 * ```ts
 * import { HypothesisTupleSchema, buildVerdict } from '@vinyan/oracle-sdk';
 *
 * const input = await Bun.stdin.text();
 * const hypothesis = HypothesisTupleSchema.parse(JSON.parse(input));
 *
 * // ... run your verification tool ...
 *
 * const verdict = buildVerdict({
 *   verified: true,
 *   type: 'known',
 *   confidence: 1.0,
 *   evidence: [],
 *   fileHashes: {},
 *   durationMs: 150,
 * });
 *
 * process.stdout.write(JSON.stringify(verdict) + '\n');
 * ```
 */

// ── Schemas ───────────────────────────────────────────────────────────
export {
  HypothesisTupleSchema,
  EvidenceSchema,
  QualityScoreSchema,
  OracleErrorCodeSchema,
  DeliberationRequestSchema,
  TemporalContextSchema,
  OracleVerdictSchema,
} from './schemas.ts';

// ── Types ─────────────────────────────────────────────────────────────
export type {
  HypothesisTuple,
  Evidence,
  QualityScore,
  OracleErrorCode,
  DeliberationRequest,
  TemporalContext,
  OracleVerdict,
} from './schemas.ts';

// ── Helpers ───────────────────────────────────────────────────────────
export { buildVerdict } from './build-verdict.ts';

// ── Test Utilities ────────────────────────────────────────────────────
export { testOracle } from './test-oracle.ts';
export type { OracleTestFixture, OracleTestResult } from './test-oracle.ts';

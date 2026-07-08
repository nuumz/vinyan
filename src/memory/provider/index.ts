/**
 * MemoryProvider package — re-exports.
 *
 * Concrete provider implementations (default, vector, dialectic) live in
 * sibling files. This module exposes the frozen contract surface
 * (w1-contracts §1/§3) plus the first-party Default provider, ranker,
 * fallback chain, and registration helper.
 */

export { DefaultMemoryProvider, type DefaultMemoryProviderOptions } from './default-provider.ts';
export { type FallbackChainOptions, MemoryFallbackChain } from './fallback-chain.ts';
export {
  computeScore,
  DEFAULT_WEIGHTS,
  normalizeBm25,
  type RankerInputs,
  type RankerScoreBreakdown,
  type RankerWeights,
  recencyScore,
} from './ranker.ts';
export {
  buildDefaultMemoryManifest,
  type RegisterDefaultMemoryOptions,
  type RegisterDefaultMemoryResult,
  registerDefaultMemory,
} from './register.ts';
export type {
  ConsolidationReport,
  EvidenceRef,
  HealthReport,
  MemoryHit,
  MemoryKind,
  MemoryProvider,
  MemoryRecord,
  SearchOpts,
  TemporalContext,
  WriteAck,
} from './types.ts';
export {
  ConfidenceTierSchema,
  EvidenceRefSchema,
  MEMORY_KINDS,
  MemoryKindSchema,
  MemoryRecordInputSchema,
  MemoryRecordSchema,
  SearchOptsSchema,
  TemporalContextSchema,
} from './types.ts';

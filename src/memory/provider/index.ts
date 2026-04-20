/**
 * MemoryProvider package — re-exports.
 *
 * Concrete provider implementations (default, vector, dialectic) live in
 * sibling files to be added in later PRs. This module exposes only the
 * contract surface frozen in w1-contracts §1/§3.
 */
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

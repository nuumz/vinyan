export { type BusEventName, createBus, EventBus, type VinyanBus, type VinyanBusEvents } from './bus.ts';
export type {
  Evidence,
  Fact,
  HypothesisTuple,
  OracleErrorCode,
  OracleVerdict,
  QualityScore,
} from './types.ts';

/**
 * Build an OracleVerdict with required ECP fields defaulted.
 * Deterministic oracles get type='known', confidence=1.0.
 * Pass type='unknown' and lower confidence for heuristic/failed results.
 */
export function buildVerdict(
  fields: Omit<import('./types.ts').OracleVerdict, 'type' | 'confidence'> & {
    type?: 'known' | 'unknown' | 'uncertain' | 'contradictory';
    confidence?: number;
  },
): import('./types.ts').OracleVerdict {
  return {
    type: 'known',
    confidence: 1.0,
    ...fields,
  };
}

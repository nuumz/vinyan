import type { OracleVerdict } from '../core/types.ts';
import type { OracleIndependenceAudit } from './types.ts';

export const ORACLE_INDEPENDENCE_POLICY_VERSION = 'oracle-independence:v1' as const;

interface OracleIndependenceInput {
  verdicts: Record<string, OracleVerdict>;
  aggregateConfidence?: number;
  passed: boolean;
}

export function deriveOracleIndependenceAudit(input: OracleIndependenceInput): OracleIndependenceAudit {
  const entries = Object.entries(input.verdicts);
  const sharedEvidenceWarnings = findSharedEvidenceWarnings(entries);
  const primaryOracles = selectPrimaryOracles(entries);
  const primarySet = new Set(primaryOracles);
  const corroboratingOracles = entries.map(([name]) => name).filter((name) => !primarySet.has(name));
  const deterministicOracleCount = entries.filter(([, verdict]) => verdict.confidence >= 0.99).length;
  const assumption =
    entries.length <= 1 ? 'single-oracle' : sharedEvidenceWarnings.length > 0 ? 'shared-evidence' : 'independent';

  return {
    policyVersion: ORACLE_INDEPENDENCE_POLICY_VERSION,
    compositionMethod:
      input.aggregateConfidence === undefined
        ? input.passed
          ? 'default-pass-fallback'
          : 'default-fail-fallback'
        : 'oracle-gate-aggregate-confidence',
    assumption,
    oracleCount: entries.length,
    deterministicOracleCount,
    heuristicOracleCount: entries.length - deterministicOracleCount,
    primaryOracles,
    corroboratingOracles,
    sharedEvidenceWarnings,
  };
}

function selectPrimaryOracles(entries: Array<[string, OracleVerdict]>): string[] {
  if (entries.length === 0) return [];
  const deterministic = entries.filter(([, verdict]) => verdict.confidence >= 0.99).map(([name]) => name);
  if (deterministic.length > 0) return deterministic;
  const maxConfidence = Math.max(...entries.map(([, verdict]) => verdict.confidence));
  return entries.filter(([, verdict]) => verdict.confidence === maxConfidence).map(([name]) => name);
}

function findSharedEvidenceWarnings(entries: Array<[string, OracleVerdict]>): string[] {
  const evidenceToOracles = new Map<string, Set<string>>();
  for (const [oracleName, verdict] of entries) {
    for (const evidence of verdict.evidence) {
      const key = evidence.contentHash ?? `${evidence.file}:${evidence.line}`;
      const oracles = evidenceToOracles.get(key) ?? new Set<string>();
      oracles.add(oracleName);
      evidenceToOracles.set(key, oracles);
    }
  }

  return Array.from(evidenceToOracles.entries())
    .filter(([, oracles]) => oracles.size > 1)
    .map(([evidenceKey, oracles]) => `shared evidence ${evidenceKey} used by ${Array.from(oracles).sort().join(',')}`);
}

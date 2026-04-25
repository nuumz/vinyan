/**
 * CommonSense Oracle — verification-gate adapter (M2).
 *
 * Evaluates a HypothesisTuple against the defeasible-prior knowledge stored
 * in the CommonSenseRegistry (M1). Emits an OracleVerdict at pragmatic tier
 * (confidence band 0.5–0.7) with `confidence_source: 'evidence-derived'`.
 *
 * SARIF Suppression shape (research-driven, see design doc Appendix A):
 *   When a rule's pattern matches but its abnormality predicate ALSO holds,
 *   the rule is "fired but suppressed" — we surface the suppression in the
 *   verdict's evidence chain instead of silently dropping it. This makes the
 *   Reiter "rule fires UNLESS abnormality" semantics auditable.
 *
 * Default-outcome → verdict mapping:
 *   - allow              → verified=true,  type='known'
 *   - block              → verified=false, type='known'
 *   - needs-confirmation → verified=false, type='uncertain'
 *   - escalate           → verified=true,  type='uncertain' + deliberationRequest
 *
 * No-LLM, no-I/O-beyond-SQLite — deterministic given (registry state, ctx).
 *
 * See `docs/design/commonsense-substrate-system-design.md` §6 (M2).
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { join } from 'path';
import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import type {
  Evidence,
  HypothesisTuple,
  OracleAbstention,
  OracleResponse,
  OracleVerdict,
} from '../../core/types.ts';
import { evaluatePattern } from './predicate-eval.ts';
import { extractApplicationContext, selectMicrotheory } from './microtheory-selector.ts';
import { CommonSenseRegistry } from './registry.ts';
import type { CommonSenseRule } from './types.ts';

const ORACLE_NAME = 'commonsense';
const BASE_RATE = 0.6; // pragmatic-tier center (band [0.5, 0.7])
const TTL_MS = 300_000;
const TIER_RELIABILITY = 0.6;
const ESCALATION_BUDGET_TOKENS = 50_000;

// ── Per-workspace registry cache ─────────────────────────────────────────
//
// The oracle is invoked synchronously from the gate; opening the SQLite DB
// every call would cost ~ms. Cache one read-only DB per workspace path.

let dbPathResolver: (workspace: string) => string = (workspace) =>
  join(workspace, '.vinyan', 'vinyan.db');

const registryCache = new Map<string, { db: Database; registry: CommonSenseRegistry }>();

/** Override the default DB path resolver. For tests. */
export function setDbPathResolver(resolver: (workspace: string) => string): void {
  dbPathResolver = resolver;
}

/** Drop all cached registries — for tests. Closes the underlying DB handles. */
export function clearRegistryCache(): void {
  for (const entry of registryCache.values()) {
    try {
      entry.db.close();
    } catch {
      // best-effort
    }
  }
  registryCache.clear();
}

function getRegistry(workspace: string): CommonSenseRegistry | null {
  const cached = registryCache.get(workspace);
  if (cached) return cached.registry;

  const dbPath = dbPathResolver(workspace);
  if (dbPath !== ':memory:' && !existsSync(dbPath)) return null;

  try {
    const db = new Database(dbPath);
    // Verify migration 010 has been applied — otherwise abstain at the
    // call site rather than throwing on prepare().
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commonsense_rules'")
      .get();
    if (!tableCheck) {
      db.close();
      return null;
    }
    const registry = new CommonSenseRegistry(db);
    registryCache.set(workspace, { db, registry });
    return registry;
  } catch {
    return null;
  }
}

// ── Evidence builders ────────────────────────────────────────────────────

function buildFiringEvidence(rule: CommonSenseRule): Evidence {
  return {
    file: `commonsense:rule:${rule.id}`,
    line: 0,
    snippet: JSON.stringify({
      ruleId: rule.id,
      microtheory: rule.microtheory,
      rationale: rule.rationale,
      outcome: rule.default_outcome,
      priority: rule.priority,
      source: rule.source,
    }),
    contentHash: rule.evidence_hash,
  };
}

/**
 * SARIF v2.1.0 §3.35-shaped suppression record. Emitted when a rule's
 * pattern matched but its abnormality predicate also held — the rule fired
 * but was suppressed. The shape `{kind, status, justification}` mirrors
 * SARIF's Suppression object so downstream consumers (audit, A2A federation)
 * can interpret it without a Vinyan-specific parser.
 */
function buildSuppressionEvidence(rule: CommonSenseRule): Evidence {
  return {
    file: 'commonsense:suppression',
    line: 0,
    snippet: JSON.stringify({
      suppression: {
        kind: 'inSource',
        status: 'accepted',
        justification: rule.abnormality_predicate
          ? `abnormality predicate matched: ${JSON.stringify(rule.abnormality_predicate)}`
          : 'abnormality predicate matched',
        ruleId: rule.id,
        microtheory: rule.microtheory,
      },
    }),
  };
}

// ── Verdict construction ─────────────────────────────────────────────────

function makeAbstention(
  reason: OracleAbstention['reason'],
  durationMs: number,
  prerequisites?: string[],
): OracleAbstention {
  return {
    type: 'abstained',
    reason,
    oracleName: ORACLE_NAME,
    durationMs,
    prerequisites,
  };
}

function makeUnknownVerdict(
  evidence: Evidence[],
  reason: string,
  durationMs: number,
): OracleVerdict {
  return buildVerdict({
    verified: true,
    type: 'unknown',
    confidence: 0,
    evidence,
    fileHashes: {},
    reason,
    durationMs,
    oracleName: ORACLE_NAME,
    confidenceSource: 'evidence-derived',
    tierReliability: TIER_RELIABILITY,
    opinion: fromScalar(0, BASE_RATE, 1.0), // vacuous (full uncertainty)
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential',
      halfLife: 300_000,
    },
  });
}

function makeFiringVerdict(
  winner: CommonSenseRule,
  evidence: Evidence[],
  durationMs: number,
): OracleVerdict {
  const reason = `${winner.default_outcome}: ${winner.rationale}`;
  const baseFields = {
    evidence,
    fileHashes: {},
    reason,
    durationMs,
    oracleName: ORACLE_NAME,
    confidenceSource: 'evidence-derived' as const,
    tierReliability: TIER_RELIABILITY,
    opinion: fromScalar(winner.confidence, BASE_RATE),
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential' as const,
      halfLife: 300_000,
    },
  };

  switch (winner.default_outcome) {
    case 'allow':
      return buildVerdict({
        ...baseFields,
        verified: true,
        type: 'known',
        confidence: winner.confidence,
      });
    case 'block':
      return buildVerdict({
        ...baseFields,
        verified: false,
        type: 'known',
        confidence: winner.confidence,
      });
    case 'needs-confirmation':
      return buildVerdict({
        ...baseFields,
        verified: false,
        type: 'uncertain',
        confidence: winner.confidence,
      });
    case 'escalate':
      return buildVerdict({
        ...baseFields,
        verified: true,
        type: 'uncertain',
        confidence: winner.confidence,
        deliberationRequest: {
          reason: `commonsense rule ${winner.id} requests escalation: ${winner.rationale}`,
          suggestedBudget: ESCALATION_BUDGET_TOKENS,
        },
      });
  }
}

// ── Public verify() — Oracle interface ───────────────────────────────────

export async function verify(hypothesis: HypothesisTuple): Promise<OracleResponse> {
  const start = performance.now();

  const ctx = extractApplicationContext(hypothesis);
  const microtheory = selectMicrotheory(ctx);

  const registry = getRegistry(hypothesis.workspace);
  if (!registry) {
    return makeAbstention(
      'insufficient_data',
      performance.now() - start,
      [
        'Run migration 010 (commonsense_rules)',
        'Seed innate rules via loadInnateSeed()',
      ],
    );
  }

  const candidates = registry.findApplicable(microtheory);

  // Empty registry or no microtheory match → out_of_domain
  if (candidates.length === 0) {
    return makeAbstention('out_of_domain', performance.now() - start);
  }

  // Evaluate pattern + abnormality on each candidate
  const firing: CommonSenseRule[] = [];
  const suppressed: CommonSenseRule[] = [];
  for (const rule of candidates) {
    if (!evaluatePattern(rule.pattern, ctx)) continue;
    if (rule.abnormality_predicate && evaluatePattern(rule.abnormality_predicate, ctx)) {
      suppressed.push(rule);
      continue;
    }
    firing.push(rule);
  }

  const allEvidence: Evidence[] = [
    ...firing.map(buildFiringEvidence),
    ...suppressed.map(buildSuppressionEvidence),
  ];

  const durationMs = performance.now() - start;

  // Pattern matched no candidate at all — informative unknown
  if (firing.length === 0 && suppressed.length === 0) {
    return makeUnknownVerdict([], 'no commonsense rule pattern matched this hypothesis', durationMs);
  }

  // All applicable rules were suppressed by their abnormality predicates
  if (firing.length === 0) {
    return makeUnknownVerdict(
      allEvidence,
      `${suppressed.length} commonsense rule(s) applicable, all suppressed by abnormality predicates`,
      durationMs,
    );
  }

  // At least one rule fires — winner = highest-priority (registry already sorts)
  const winner = firing[0]!;
  return makeFiringVerdict(winner, allEvidence, durationMs);
}

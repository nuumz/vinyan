/**
 * SkillImporter — state machine that turns an external SKILL.md into a
 * locally-trusted (or rejected) skill.
 *
 * Pipeline (deterministic, A3 + A1):
 *
 *   1. fetched          — adapter.fetch(id); parseSkillMd
 *   2. scanned          — guardrails: injection + bypass over frontmatter+body
 *                         (any hit → rejected, static-scan)
 *   3. quarantined      — artifactStore.write under `quarantine/<id>/`;
 *                         tier forced to 'speculative' regardless of declared
 *   4. dry_run_done     — Oracle Gate over the Procedure body in dry-run mode
 *   5. critic_done      — CriticEngine-like review over body + gate verdict
 *   6. promoted|reject  — promotion-rule decision → move artifact to
 *                         `.vinyan/skills/<namespace>/<id>/` on promote
 *
 * Every transition writes a row to the SkillTrustLedger (A3 replay log).
 *
 * Structural typing: `gate` and `critic` are function-valued deps so tests
 * can inject fakes without importing the full OracleGate / CriticEngine
 * stacks. See `SkillImporterDeps` below.
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import { containsBypassAttempt, detectPromptInjection } from '../../guardrails/index.ts';
import type { SkillArtifactStore } from '../artifact-store.ts';
import { parseSkillMd, type SkillMdRecord } from '../skill-md/index.ts';
import {
  decidePromotion,
  type GateVerdictLike,
  type PromotionDecision,
  type StaticScanResult,
} from './promotion-rules.ts';
import type { SkillRegistryAdapter } from './registry-adapter.ts';
import type { SkillTrustLedger } from './trust-ledger.ts';

// ── Structural gate / critic types ─────────────────────────────────

/**
 * Minimal shape the importer needs from a GateVerdict. Compatible with
 * `src/gate/gate.ts` GateVerdict (reads `.decision`, `.epistemicDecision`,
 * `.aggregateConfidence`, `.reasons`).
 */
export interface ImporterGateVerdict {
  readonly decision: 'allow' | 'block';
  readonly epistemicDecision?: 'allow' | 'allow-with-caveats' | 'uncertain' | 'block';
  readonly aggregateConfidence?: number;
  readonly reasons?: readonly string[];
}

export interface ImporterGateRequest {
  readonly tool: string;
  readonly params: {
    readonly file_path: string;
    readonly content: string;
    readonly workspace: string;
  };
  readonly skillId: string;
  readonly dryRun: true;
}

export type ImporterGateFn = (req: ImporterGateRequest) => Promise<ImporterGateVerdict>;

export interface ImporterCriticRequest {
  readonly skillId: string;
  readonly skillMd: string;
  readonly gateVerdict: ImporterGateVerdict;
}

export interface ImporterCriticVerdict {
  readonly approved: boolean;
  readonly confidence: number;
  readonly notes: string;
}

export type ImporterCriticFn = (req: ImporterCriticRequest) => Promise<ImporterCriticVerdict>;

export interface ImporterGuardrails {
  readonly detectInjection: (text: string) => { detected: boolean; patterns: readonly string[] };
  readonly detectBypass: (text: string) => { detected: boolean; patterns: readonly string[] };
}

export const DEFAULT_IMPORTER_GUARDRAILS: ImporterGuardrails = {
  detectInjection: (text) => {
    const r = detectPromptInjection(text);
    return { detected: r.detected, patterns: r.patterns };
  },
  detectBypass: (text) => {
    const r = containsBypassAttempt(text);
    return { detected: r.detected, patterns: r.patterns };
  },
};

// ── State machine types ────────────────────────────────────────────

export type ImportState =
  | {
      kind: 'fetched';
      skillId: string;
      parsed: SkillMdRecord;
    }
  | {
      kind: 'scanned';
      skillId: string;
      parsed: SkillMdRecord;
      staticScan: StaticScanResult;
    }
  | {
      kind: 'quarantined';
      skillId: string;
      parsed: SkillMdRecord;
      quarantineId: string;
    }
  | {
      kind: 'dry_run_done';
      skillId: string;
      parsed: SkillMdRecord;
      gateVerdict: ImporterGateVerdict;
    }
  | {
      kind: 'critic_done';
      skillId: string;
      parsed: SkillMdRecord;
      gateVerdict: ImporterGateVerdict;
      critic: ImporterCriticVerdict;
    }
  | {
      kind: 'promoted';
      skillId: string;
      parsed: SkillMdRecord;
      toTier: ConfidenceTier;
      ruleId: string;
    }
  | {
      kind: 'rejected';
      skillId: string;
      parsed: SkillMdRecord | null;
      reason: string;
      ruleId?: string;
    };

export interface SkillImporterDeps {
  readonly adapter: SkillRegistryAdapter;
  readonly gate: ImporterGateFn;
  readonly critic: ImporterCriticFn;
  readonly guardrails?: ImporterGuardrails;
  readonly trustLedger: SkillTrustLedger;
  readonly artifactStore: SkillArtifactStore;
  readonly profile: string;
  readonly workspace: string;
  readonly clock?: () => number;
  /**
   * Optional signature verifier — if present, its return value is fed to
   * the promotion rule. Absent → `signatureVerified=false`. The Plugin
   * Registry's `signature.ts` is the reference stub for this surface.
   */
  readonly verifySignature?: (
    parsed: SkillMdRecord,
    signature: { algorithm: 'ed25519'; signer: string; value: string } | undefined,
  ) => boolean;
}

/**
 * Idempotency policy: re-importing the same `skillId` always runs the full
 * pipeline again (deterministic rule evaluation of current adapter output).
 * Callers that want to suppress re-imports can consult the trust ledger
 * externally before calling `import()`.
 */
export class SkillImporter {
  private readonly deps: SkillImporterDeps;
  private readonly clock: () => number;
  private readonly guardrails: ImporterGuardrails;

  constructor(deps: SkillImporterDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Date.now());
    this.guardrails = deps.guardrails ?? DEFAULT_IMPORTER_GUARDRAILS;
  }

  async import(skillId: string): Promise<ImportState> {
    // Step 1: fetch
    let fetchResult: Awaited<ReturnType<SkillRegistryAdapter['fetch']>>;
    try {
      fetchResult = await this.deps.adapter.fetch(skillId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: { stage: 'fetch', error: reason },
        toStatus: 'rejected',
      });
      return { kind: 'rejected', skillId, parsed: null, reason: `fetch-error: ${reason}` };
    }

    let parsed: SkillMdRecord;
    try {
      parsed = parseSkillMd(fetchResult.skillMd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: { stage: 'parse', error: reason },
        toStatus: 'rejected',
      });
      return { kind: 'rejected', skillId, parsed: null, reason: `parse-error: ${reason}` };
    }

    this.deps.trustLedger.record(skillId, {
      event: 'fetched',
      detail: {
        adapter: this.deps.adapter.name,
        contentHash: parsed.contentHash,
        declaredTier: parsed.frontmatter.confidence_tier,
        origin: parsed.frontmatter.origin,
      },
      toStatus: 'fetched',
    });

    // Step 2: static scan (A6 zero-trust)
    const scanText = buildScanText(parsed);
    const injection = this.guardrails.detectInjection(scanText);
    const bypass = this.guardrails.detectBypass(scanText);
    const staticScan: StaticScanResult = {
      injectionFound: injection.detected,
      bypassFound: bypass.detected,
      suspicious: [...injection.patterns, ...bypass.patterns],
    };
    this.deps.trustLedger.record(skillId, {
      event: 'scanned',
      detail: {
        injectionFound: staticScan.injectionFound,
        bypassFound: staticScan.bypassFound,
        suspicious: staticScan.suspicious,
      },
    });

    if (staticScan.injectionFound || staticScan.bypassFound) {
      const decision: PromotionDecision = {
        kind: 'reject',
        reason: 'static-scan',
        ruleId: 'hub-import-v1',
      };
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: { staticScan, decision },
        toStatus: 'rejected',
        ruleId: decision.ruleId,
      });
      return { kind: 'rejected', skillId, parsed, reason: decision.reason, ruleId: decision.ruleId };
    }

    // Step 3: quarantine — tier forced to speculative regardless of declared
    const quarantineRecord: SkillMdRecord = {
      ...parsed,
      frontmatter: {
        ...parsed.frontmatter,
        confidence_tier: 'speculative',
        origin: coerceOrigin(parsed.frontmatter.origin),
        status: 'quarantined',
      },
    };
    const quarantineId = `quarantine/${parsed.frontmatter.id}`;
    try {
      await this.deps.artifactStore.write(
        { ...quarantineRecord, frontmatter: { ...quarantineRecord.frontmatter, id: quarantineId } },
        fetchResult.files,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: { stage: 'quarantine', error: reason },
        toStatus: 'rejected',
      });
      return { kind: 'rejected', skillId, parsed, reason: `quarantine-error: ${reason}` };
    }
    this.deps.trustLedger.record(skillId, {
      event: 'quarantined',
      detail: { quarantineId, declaredTier: parsed.frontmatter.confidence_tier },
      toStatus: 'quarantined',
      toTier: 'speculative',
    });

    // Step 4: dry-run Oracle Gate over the Procedure body
    const gateVerdict = await this.deps.gate({
      tool: 'import_skill_dry_run',
      params: {
        file_path: `skills/${parsed.frontmatter.id}/SKILL.md`,
        content: parsed.body.procedure,
        workspace: this.deps.workspace,
      },
      skillId,
      dryRun: true,
    });
    this.deps.trustLedger.record(skillId, {
      event: 'dry_run',
      detail: {
        decision: gateVerdict.decision,
        epistemicDecision: gateVerdict.epistemicDecision,
        aggregateConfidence: gateVerdict.aggregateConfidence,
        reasons: gateVerdict.reasons,
      },
    });

    // Step 5: Critic review
    let criticVerdict: ImporterCriticVerdict;
    try {
      criticVerdict = await this.deps.critic({
        skillId,
        skillMd: fetchResult.skillMd,
        gateVerdict,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: { stage: 'critic', error: reason },
        toStatus: 'rejected',
      });
      return { kind: 'rejected', skillId, parsed, reason: `critic-error: ${reason}` };
    }
    this.deps.trustLedger.record(skillId, {
      event: 'critic_reviewed',
      detail: {
        approved: criticVerdict.approved,
        confidence: criticVerdict.confidence,
        notes: criticVerdict.notes,
      },
    });

    // Step 6: promotion rule
    const gateVerdictLike: GateVerdictLike = {
      decision: mapGateEpistemic(gateVerdict),
      aggregateConfidence: gateVerdict.aggregateConfidence ?? 0,
    };
    const signatureVerified = this.deps.verifySignature
      ? this.deps.verifySignature(parsed, fetchResult.signature)
      : false;

    const decision = decidePromotion({
      staticScan,
      gateVerdict: gateVerdictLike,
      critic: criticVerdict,
      signatureVerified,
      origin: coerceOrigin(parsed.frontmatter.origin),
      declaredTier: parsed.frontmatter.confidence_tier,
    });

    if (decision.kind === 'reject') {
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: {
          decision,
          gateVerdict: gateVerdictLike,
          critic: criticVerdict,
        },
        fromStatus: 'quarantined',
        toStatus: 'rejected',
        ruleId: decision.ruleId,
      });
      return { kind: 'rejected', skillId, parsed, reason: decision.reason, ruleId: decision.ruleId };
    }

    if (decision.kind === 'quarantine-continue') {
      // Leave in quarantine; caller can retry later.
      return {
        kind: 'critic_done',
        skillId,
        parsed,
        gateVerdict,
        critic: criticVerdict,
      };
    }

    // Promotion — move artifact from quarantine namespace to its own namespace.
    const promotedTier = decision.toTier ?? 'probabilistic';
    const promotedRecord: SkillMdRecord = {
      ...parsed,
      frontmatter: {
        ...parsed.frontmatter,
        confidence_tier: promotedTier,
        origin: coerceOrigin(parsed.frontmatter.origin),
        status: 'active',
        promoted_at: this.clock(),
      },
    };
    try {
      await this.deps.artifactStore.write(promotedRecord, fetchResult.files);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.trustLedger.record(skillId, {
        event: 'rejected',
        detail: { stage: 'promote-write', error: reason },
        fromStatus: 'quarantined',
        toStatus: 'rejected',
      });
      return { kind: 'rejected', skillId, parsed, reason: `promote-write-error: ${reason}` };
    }
    this.deps.trustLedger.record(skillId, {
      event: 'promoted',
      detail: {
        decision,
        gateVerdict: gateVerdictLike,
        critic: criticVerdict,
      },
      fromStatus: 'quarantined',
      toStatus: 'active',
      fromTier: 'speculative',
      toTier: promotedTier,
      ruleId: decision.ruleId,
    });
    return {
      kind: 'promoted',
      skillId,
      parsed: promotedRecord,
      toTier: promotedTier,
      ruleId: decision.ruleId,
    };
  }
}

function buildScanText(record: SkillMdRecord): string {
  const parts: string[] = [];
  parts.push(record.frontmatter.name);
  parts.push(record.frontmatter.description);
  if (record.frontmatter.author) parts.push(record.frontmatter.author);
  parts.push(record.body.overview);
  parts.push(record.body.whenToUse);
  if (record.body.preconditions) parts.push(record.body.preconditions);
  parts.push(record.body.procedure);
  if (record.body.falsification?.raw) parts.push(record.body.falsification.raw);
  if (record.body.unknownSections) {
    for (const value of Object.values(record.body.unknownSections)) parts.push(value);
  }
  return parts.join('\n\n');
}

function coerceOrigin(raw: string | undefined): 'local' | 'hub' | 'a2a' | 'mcp' {
  if (raw === 'hub' || raw === 'a2a' || raw === 'mcp') return raw;
  return 'local';
}

/**
 * Map the gate's `decision` + `epistemicDecision` into the 5-way epistemic
 * label expected by the promotion rule.
 *
 *   block + reasons          → falsified
 *   allow (+high conf)       → verified
 *   allow-with-caveats       → verified (but promotion rule floors confidence)
 *   uncertain                → uncertain
 *   block without reasons    → unknown (oracles abstained)
 */
function mapGateEpistemic(verdict: ImporterGateVerdict): GateVerdictLike['decision'] {
  if (verdict.epistemicDecision === 'allow') return 'verified';
  if (verdict.epistemicDecision === 'allow-with-caveats') return 'verified';
  if (verdict.epistemicDecision === 'uncertain') return 'uncertain';
  if (verdict.epistemicDecision === 'block') return 'falsified';
  // No epistemic decision emitted — infer from coarse allow/block signal.
  if (verdict.decision === 'allow') return 'verified';
  const reasons = verdict.reasons ?? [];
  if (reasons.length > 0) return 'falsified';
  return 'unknown';
}

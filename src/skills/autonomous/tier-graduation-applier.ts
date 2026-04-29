/**
 * Skill tier graduation applier — Phase-15 (Item 4) IO half.
 *
 * Takes pure decisions from `decideTierGraduations` and applies them to
 * disk + the trust ledger. Each decision is independent: a per-decision
 * try/catch wraps the work so one bad row never blocks the others (A9).
 *
 * Ordering (matters for crash resilience):
 *   1. Read SKILL.md via `artifactStore.read`.
 *   2. Mutate `frontmatter.confidence_tier` (or `frontmatter.status` for quarantine).
 *   3. Set `frontmatter.promoted_at = now`.
 *   4. Recompute `contentHash` via `computeContentHash`.
 *   5. Write back via `artifactStore.write` (atomic temp-rename).
 *   6. Append ledger row referencing both old and new content hashes.
 *
 * If step 5 succeeds and step 6 fails, the SKILL.md is already valid on
 * disk with the new tier. A subsequent applier run observes the new tier
 * (from disk) and the cooldown blocks re-graduation; the missing ledger
 * row is acceptable observability degradation, never a correctness issue.
 *
 * Treat each tier change as effectively a NEW skill version (A4 Content-
 * Addressed Truth — the new contentHash is what skill-card envelopes pin).
 */
import { computeContentHash } from '../skill-md/hash.ts';
import type { SkillArtifactStore } from '../artifact-store.ts';
import { SkillArtifactNotFoundError } from '../artifact-store.ts';
import type { SkillTrustLedgerStore, SkillTrustStatus } from '../../db/skill-trust-ledger-store.ts';
import type { GraduationDecision } from './tier-graduation.ts';

/** SKILL.md statuses that the trust ledger also recognizes. The schema's
 *  `status` enum is broader (includes `probation`, `demoted`) — we only
 *  surface ledger-known values to keep the from/to columns honest. */
const LEDGER_STATUSES = new Set<string>(['fetched', 'quarantined', 'active', 'rejected', 'retired']);
function asLedgerStatus(s: string | undefined): SkillTrustStatus | undefined {
  return s !== undefined && LEDGER_STATUSES.has(s) ? (s as SkillTrustStatus) : undefined;
}

export interface ApplyTierGraduationsDeps {
  readonly artifactStore: SkillArtifactStore;
  readonly ledger: SkillTrustLedgerStore;
  readonly profile: string;
  readonly now?: () => number;
}

export interface ApplyTierGraduationsResult {
  readonly applied: GraduationDecision[];
  readonly skipped: Array<{ decision: GraduationDecision; reason: string }>;
}

export const TIER_GRADUATION_RULE_ID = 'tier-graduation';

export async function applyTierGraduations(
  decisions: readonly GraduationDecision[],
  deps: ApplyTierGraduationsDeps,
): Promise<ApplyTierGraduationsResult> {
  const now = deps.now ?? (() => Date.now());
  const applied: GraduationDecision[] = [];
  const skipped: Array<{ decision: GraduationDecision; reason: string }> = [];

  for (const decision of decisions) {
    try {
      const record = await deps.artifactStore.read(decision.skillId);
      const oldHash = record.contentHash;
      const oldStatus = record.frontmatter.status;

      const updatedFrontmatter = { ...record.frontmatter };
      let didQuarantine = false;

      if (decision.action === 'quarantine') {
        // Floor demote: status flips to `quarantined`. Tier stays at `speculative`.
        updatedFrontmatter.status = 'quarantined';
        didQuarantine = true;
      } else if (decision.toTier !== null) {
        // Promote / demote: change `confidence_tier`. Status unchanged.
        updatedFrontmatter.confidence_tier = decision.toTier;
      } else {
        // Should be unreachable — promote/demote with null toTier means the
        // decision module saw "already at floor/ceiling" and SHOULD have
        // turned it into quarantine or skipped. Defensive skip here.
        skipped.push({ decision, reason: 'no-op decision (toTier null without quarantine action)' });
        continue;
      }
      updatedFrontmatter.promoted_at = now();

      const newRecord = {
        frontmatter: updatedFrontmatter,
        body: record.body,
        contentHash: computeContentHash(updatedFrontmatter, record.body),
      };

      // A4: write the new SKILL.md FIRST so the artifact's hash on disk is
      // valid even if the ledger write fails. The new contentHash is the
      // canonical reference for any future skill-card envelope.
      await deps.artifactStore.write(newRecord);

      // Append the ledger row. Best-effort: a ledger failure does not
      // unwind the artifact write — the new tier on disk is the source
      // of truth. Re-runs see the new tier and skip via cooldown.
      try {
        const event = decision.action === 'promote' ? 'promoted' : 'demoted';
        const fromStatus = asLedgerStatus(oldStatus);
        deps.ledger.record({
          profile: deps.profile,
          skillId: decision.skillId,
          event,
          fromTier: decision.fromTier,
          ...(decision.toTier ? { toTier: decision.toTier } : {}),
          ...(didQuarantine
            ? {
                ...(fromStatus ? { fromStatus } : {}),
                toStatus: 'quarantined' as SkillTrustStatus,
              }
            : {}),
          evidence: {
            oldHash,
            newHash: newRecord.contentHash,
            wilsonLB: decision.wilsonLB,
            trials: decision.trials,
            successes: decision.successes,
            failures: decision.failures,
            personaId: decision.personaId,
            taskSignature: decision.taskSignature,
          },
          ruleId: TIER_GRADUATION_RULE_ID,
          createdAt: now(),
        });
      } catch {
        /* ledger best-effort; artifact already on disk */
      }

      applied.push(decision);
    } catch (err) {
      const reason =
        err instanceof SkillArtifactNotFoundError
          ? 'skill-artifact-not-found'
          : err instanceof Error
            ? err.message
            : String(err);
      skipped.push({ decision, reason });
    }
  }

  return { applied, skipped };
}

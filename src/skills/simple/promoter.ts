/**
 * Bridge: simple-layer skill → heavy epistemic-layer skill.
 *
 * Hybrid skill redesign — once a Claude-Code-style simple skill accumulates
 * sufficient outcome evidence (`SkillOutcomeStore` rows aggregated across
 * personas + task signatures), this module synthesizes a full SKILL.md and
 * writes it to the artifact store. The heavy schema's tier ladder, content
 * hash, and trust ledger then take over — A4/A5 are reinstated for skills
 * that earned them.
 *
 * Threshold: ≥15 trials AND success rate ≥0.8 (mirrors `tier-graduation.ts`'s
 * promotion gate). One-way only: a graduated skill stays in the heavy store;
 * the simple file is left in place so users see the source.
 *
 * Idempotent: if the artifact store already has a record for the skill id,
 * the promoter checks whether the simple body changed (different content
 * hash); if not, it skips. New body content → re-emit with bumped patch
 * version.
 *
 * A4 ordering (matters): write artifact FIRST, then ledger.
 * A9: per-skill failure does not block siblings.
 */
import { computeContentHash } from '../skill-md/hash.ts';
import type {
  SkillMdBody,
  SkillMdFrontmatter,
  SkillMdRecord,
} from '../skill-md/index.ts';
import { SkillArtifactNotFoundError, type SkillArtifactStore } from '../artifact-store.ts';
import type {
  SkillOutcomeStore,
} from '../../db/skill-outcome-store.ts';
import type { SkillTrustLedgerStore } from '../../db/skill-trust-ledger-store.ts';
import type { SimpleSkillRegistry } from './registry.ts';
import type { SimpleSkill } from './loader.ts';

export const MIN_PROMOTION_TRIALS = 15;
export const MIN_PROMOTION_SUCCESS_RATE = 0.8;
export const PROMOTER_RULE_ID = 'simple-skill-graduation';

export interface SimpleSkillPromoterDeps {
  readonly registry: SimpleSkillRegistry;
  readonly outcomeStore: SkillOutcomeStore;
  readonly artifactStore: SkillArtifactStore;
  readonly ledger: SkillTrustLedgerStore;
  readonly profile: string;
  readonly now?: () => number;
  /** Override `MIN_PROMOTION_TRIALS` (test injection). */
  readonly minTrials?: number;
  /** Override `MIN_PROMOTION_SUCCESS_RATE` (test injection). */
  readonly minSuccessRate?: number;
}

export interface PromotionDecision {
  readonly skillName: string;
  /**
   * Agent the simple skill was bound to (per-agent scope), or null for
   * shared-scope skills. The heavy SKILL.md is written under namespaced id
   * `<agent>/<name>` when this is set, leaving each persona's graduated
   * skills in their own corner of the artifact store.
   */
  readonly agentId: string | null;
  /** Heavy-store skill id used for the graduated artifact. */
  readonly heavySkillId: string;
  readonly trials: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: number;
}

export interface PromotionResult {
  readonly promoted: readonly PromotionDecision[];
  readonly skipped: ReadonlyArray<{ skillName: string; reason: string }>;
}

/**
 * Run one promotion pass: scan every loaded simple skill, evaluate outcomes,
 * synthesize and write heavy SKILL.md for those that qualify.
 *
 * Per-agent simple skills are aggregated per (agentId, skillName) — each
 * agent earns its own graduation. The heavy artifact is written under the
 * namespaced id `<agentId>/<name>` so multiple agents can graduate a skill
 * with the same name without collision. Shared-scope skills graduate to
 * the flat id `<name>` and aggregate outcomes across all personas.
 */
export async function runSimpleSkillPromoter(deps: SimpleSkillPromoterDeps): Promise<PromotionResult> {
  const now = deps.now ?? (() => Date.now());
  const minTrials = deps.minTrials ?? MIN_PROMOTION_TRIALS;
  const minSuccessRate = deps.minSuccessRate ?? MIN_PROMOTION_SUCCESS_RATE;

  const promoted: PromotionDecision[] = [];
  const skipped: Array<{ skillName: string; reason: string }> = [];
  const skills = deps.registry.getAll();

  for (const skill of skills) {
    const agentId = skill.agentId ?? null;
    const heavySkillId = agentId ? `${agentId}/${skill.name}` : skill.name;
    const reportName = agentId ? `${agentId}/${skill.name}` : skill.name;
    try {
      // Per-agent skills: aggregate ONLY rows for this persona so each agent's
      // promotion reflects evidence the agent actually accumulated. Shared
      // skills aggregate across all personas.
      const aggregate = agentId
        ? aggregateOutcomesForAgent(skill.name, agentId, deps.outcomeStore)
        : aggregateOutcomes(skill.name, deps.outcomeStore);

      if (aggregate.trials < minTrials) {
        skipped.push({ skillName: reportName, reason: `insufficient trials (${aggregate.trials} < ${minTrials})` });
        continue;
      }
      if (aggregate.successRate < minSuccessRate) {
        skipped.push({
          skillName: reportName,
          reason: `success rate ${aggregate.successRate.toFixed(2)} < ${minSuccessRate}`,
        });
        continue;
      }

      const newRecord = buildHeavyRecord(skill, heavySkillId);

      // Idempotency: if a heavy record already exists with the same content
      // hash, skip. If hashes differ (user edited the simple body since the
      // last promotion), bump patch version and re-emit.
      const existing = await tryReadExisting(deps.artifactStore, heavySkillId);
      if (existing && existing.contentHash === newRecord.contentHash) {
        skipped.push({ skillName: reportName, reason: 'already promoted, content unchanged' });
        continue;
      }
      const finalRecord = existing
        ? rebumpVersion(newRecord, existing.frontmatter.version)
        : newRecord;

      // A4: write artifact FIRST, ledger second.
      await deps.artifactStore.write(finalRecord);

      try {
        deps.ledger.record({
          profile: deps.profile,
          skillId: heavySkillId,
          event: 'promoted',
          toTier: finalRecord.frontmatter.confidence_tier,
          fromStatus: existing ? 'active' : 'fetched',
          toStatus: 'active',
          evidence: {
            promotedFrom: 'simple-skill-layer',
            ...(agentId ? { agentId } : {}),
            ...(existing ? { previousHash: existing.contentHash } : {}),
            newHash: finalRecord.contentHash,
            trials: aggregate.trials,
            successes: aggregate.successes,
            failures: aggregate.failures,
            successRate: aggregate.successRate,
            sourcePath: skill.path,
          },
          ruleId: PROMOTER_RULE_ID,
          createdAt: now(),
        });
      } catch {
        /* ledger best-effort; artifact already on disk */
      }

      promoted.push({
        skillName: skill.name,
        agentId,
        heavySkillId,
        trials: aggregate.trials,
        successes: aggregate.successes,
        failures: aggregate.failures,
        successRate: aggregate.successRate,
      });
    } catch (err) {
      skipped.push({
        skillName: reportName,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { promoted, skipped };
}

interface OutcomeAggregate {
  readonly trials: number;
  readonly successes: number;
  readonly failures: number;
  readonly successRate: number;
}

function aggregateOutcomes(skillName: string, store: SkillOutcomeStore): OutcomeAggregate {
  const rows = store.listForSkill(skillName);
  let successes = 0;
  let failures = 0;
  for (const row of rows) {
    successes += row.successes;
    failures += row.failures;
  }
  const trials = successes + failures;
  return {
    trials,
    successes,
    failures,
    successRate: trials > 0 ? successes / trials : 0,
  };
}

/**
 * Per-agent aggregate: include only rows where the persona id matches the
 * skill's bound agent. A skill named `code-review` bound to `developer`
 * never inherits outcomes recorded against `reviewer`.
 */
function aggregateOutcomesForAgent(
  skillName: string,
  agentId: string,
  store: SkillOutcomeStore,
): OutcomeAggregate {
  const rows = store.listForSkill(skillName).filter((r) => r.personaId === agentId);
  let successes = 0;
  let failures = 0;
  for (const row of rows) {
    successes += row.successes;
    failures += row.failures;
  }
  const trials = successes + failures;
  return {
    trials,
    successes,
    failures,
    successRate: trials > 0 ? successes / trials : 0,
  };
}

async function tryReadExisting(
  artifactStore: SkillArtifactStore,
  skillId: string,
): Promise<SkillMdRecord | null> {
  try {
    return await artifactStore.read(skillId);
  } catch (err) {
    if (err instanceof SkillArtifactNotFoundError) return null;
    throw err;
  }
}

/**
 * Synthesize a full SKILL.md record from the simple skill. Defaults:
 *   - tier: pragmatic (mid-trust — earned through outcomes but no oracle gate)
 *   - status: active (not probation — graduation IS the audit signal)
 *   - origin: local (user-authored, not autonomous-creator)
 *   - version: 0.1.0 starter
 *
 * `heavySkillId` is the artifact-store id (`<agent>/<name>` for per-agent or
 * `<name>` for shared). It must match the heavy schema's id regex —
 * `[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?` — which the simple-skill name
 * validator already enforces.
 */
function buildHeavyRecord(skill: SimpleSkill, heavySkillId: string): SkillMdRecord {
  const frontmatter: SkillMdFrontmatter = {
    id: heavySkillId,
    name: skill.name,
    version: '0.1.0',
    description: skill.description || `Promoted from simple skill '${skill.name}'`,
    requires_toolsets: [],
    fallback_for_toolsets: [],
    confidence_tier: 'pragmatic',
    origin: 'local',
    declared_oracles: [],
    falsifiable_by: [],
    status: 'active',
  };
  const body = parseBodyHeuristically(skill.body);
  return {
    frontmatter,
    body,
    contentHash: computeContentHash(frontmatter, body),
  };
}

/**
 * Best-effort body splitter: simple skills have free-form markdown bodies. We
 * try to find `## When to use` and `## Procedure` headings; if absent, stuff
 * the entire body into `procedure` and synthesize a one-liner overview.
 */
function parseBodyHeuristically(rawBody: string): SkillMdBody {
  const sections = splitByH2(rawBody);
  const overview = pick(sections, ['Overview', 'overview']) ?? rawBody.split('\n\n')[0]?.trim() ?? '';
  const whenToUse = pick(sections, ['When to use', 'when to use', 'When to Use']) ?? overview;
  const procedure = pick(sections, ['Procedure', 'procedure', 'Steps', 'steps']) ?? rawBody.trim();
  const result: SkillMdBody = {
    overview: overview || '(no overview supplied)',
    whenToUse: whenToUse || '(no when-to-use supplied)',
    procedure: procedure || '(no procedure supplied)',
  };
  return result;
}

function splitByH2(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^##\s+/m);
  // The first part (before the first H2) goes under '__prelude__' if non-empty.
  if (parts[0] && parts[0].trim()) sections.set('__prelude__', parts[0].trim());
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const newlineIdx = part.indexOf('\n');
    const heading = newlineIdx >= 0 ? part.slice(0, newlineIdx).trim() : part.trim();
    const content = newlineIdx >= 0 ? part.slice(newlineIdx + 1).trim() : '';
    if (heading) sections.set(heading, content);
  }
  return sections;
}

function pick(sections: Map<string, string>, headings: readonly string[]): string | null {
  for (const heading of headings) {
    const v = sections.get(heading);
    if (v && v.trim()) return v;
  }
  return null;
}

function rebumpVersion(record: SkillMdRecord, oldVersion: string): SkillMdRecord {
  // Patch bump: 0.1.0 → 0.1.1, 1.2.5 → 1.2.6
  const match = oldVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const next = match ? `${match[1]}.${match[2]}.${Number.parseInt(match[3]!, 10) + 1}` : record.frontmatter.version;
  const newFrontmatter = { ...record.frontmatter, version: next };
  return {
    frontmatter: newFrontmatter,
    body: record.body,
    contentHash: computeContentHash(newFrontmatter, record.body),
  };
}

/**
 * SkillExporter — one-way projection from legacy `cached_skills` rows to
 * SKILL.md artifacts on disk.
 *
 * This is the W3 migration bridge: pre-D20 skill rows have no content hash
 * and no authored SKILL.md body — we synthesize a minimal artifact so the
 * same progressive-disclosure surface can serve both legacy and new skills.
 *
 * Critical invariant (A4 + A5): legacy rows without `content_hash` are
 * NEVER exported as `confidence_tier: 'deterministic'`. The SKILL.md schema
 * already enforces this at write time (deterministic ⇒ content_hash is
 * required); the exporter additionally coerces the tier down to `heuristic`
 * when the column is null, preserving whatever stronger signal the row
 * carries otherwise.
 *
 * The DB is read-only from this module's perspective — the exporter never
 * modifies `cached_skills`. SkillStore owns row mutations.
 */

import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

import { type ConfidenceTier, isConfidenceTier, isStrongerThan } from '../core/confidence-tier.ts';
import type { SkillArtifactStore } from './artifact-store.ts';
import { computeContentHash } from './skill-md/hash.ts';
import type { SkillMdBody, SkillMdFrontmatter, SkillMdRecord } from './skill-md/index.ts';

// ── Types ───────────────────────────────────────────────────────────────

export interface ExporterOptions {
  readonly db: Database;
  readonly artifactStore: SkillArtifactStore;
  readonly defaultAuthor?: string;
  readonly defaultLicense?: string;
}

export interface ExportStats {
  readonly exported: number;
  readonly skippedNoSignature: number;
  readonly skippedAlreadyExists: number;
  readonly errors: Array<{ skillId: string; reason: string }>;
}

/** Row shape we read from `cached_skills`. Kept loose — some columns are optional. */
interface CachedSkillRow {
  task_signature: string;
  approach: string | null;
  success_rate: number | null;
  status: string | null;
  probation_remaining: number | null;
  usage_count: number | null;
  risk_at_creation: number | null;
  dep_cone_hashes: string | null;
  last_verified_at: number | null;
  verification_profile: string | null;
  origin: string | null;
  composed_of: string | null;
  agent_id: string | null;
  confidence_tier: string | null;
  skill_md_path: string | null;
  content_hash: string | null;
  expected_error_reduction: number | null;
  backtest_id: string | null;
  quarantined_at: number | null;
}

// ── Exporter ────────────────────────────────────────────────────────────

export class SkillExporter {
  private readonly db: Database;
  private readonly artifactStore: SkillArtifactStore;
  private readonly defaultAuthor?: string;
  private readonly defaultLicense?: string;

  constructor(opts: ExporterOptions) {
    this.db = opts.db;
    this.artifactStore = opts.artifactStore;
    this.defaultAuthor = opts.defaultAuthor;
    this.defaultLicense = opts.defaultLicense;
  }

  /** Export every row in `cached_skills`. */
  async exportAll(options?: { overwrite?: boolean }): Promise<ExportStats> {
    const overwrite = options?.overwrite ?? false;
    const rows = this.selectAllRows();

    const stats = {
      exported: 0,
      skippedNoSignature: 0,
      skippedAlreadyExists: 0,
      errors: [] as Array<{ skillId: string; reason: string }>,
    };

    for (const row of rows) {
      if (!row.task_signature || row.task_signature.trim().length === 0) {
        stats.skippedNoSignature++;
        continue;
      }
      const skillId = normalizeIdFromSignature(row.task_signature);
      try {
        const record = this.rowToRecord(row);
        if (!overwrite && artifactExists(this.artifactStore, skillId)) {
          stats.skippedAlreadyExists++;
          continue;
        }
        await this.artifactStore.write(record);
        stats.exported++;
      } catch (err) {
        stats.errors.push({ skillId, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      exported: stats.exported,
      skippedNoSignature: stats.skippedNoSignature,
      skippedAlreadyExists: stats.skippedAlreadyExists,
      errors: stats.errors,
    };
  }

  /** Export one skill by `task_signature`. */
  async exportOne(cachedSkillId: string, options?: { overwrite?: boolean }): Promise<'ok' | 'exists' | 'error'> {
    const overwrite = options?.overwrite ?? false;
    try {
      const row = this.selectOneRow(cachedSkillId);
      if (!row) return 'error';
      const skillId = normalizeIdFromSignature(row.task_signature);
      if (!overwrite && artifactExists(this.artifactStore, skillId)) {
        return 'exists';
      }
      const record = this.rowToRecord(row);
      await this.artifactStore.write(record);
      return 'ok';
    } catch {
      return 'error';
    }
  }

  // ── Row → Record mapping ──────────────────────────────────────────────

  private rowToRecord(row: CachedSkillRow): SkillMdRecord {
    const id = normalizeIdFromSignature(row.task_signature);
    const description = (row.approach ?? '').trim();
    const firstLine = description.split(/\r?\n/)[0]?.trim() ?? '';
    const name = firstLine.length > 0 ? firstLine.slice(0, 80) : id;

    // Confidence tier mapping (A4+A5 critical):
    //   - Raw tier from DB if valid.
    //   - If row has no content_hash, downgrade to 'heuristic' at most — never
    //     emit 'deterministic' for a hash-less row.
    const rawTier: ConfidenceTier = isConfidenceTier(row.confidence_tier) ? row.confidence_tier : 'heuristic';
    const tier: ConfidenceTier = row.content_hash ? rawTier : downgradeFromDeterministic(rawTier);

    const status = mapStatus(row.status);
    const origin = mapOrigin(row.origin);

    const bodyOverview = description.length > 0 ? description : `Skill ${id}`;
    const whenToUse = `Use when: ${row.task_signature}`;
    const procedure =
      description.length > 0 ? description : '(derived from legacy cached skill; populate procedure on next revision)';

    const body: SkillMdBody = {
      overview: bodyOverview,
      whenToUse,
      procedure,
    };

    const frontmatter: SkillMdFrontmatter = {
      id,
      name,
      version: '1.0.0',
      description: description.length > 0 ? description : `Legacy cached skill ${id}`,
      requires_toolsets: [],
      fallback_for_toolsets: [],
      confidence_tier: tier,
      origin,
      declared_oracles: [],
      falsifiable_by: [],
      status,
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.backtest_id ? { backtest_id: row.backtest_id } : {}),
      ...(this.defaultAuthor ? { author: this.defaultAuthor } : {}),
      ...(this.defaultLicense ? { license: this.defaultLicense } : {}),
      task_signature: row.task_signature,
    };

    const contentHash = computeContentHash(frontmatter, body);
    return { frontmatter, body, contentHash };
  }

  // ── DB access ─────────────────────────────────────────────────────────

  private selectAllRows(): CachedSkillRow[] {
    return this.db.query(selectSql()).all() as CachedSkillRow[];
  }

  private selectOneRow(taskSignature: string): CachedSkillRow | null {
    const row = this.db.query(`${selectSql()} WHERE task_signature = ?`).get(taskSignature);
    return (row as CachedSkillRow | null) ?? null;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Normalize a task signature into a SKILL.md id (`^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)?$`). */
export function normalizeIdFromSignature(signature: string): string {
  const collapsed = signature.trim().toLowerCase().replace(/\s+/g, '-');
  // Keep at most one namespace separator; collapse nested ones into `-`.
  let first = true;
  let out = '';
  for (const ch of collapsed) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && first) {
      out += '/';
      first = false;
    } else if (ch === '-') {
      out += '-';
    } else {
      out += '-';
    }
  }
  // Compress `--` runs, trim leading/trailing `-`.
  out = out.replace(/-+/g, '-');
  out = out.replace(/(^|\/)-+/g, '$1').replace(/-+(\/|$)/g, '$1');
  if (out.length === 0) out = 'legacy';
  // Ensure each namespace segment starts with a letter.
  out = out
    .split('/')
    .map((seg) => (seg && /^[0-9-]/.test(seg) ? `s-${seg}` : seg))
    .join('/');
  return out;
}

function mapStatus(raw: string | null): SkillMdFrontmatter['status'] {
  switch (raw) {
    case 'active':
      return 'active';
    case 'probation':
      return 'probation';
    case 'demoted':
      return 'demoted';
    case 'quarantined':
      return 'quarantined';
    case 'retired':
      return 'retired';
    default:
      return 'probation';
  }
}

function mapOrigin(raw: string | null): SkillMdFrontmatter['origin'] {
  switch (raw) {
    case 'a2a':
      return 'a2a';
    case 'mcp':
      return 'mcp';
    case 'hub':
      return 'hub';
    default:
      return 'local';
  }
}

/**
 * A row with no `content_hash` cannot be `deterministic` (A4). Downgrade to
 * `heuristic` in that case; other tiers pass through unchanged (already <=
 * heuristic by A5 ordering).
 */
function downgradeFromDeterministic(tier: ConfidenceTier): ConfidenceTier {
  if (tier === 'deterministic') return 'heuristic';
  // `isStrongerThan` kept in the import so refactors that tighten the policy
  // later (e.g., also downgrade 'heuristic' when no evidence at all) have a
  // one-liner diff.
  if (isStrongerThan(tier, 'probabilistic')) return tier;
  return tier;
}

function artifactExists(store: SkillArtifactStore, skillId: string): boolean {
  return existsSync(store.pathFor(skillId));
}

function selectSql(): string {
  return `SELECT task_signature, approach, success_rate, status, probation_remaining,
         usage_count, risk_at_creation, dep_cone_hashes, last_verified_at,
         verification_profile, origin, composed_of, agent_id,
         confidence_tier, skill_md_path, content_hash,
         expected_error_reduction, backtest_id, quarantined_at
         FROM cached_skills`;
}

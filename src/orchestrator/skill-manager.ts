/**
 * Skill Manager — L0 reflex shortcut system.
 *
 * Matches tasks to cached skills (proven approaches from Sleep Cycle).
 * Risk-tiered verification ensures skills stay fresh:
 *   - Low risk (<0.2): hash-only check
 *   - Medium (0.2–0.4): structural oracle verification
 *   - High (≥0.4): full test suite
 *
 * Lifecycle: probation (10 sessions) → active → demoted
 *
 * Source of truth: spec/tdd.md §12B (Skill Formation), Phase 2.5
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { SkillStore } from '../db/skill-store.ts';
import type { CachedSkill, ExtractedPattern } from './types.ts';

export interface SkillManagerConfig {
  skillStore: SkillStore;
  workspace: string;
  /** Minimum effectiveness to keep active (default: 0.7) */
  minEffectiveness?: number;
  /** Probation sessions before promotion (default: 10) */
  probationSessions?: number;
  /**
   * Multi-agent: scope skill lookup/creation to this specialist agent.
   * When set, matches prefer exact agent ownership, falling back to legacy
   * shared skills (agent_id IS NULL). When omitted, behaves as before (shared pool).
   */
  agentId?: string;
}

export class SkillManager {
  private store: SkillStore;
  private workspace: string;
  private minEffectiveness: number;
  private probationSessions: number;
  private agentId?: string;

  constructor(config: SkillManagerConfig) {
    this.store = config.skillStore;
    this.workspace = config.workspace;
    this.minEffectiveness = config.minEffectiveness ?? 0.7;
    this.probationSessions = config.probationSessions ?? 10;
    this.agentId = config.agentId;
  }

  /** Count active (promoted) skills. */
  countActive(): number {
    return this.store.countActive();
  }

  /**
   * Try to match a task to a cached active skill.
   * First attempts exact match, then falls back to fuzzy matching (PH3.4).
   * Fuzzy matches return with confidence: 0.4; exact matches omit confidence field.
   *
   * Scoping precedence: the per-call `agentId` arg wins; `this.agentId` (ctor)
   * is the fallback when the call site can't supply one. When both are unset,
   * matches run against the global pool (shared skills with agent_id IS NULL
   * are still visible to any agent).
   */
  match(taskSignature: string, agentId?: string): CachedSkill | null {
    const scope = agentId ?? this.agentId;
    const skill = this.store.findBySignature(taskSignature, scope);
    if (skill && skill.status === 'active') return skill;

    // PH3.4: fuzzy fallback — same verb + overlapping file extensions
    const fuzzy = this.fuzzyMatch(taskSignature, scope);
    if (fuzzy) return { ...fuzzy, confidence: 0.4 };
    return null;
  }

  /**
   * PH3.4: Cross-Task Skill Generalization — fuzzy matching.
   * Matches on same action verb and overlapping file extensions.
   * Only considers active skills with successRate >= 0.8.
   */
  fuzzyMatch(taskSignature: string, agentId?: string): CachedSkill | null {
    const parts = taskSignature.split('::');
    const verb = parts[0];
    const exts = parts[1];
    if (!verb || !exts) return null;

    const scope = agentId ?? this.agentId;
    const targetExts = new Set(exts.split(','));
    const candidates = this.store.findActive(scope);

    let best: CachedSkill | null = null;
    for (const skill of candidates) {
      // Skip exact match (already checked above)
      if (skill.taskSignature === taskSignature) continue;

      const sParts = skill.taskSignature.split('::');
      const sVerb = sParts[0];
      const sExts = sParts[1];
      if (sVerb !== verb || !sExts) continue;

      const overlap = sExts.split(',').some((e) => targetExts.has(e));
      if (!overlap) continue;

      // Require high success rate for fuzzy matches
      if (skill.successRate < 0.8) continue;

      if (!best || skill.successRate > best.successRate) best = skill;
    }
    return best;
  }

  /**
   * Create a new skill from a Sleep Cycle success pattern.
   * Enters probation status.
   *
   * When `agentId` is provided, the skill is owned by that specialist
   * (queryable via `findActive(agentId)` + `findBySignature(sig, agentId)`).
   * Undefined = legacy shared skill (agent_id NULL), readable by any agent
   * as a fallback when they have no owned match.
   */
  createFromPattern(
    pattern: ExtractedPattern,
    riskScore: number,
    depConeHashes: Record<string, string>,
    agentId?: string,
  ): CachedSkill {
    const scope = agentId ?? this.agentId;
    const skill: CachedSkill = {
      taskSignature: pattern.taskTypeSignature,
      approach: pattern.approach ?? pattern.description,
      successRate: pattern.confidence,
      status: 'probation',
      probationRemaining: this.probationSessions,
      usageCount: 0,
      riskAtCreation: riskScore,
      depConeHashes,
      lastVerifiedAt: Date.now(),
      verificationProfile: riskToProfile(riskScore),
      ...(scope !== undefined ? { agentId: scope } : {}),
    };
    this.store.insert(skill);
    return skill;
  }

  /**
   * Verify a skill is still fresh based on its risk-tiered profile.
   * Returns { valid: true } if verification passes.
   *
   * Note: verificationProfile governs this freshness check only.
   * The oracle gate selects and runs oracles independently (core-loop Step 5).
   * Dep-cone is frozen at skill creation; stale hashes trigger demotion via reVerifyStaleSkills().
   */
  verify(skill: CachedSkill): { valid: boolean; reason?: string } {
    // All profiles check dep cone hashes
    const hashCheck = this.checkDepConeHashes(skill.depConeHashes);
    if (!hashCheck.valid) return hashCheck;

    // hash-only profile stops here
    if (skill.verificationProfile === 'hash-only') {
      return { valid: true };
    }

    // structural and full profiles require files to exist
    for (const filePath of Object.keys(skill.depConeHashes)) {
      const absPath = resolve(this.workspace, filePath);
      if (!existsSync(absPath)) {
        return { valid: false, reason: `File ${filePath} no longer exists` };
      }
    }

    // For full profile, we'd run the test suite — but that's async and
    // handled by the core loop's oracle gate, not here.
    // The skill manager just checks structural freshness.

    return { valid: true };
  }

  /**
   * Record the outcome of using a skill.
   * Ticks probation counter, promotes to active, or demotes on failure.
   */
  recordOutcome(skill: CachedSkill, success: boolean): void {
    this.store.incrementUsage(skill.taskSignature);

    if (!success) {
      // Failure → demote immediately
      this.store.updateStatus(skill.taskSignature, 'demoted');
      return;
    }

    if (skill.status === 'probation') {
      const remaining = skill.probationRemaining - 1;
      if (remaining <= 0) {
        // Probation complete → promote to active
        this.store.updateStatus(skill.taskSignature, 'active', 0);
      } else {
        this.store.updateStatus(skill.taskSignature, 'probation', remaining);
      }
    }

    // Update verification timestamp
    this.store.updateDepConeHashes(skill.taskSignature, this.computeCurrentHashes(Object.keys(skill.depConeHashes)));
  }

  /**
   * Re-verify active skills whose dep-cone files have changed.
   * Demotes stale skills so they don't produce incorrect L0 reflex shortcuts.
   * Called periodically by the Sleep Cycle (GAP-9).
   */
  reVerifyStaleSkills(): { checked: number; demoted: number } {
    // Sleep cycle verification is fleet-wide, not per-agent
    const activeSkills = this.store.findActive();
    let checked = 0;
    let demoted = 0;

    for (const skill of activeSkills) {
      checked++;
      const result = this.verify(skill);
      if (!result.valid) {
        this.store.updateStatus(skill.taskSignature, 'demoted');
        demoted++;
      } else {
        // Refresh hashes and timestamp
        this.store.updateDepConeHashes(
          skill.taskSignature,
          this.computeCurrentHashes(Object.keys(skill.depConeHashes)),
        );
      }
    }

    return { checked, demoted };
  }

  /**
   * Check if dep cone file hashes still match.
   */
  private checkDepConeHashes(hashes: Record<string, string>): { valid: boolean; reason?: string } {
    for (const [filePath, expectedHash] of Object.entries(hashes)) {
      const absPath = resolve(this.workspace, filePath);
      try {
        const content = readFileSync(absPath, 'utf-8');
        const currentHash = hashContent(content);
        if (currentHash !== expectedHash) {
          return { valid: false, reason: `File ${filePath} has changed (hash mismatch)` };
        }
      } catch {
        return { valid: false, reason: `File ${filePath} not readable` };
      }
    }
    return { valid: true };
  }

  /**
   * Compute current file hashes for a set of paths.
   */
  computeCurrentHashes(filePaths: string[]): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const filePath of filePaths) {
      const absPath = resolve(this.workspace, filePath);
      try {
        const content = readFileSync(absPath, 'utf-8');
        hashes[filePath] = hashContent(content);
      } catch {
        // File doesn't exist or not readable — skip
      }
    }
    return hashes;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function riskToProfile(risk: number): CachedSkill['verificationProfile'] {
  if (risk < 0.2) return 'hash-only';
  if (risk < 0.4) return 'structural';
  return 'full';
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

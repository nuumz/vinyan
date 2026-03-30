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
 * Source of truth: vinyan-tdd.md §12B (Skill Formation), Phase 2.5
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import type { CachedSkill, ExtractedPattern } from "./types.ts";
import type { SkillStore } from "../db/skill-store.ts";

export interface SkillManagerConfig {
  skillStore: SkillStore;
  workspace: string;
  /** Minimum effectiveness to keep active (default: 0.7) */
  minEffectiveness?: number;
  /** Probation sessions before promotion (default: 10) */
  probationSessions?: number;
}

export class SkillManager {
  private store: SkillStore;
  private workspace: string;
  private minEffectiveness: number;
  private probationSessions: number;

  constructor(config: SkillManagerConfig) {
    this.store = config.skillStore;
    this.workspace = config.workspace;
    this.minEffectiveness = config.minEffectiveness ?? 0.7;
    this.probationSessions = config.probationSessions ?? 10;
  }

  /** Count active (promoted) skills. */
  countActive(): number {
    return this.store.countActive();
  }

  /**
   * Try to match a task to a cached active skill.
   * Returns null if no matching active skill found.
   */
  match(taskSignature: string): CachedSkill | null {
    const skill = this.store.findBySignature(taskSignature);
    if (!skill || skill.status !== "active") return null;
    return skill;
  }

  /**
   * Create a new skill from a Sleep Cycle success pattern.
   * Enters probation status.
   */
  createFromPattern(
    pattern: ExtractedPattern,
    riskScore: number,
    depConeHashes: Record<string, string>,
  ): CachedSkill {
    const skill: CachedSkill = {
      taskSignature: pattern.taskTypeSignature,
      approach: pattern.approach ?? pattern.description,
      successRate: pattern.confidence,
      status: "probation",
      probationRemaining: this.probationSessions,
      usageCount: 0,
      riskAtCreation: riskScore,
      depConeHashes,
      lastVerifiedAt: Date.now(),
      verificationProfile: riskToProfile(riskScore),
    };
    this.store.insert(skill);
    return skill;
  }

  /**
   * Verify a skill is still fresh based on its risk-tiered profile.
   * Returns { valid: true } if verification passes.
   */
  verify(skill: CachedSkill): { valid: boolean; reason?: string } {
    // All profiles check dep cone hashes
    const hashCheck = this.checkDepConeHashes(skill.depConeHashes);
    if (!hashCheck.valid) return hashCheck;

    // hash-only profile stops here
    if (skill.verificationProfile === "hash-only") {
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
      this.store.updateStatus(skill.taskSignature, "demoted");
      return;
    }

    if (skill.status === "probation") {
      const remaining = skill.probationRemaining - 1;
      if (remaining <= 0) {
        // Probation complete → promote to active
        this.store.updateStatus(skill.taskSignature, "active", 0);
      } else {
        this.store.updateStatus(skill.taskSignature, "probation", remaining);
      }
    }

    // Update verification timestamp
    this.store.updateDepConeHashes(
      skill.taskSignature,
      this.computeCurrentHashes(Object.keys(skill.depConeHashes)),
    );
  }

  /**
   * Check if dep cone file hashes still match.
   */
  private checkDepConeHashes(
    hashes: Record<string, string>,
  ): { valid: boolean; reason?: string } {
    for (const [filePath, expectedHash] of Object.entries(hashes)) {
      const absPath = resolve(this.workspace, filePath);
      try {
        const content = readFileSync(absPath, "utf-8");
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
        const content = readFileSync(absPath, "utf-8");
        hashes[filePath] = hashContent(content);
      } catch {
        // File doesn't exist or not readable — skip
      }
    }
    return hashes;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function riskToProfile(risk: number): CachedSkill["verificationProfile"] {
  if (risk < 0.2) return "hash-only";
  if (risk < 0.4) return "structural";
  return "full";
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

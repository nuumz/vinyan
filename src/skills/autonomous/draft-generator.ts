/**
 * Draft generator — the ONE LLM-backed component on the autonomous creation
 * path (A3: everything after generation is rule-based).
 *
 * This file provides:
 *   1. The structural `DraftGenerator` type (re-exported from `types.ts`).
 *   2. `buildStubDraftGenerator()` — a deterministic fallback that emits a
 *      minimal-but-valid `SkillMdRecord`. The stub is enough for:
 *        - MVP factory wire-in (no LLM dependency),
 *        - test suites that need a real-shaped record to pipe through the
 *          gate + critic + promotion pipeline.
 *
 * A real LLM-backed generator is a follow-up factory wiring task; its output
 * must satisfy the same post-conditions the stub already enforces here.
 */
import { computeContentHash } from '../skill-md/hash.ts';
import type { SkillMdFrontmatter, SkillMdRecord } from '../skill-md/schema.ts';
import type { DraftGenerator, DraftRequest } from './types.ts';

export type { DraftGenerator, DraftRequest } from './types.ts';

/**
 * Build the deterministic stub generator. The produced record:
 *   - declares `confidence_tier: 'probabilistic'` (A5 — probation tier),
 *   - declares `status: 'quarantined'` (A6 — zero-trust until gate approves),
 *   - declares `origin: 'local'` (SK4 autonomous creations are always local),
 *   - stamps `expected_prediction_error_reduction` with the window-derived
 *     baseline/target (A7 commitment).
 *
 * Canonical id format:
 *   `auto/<slug>` where slug = sanitized(taskSignature).
 */
export function buildStubDraftGenerator(): DraftGenerator {
  return async (req: DraftRequest): Promise<SkillMdRecord> => {
    const slug = sanitizeSlug(req.taskSignature);
    const id = `auto/${slug}`;

    const representativeIds = req.representativeSamples.slice(0, 5).map((s) => s.taskId);

    const frontmatter: SkillMdFrontmatter = {
      id,
      name: `Autonomous: ${req.taskSignature}`,
      version: '0.1.0',
      description: `Drafted from ${req.representativeSamples.length} samples for task signature '${req.taskSignature}'.`,
      requires_toolsets: [],
      fallback_for_toolsets: [],
      confidence_tier: 'probabilistic',
      origin: 'local',
      declared_oracles: [],
      expected_prediction_error_reduction: {
        baseline_composite_error: clamp01(req.expectedReduction.baseline),
        target_composite_error: clamp01(
          Math.min(req.expectedReduction.target, req.expectedReduction.baseline),
        ),
        trial_window: Math.max(1, Math.trunc(req.expectedReduction.window)),
      },
      falsifiable_by: [],
      status: 'quarantined',
      task_signature: req.taskSignature,
    };

    const body = {
      overview: `Autonomously drafted capability for task signature '${req.taskSignature}'. This skill captures the approach that produced a sustained PredictionError reduction over the observed window.`,
      whenToUse: `Use when a new task matches signature '${req.taskSignature}'.`,
      procedure: buildProcedureBody(req.taskSignature, representativeIds),
    };

    const contentHash = computeContentHash(frontmatter, body);
    return { frontmatter, body, contentHash };
  };
}

function buildProcedureBody(signature: string, sampleIds: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`Approach template derived from prior successful runs on signature '${signature}':`);
  lines.push('');
  lines.push('1. Load the task context and confirm the signature matches.');
  lines.push('2. Replay the approach that most recently succeeded with low PredictionError.');
  lines.push('3. Verify via Oracle Gate before committing.');
  if (sampleIds.length > 0) {
    lines.push('');
    lines.push('Representative prior task ids:');
    for (const id of sampleIds) {
      lines.push(`- ${id}`);
    }
  }
  return lines.join('\n');
}

function sanitizeSlug(raw: string): string {
  // SkillMdFrontmatterSchema requires: /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) return 'sig';
  // Ensure leading char is a letter (matches the id regex).
  if (!/^[a-z]/.test(slug)) return `s-${slug}`;
  return slug;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

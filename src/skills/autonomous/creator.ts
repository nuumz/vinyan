/**
 * AutonomousSkillCreator — the A7 closing state machine (W4 SK4).
 *
 * Two entry points:
 *   - `observe(sample)` — record a task's PredictionError in the rolling
 *     window for its signature. Non-triggering; windowing is passive.
 *   - `tryDraftFor(taskSignature)` — evaluate the window, and on qualify run
 *     guardrails → gate → critic → promotion-rule. Deterministic after the
 *     single LLM-backed draft call (A3).
 *
 * No IO is performed outside the injected deps; the class is pure state +
 * one write each to `artifactStore` and `skillStore` on the promotion arm.
 *
 * Reuses structural types from `src/skills/hub/importer.ts`:
 *   - `ImporterGateFn`     — dry-run gate signature
 *   - `ImporterCriticFn`   — critic signature
 *
 * ...so the same factory adapters already wired for SK3 Hub import can be
 * shared with SK4. Bare re-exports live in `./index.ts`.
 */
import { containsBypassAttempt, detectPromptInjection } from '../../guardrails/index.ts';
import { computeContentHash } from '../skill-md/hash.ts';
import type { SkillMdRecord } from '../skill-md/schema.ts';
import type { SkillArtifactStore } from '../artifact-store.ts';
import type {
  ImporterCriticFn,
  ImporterCriticVerdict,
  ImporterGateFn,
  ImporterGateVerdict,
} from '../hub/importer.ts';
import { buildWindowState, DEFAULT_WINDOW_POLICY } from './prediction-window.ts';
import type { CachedSkillLike, SkillStoreLike, PredictionLedgerLike } from './store-adapters.ts';
import type {
  DraftDecision,
  DraftGenerator,
  PredictionErrorSample,
  WindowPolicy,
  WindowState,
} from './types.ts';

export interface AutonomousSkillCreatorDeps {
  /** Read-only access to the prediction ledger for signature-scoped history. */
  readonly predictionLedger: PredictionLedgerLike;
  readonly skillStore: SkillStoreLike;
  readonly artifactStore: SkillArtifactStore;
  readonly generator: DraftGenerator;
  readonly gate: ImporterGateFn;
  readonly critic: ImporterCriticFn;
  readonly policy?: Partial<WindowPolicy>;
  readonly clock?: () => number;
  /** Workspace root, threaded into the dry-run gate request. */
  readonly workspace?: string;
  readonly profile: string;
  /**
   * Confidence floor for the gate's aggregate oracle confidence. Mirrors
   * the Hub importer's `HUB_IMPORT_GATE_CONFIDENCE_FLOOR`. Below this → reject.
   */
  readonly gateConfidenceFloor?: number;
}

export const AUTONOMOUS_DRAFT_RULE_ID = 'autonomous-draft-v1';
export const AUTONOMOUS_GATE_CONFIDENCE_FLOOR = 0.7;

/**
 * In-memory rolling window per task signature + last-draft cooldown timestamp.
 */
interface SignatureState {
  samples: PredictionErrorSample[];
  lastDraftAt?: number;
}

export class AutonomousSkillCreator {
  private readonly deps: AutonomousSkillCreatorDeps;
  private readonly policy: WindowPolicy;
  private readonly clock: () => number;
  private readonly windows: Map<string, SignatureState> = new Map();
  private readonly gateFloor: number;

  constructor(deps: AutonomousSkillCreatorDeps) {
    this.deps = deps;
    this.policy = { ...DEFAULT_WINDOW_POLICY, ...(deps.policy ?? {}) };
    this.clock = deps.clock ?? (() => Date.now());
    this.gateFloor = deps.gateConfidenceFloor ?? AUTONOMOUS_GATE_CONFIDENCE_FLOOR;
  }

  /**
   * Record a sample into the rolling window for `sample.taskSignature`.
   * Samples are retained up to `2 * windowSize` so the split-half test can
   * always evaluate even as new evidence arrives.
   */
  observe(sample: PredictionErrorSample): void {
    const entry = this.windows.get(sample.taskSignature) ?? { samples: [] };
    entry.samples.push(sample);
    // Trim to a bounded history; the window policy only inspects the tail.
    const maxKeep = Math.max(this.policy.windowSize * 2, this.policy.splitHalf * 2);
    if (entry.samples.length > maxKeep) {
      entry.samples = entry.samples.slice(-maxKeep);
    }
    this.windows.set(sample.taskSignature, entry);
  }

  /**
   * State machine. Evaluates the window for `taskSignature`; on qualify drafts,
   * scans, dry-runs the gate, consults the critic, then invokes the promotion
   * rule. Every arm records its own DraftDecision; no recursion, no retries.
   */
  async tryDraftFor(taskSignature: string): Promise<DraftDecision> {
    const state = this.windows.get(taskSignature);
    const samples = state?.samples ?? [];
    const windowState = buildWindowState(taskSignature, samples, this.policy);

    // 1. Window must qualify.
    if (!windowState.qualifies) {
      return { kind: 'no-op', reason: 'window-unqualified' };
    }

    // 2. No existing non-demoted skill for this signature (avoid re-drafting).
    //    CachedSkill.status is 'probation' | 'active' | 'demoted' — only a
    //    demoted slot is considered available for a fresh autonomous draft.
    const existing = this.deps.skillStore.findBySignature(taskSignature);
    if (existing && existing.status !== 'demoted') {
      return { kind: 'no-op', reason: 'active-skill-exists' };
    }

    // 3. Cooldown — don't re-draft this signature too soon after a prior attempt.
    const now = this.clock();
    if (state?.lastDraftAt != null && now - state.lastDraftAt < this.policy.cooldownMs) {
      return { kind: 'no-op', reason: 'cooldown-active' };
    }

    // 4. Call the generator (the one LLM-backed step).
    const request = buildDraftRequest(windowState);
    const draftedRaw = await this.deps.generator(request);

    // Enforce SK4 invariants on the generator output regardless of what it
    // returned: A3 (no LLM in governance path) means the generator is NOT
    // trusted to stamp these correctly.
    const drafted = enforceCreationInvariants(draftedRaw, windowState);

    // Record cooldown start — we entered the verification pipeline.
    const stateAfter = this.windows.get(taskSignature) ?? { samples: [] };
    stateAfter.lastDraftAt = now;
    this.windows.set(taskSignature, stateAfter);

    // 5. Guardrail static-scan. Any injection/bypass → reject (A6).
    const scanText = buildScanText(drafted);
    const injection = detectPromptInjection(scanText);
    const bypass = containsBypassAttempt(scanText);
    if (injection.detected || bypass.detected) {
      return {
        kind: 'drafted-rejected',
        reason: 'guardrail-scan',
        detail: [...injection.patterns, ...bypass.patterns].join(','),
      };
    }

    // 6. Dry-run Oracle Gate.
    const gateVerdict: ImporterGateVerdict = await this.deps.gate({
      tool: 'autonomous_skill_draft_dry_run',
      params: {
        file_path: `skills/${drafted.frontmatter.id}/SKILL.md`,
        content: drafted.body.procedure,
        workspace: this.deps.workspace ?? '.',
      },
      skillId: drafted.frontmatter.id,
      dryRun: true,
    });
    if (!isGateVerified(gateVerdict, this.gateFloor)) {
      return {
        kind: 'drafted-rejected',
        reason: 'gate',
        detail: buildGateRejectDetail(gateVerdict, this.gateFloor),
      };
    }

    // 7. Critic review (A1 — must be a different LLM context than the generator).
    const criticVerdict: ImporterCriticVerdict = await this.deps.critic({
      skillId: drafted.frontmatter.id,
      skillMd: drafted.body.procedure,
      gateVerdict,
    });
    if (!criticVerdict.approved) {
      return {
        kind: 'drafted-rejected',
        reason: 'critic',
        detail: criticVerdict.notes || 'critic rejected',
      };
    }

    // 8. Promotion rule: aggregateConfidence >= floor AND critic approved.
    const aggregateConfidence = gateVerdict.aggregateConfidence ?? 0;
    if (aggregateConfidence < this.gateFloor) {
      return {
        kind: 'drafted-rejected',
        reason: 'gate',
        detail: `low aggregate confidence ${aggregateConfidence}`,
      };
    }

    // 9. Persist: artifact (SKILL.md) + cached_skills row.
    const promotedRecord: SkillMdRecord = withPromotionState(drafted, now);
    await this.deps.artifactStore.write(promotedRecord);

    const cached: CachedSkillLike = {
      taskSignature,
      approach: drafted.frontmatter.id,
      successRate: windowState.successFraction,
      status: 'probation',
      probationRemaining: 10,
      usageCount: 0,
      riskAtCreation: windowState.meanRecentError,
      depConeHashes: {},
      lastVerifiedAt: now,
      verificationProfile: 'structural',
      origin: 'local',
    };
    this.deps.skillStore.insert(cached);

    return {
      kind: 'drafted-promoted',
      skillId: drafted.frontmatter.id,
      tier: 'probabilistic',
      ruleId: AUTONOMOUS_DRAFT_RULE_ID,
    };
  }

  /** Snapshot of the current window for every observed signature (read-only). */
  windowSnapshot(): ReadonlyMap<string, WindowState> {
    const snap = new Map<string, WindowState>();
    for (const [sig, entry] of this.windows) {
      snap.set(sig, buildWindowState(sig, entry.samples, this.policy));
    }
    return snap;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildDraftRequest(windowState: WindowState): import('./types.ts').DraftRequest {
  return {
    taskSignature: windowState.taskSignature,
    representativeSamples: windowState.samples.slice(-5),
    expectedReduction: {
      baseline: windowState.meanPriorError,
      target: windowState.meanRecentError,
      window: windowState.samples.length,
    },
  };
}

/**
 * Force SK4 invariants on generator output. A generator that ignored the
 * contract still must NOT be able to smuggle a non-probabilistic skill into
 * the store — governance is rule-based (A3). We recompute the content hash
 * after rewriting frontmatter because the hash is a function of frontmatter.
 */
function enforceCreationInvariants(raw: SkillMdRecord, windowState: WindowState): SkillMdRecord {
  const expected = raw.frontmatter.expected_prediction_error_reduction ?? {
    baseline_composite_error: clamp01(windowState.meanPriorError),
    target_composite_error: clamp01(Math.min(windowState.meanRecentError, windowState.meanPriorError)),
    trial_window: Math.max(1, windowState.samples.length),
  };

  const frontmatter = {
    ...raw.frontmatter,
    confidence_tier: 'probabilistic' as const,
    status: 'quarantined' as const,
    origin: 'local' as const,
    expected_prediction_error_reduction: expected,
    task_signature: windowState.taskSignature,
  };
  const contentHash = computeContentHash(frontmatter, raw.body);
  return { ...raw, frontmatter, contentHash };
}

function withPromotionState(record: SkillMdRecord, now: number): SkillMdRecord {
  const frontmatter = {
    ...record.frontmatter,
    confidence_tier: 'probabilistic' as const,
    status: 'probation' as const,
    promoted_at: now,
    origin: 'local' as const,
  };
  const contentHash = computeContentHash(frontmatter, record.body);
  return { ...record, frontmatter, contentHash };
}

function buildScanText(record: SkillMdRecord): string {
  const parts: string[] = [];
  parts.push(record.frontmatter.name);
  parts.push(record.frontmatter.description);
  parts.push(record.body.overview);
  parts.push(record.body.whenToUse);
  if (record.body.preconditions) parts.push(record.body.preconditions);
  parts.push(record.body.procedure);
  if (record.body.falsification?.raw) parts.push(record.body.falsification.raw);
  return parts.join('\n\n');
}

function isGateVerified(verdict: ImporterGateVerdict, floor: number): boolean {
  if (verdict.epistemicDecision === 'block') return false;
  if (verdict.decision === 'block' && (verdict.epistemicDecision == null || verdict.epistemicDecision !== 'allow-with-caveats')) {
    // block without an allow-with-caveats override is a hard reject
    if (verdict.epistemicDecision !== 'allow') return false;
  }
  const accepted =
    verdict.epistemicDecision === 'allow' ||
    verdict.epistemicDecision === 'allow-with-caveats' ||
    (verdict.epistemicDecision == null && verdict.decision === 'allow');
  if (!accepted) return false;
  return (verdict.aggregateConfidence ?? 0) >= floor;
}

function buildGateRejectDetail(verdict: ImporterGateVerdict, floor: number): string {
  const decisionLabel = verdict.epistemicDecision ?? verdict.decision;
  const confidence = verdict.aggregateConfidence ?? 0;
  return `gate ${decisionLabel} @ confidence ${confidence.toFixed(2)} (floor ${floor})`;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

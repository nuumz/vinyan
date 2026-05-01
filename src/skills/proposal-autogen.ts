/**
 * Skill proposal auto-generator (round 4 — restart-safe + adaptive).
 *
 * Hermes lesson revisited: a verified repeated success should turn
 * into procedural memory automatically — but only as a **quarantined**
 * proposal until trust is established.
 *
 * R3 hardening: tracker state is now persisted via
 * `SkillAutogenStateStore` (mig 031) so a server restart does NOT
 * lose progress AND does NOT promote a half-counted signature carried
 * over from a previous run. Promotion is gated by `canPromote`, which
 * requires `MIN_POST_RESTART_EVIDENCE` fresh successes after boot
 * before honouring an old counter.
 *
 * R1 hardening: the success-streak threshold is now adaptive. The
 * policy reads queue depth, acceptance rate, and quarantine rate from
 * `SkillProposalStore` and produces a deterministic threshold in
 * `[MIN_THRESHOLD, MAX_THRESHOLD]`. Every change is appended to
 * `parameter_adaptations` with provenance (A8). A `policyEnabled =
 * false` feature flag reverts to a static value for instant rollback.
 *
 * Design constraints (unchanged):
 *   - A1 — generation ≠ verification: the policy is rule-based, not
 *          LLM-decided. The store + ledger are deterministic.
 *   - A3 — same inputs always produce the same threshold + same
 *          promotion verdict.
 *   - A6 — proposals always land as `quarantined`-by-default; trust
 *          tier stays at `quarantined` regardless of how the
 *          proposal was generated. Activation requires a human-
 *          attributed `approve` call.
 *   - A8 — every emitted proposal carries `sourceTaskIds` and a
 *          state-table boot id; every threshold change is in the
 *          parameter ledger.
 *   - A9 — corrupt persisted state, schema mismatches, or store
 *          failures degrade to "no prior history" rather than
 *          poisoning the runtime. Listener never crashes the bus.
 */

import type { VinyanBus } from '../core/bus.ts';
import type { SkillProposalStore } from '../db/skill-proposal-store.ts';
import type { CachedSkill } from '../orchestrator/types.ts';
import type { ParameterLedger } from '../orchestrator/adaptive-params/parameter-ledger.ts';
import {
  computeAdaptiveThreshold,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  readPersistedThreshold,
  recordThresholdChange,
  STATIC_THRESHOLD_FALLBACK,
  type AutogenPolicySnapshot,
} from './autogen-policy.ts';
import {
  DEFAULT_COOLDOWN_MS,
  type SkillAutogenStateStore,
} from './autogen-state-store.ts';

export interface SkillProposalAutogenDeps {
  readonly bus: VinyanBus;
  readonly store: SkillProposalStore;
  /**
   * Restart-safe tracker (mig 031). Required for production. Tests
   * that want pure in-memory semantics can omit it — promotion will
   * be gated only by the threshold and the in-memory map (R3
   * preserved at the policy layer).
   */
  readonly stateStore?: SkillAutogenStateStore;
  /**
   * Parameter ledger (mig 030). Required to persist threshold
   * changes. When omitted the policy still computes a value but
   * doesn't append history rows.
   */
  readonly ledger?: ParameterLedger;
  /**
   * Static threshold used when `policyEnabled` is false. Default 3.
   * Bounded at runtime to `[MIN_THRESHOLD, MAX_THRESHOLD]`.
   */
  readonly threshold?: number;
  /**
   * Adaptive policy switch — set to `false` to revert to the static
   * threshold instantly without restarting. Default: true.
   */
  readonly policyEnabled?: boolean;
  /** Profile namespace for the produced proposal. Default `'default'`. */
  readonly defaultProfile?: string;
  /**
   * Per-signature debounce window in ms. Default 6h. After a
   * proposal emits, the same signature cannot emit again until
   * `now > cooldownUntil`.
   */
  readonly cooldownMs?: number;
  /**
   * How often (in seconds) to recompute the adaptive threshold from
   * the proposal store. Defaults to 5 minutes — frequent enough that
   * a flooded queue raises the threshold quickly, sparse enough that
   * the SQLite scan is amortised.
   */
  readonly recomputeIntervalSeconds?: number;
}

const DEFAULT_RECOMPUTE_INTERVAL_S = 5 * 60;
const MAX_TRACKED_SIGNATURES_IN_MEM = 1000;

interface InMemoryEntry {
  successes: number;
  successesAtBoot: number;
  lastSeen: number;
  taskIds: string[];
  cooldownUntil: number;
}

/**
 * Wire the autogenerator. Returns an unsubscribe function. Test
 * fixtures may pass a fake clock + minimal deps; production wiring
 * (in `cli/serve.ts`) supplies the state store + ledger so all
 * hardening kicks in.
 */
export function wireSkillProposalAutogen(deps: SkillProposalAutogenDeps): () => void {
  const profile = deps.defaultProfile ?? 'default';
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const policyEnabled = deps.policyEnabled ?? true;
  const staticThreshold = clampThreshold(deps.threshold ?? STATIC_THRESHOLD_FALLBACK);
  const recomputeIntervalMs = (deps.recomputeIntervalSeconds ?? DEFAULT_RECOMPUTE_INTERVAL_S) * 1000;

  // Reconcile durable state at boot.
  let bootId: string | null = null;
  if (deps.stateStore) {
    try {
      const result = deps.stateStore.reconcile();
      bootId = result.bootId;
      deps.bus.emit('skill:autogen_tracker_loaded', {
        bootId: result.bootId,
        loaded: result.loaded,
        prunedStale: result.prunedStale,
        invalidatedSchema: result.invalidatedSchema,
        invalidatedCorrupt: result.invalidatedCorrupt,
      });
      if (result.prunedStale > 0) {
        deps.bus.emit('skill:autogen_tracker_pruned', {
          bootId: result.bootId,
          reason: 'ttl',
          count: result.prunedStale,
        });
      }
      if (result.invalidatedSchema > 0) {
        deps.bus.emit('skill:autogen_tracker_invalidated', {
          bootId: result.bootId,
          reason: 'schema-mismatch',
          count: result.invalidatedSchema,
        });
      }
      if (result.invalidatedCorrupt > 0) {
        deps.bus.emit('skill:autogen_tracker_invalidated', {
          bootId: result.bootId,
          reason: 'corrupt-json',
          count: result.invalidatedCorrupt,
        });
      }
    } catch (err) {
      // A9: degrade to in-memory-only when reconcile fails (e.g. table
      // missing on a test DB that didn't migrate).
      console.warn('[skill-autogen] state reconcile failed; falling back to in-memory only:', err);
      deps.bus.emit('skill:autogen_tracker_invalidated', {
        bootId: 'unavailable',
        reason: 'missing-table',
        count: 0,
      });
    }
  }

  // Initial threshold — read persisted value if available.
  let currentThreshold = readInitialThreshold(deps, staticThreshold);
  let lastRecomputedAt = 0;

  // In-memory companion to the durable store. Two reasons to keep it:
  //   1. Tests that pass no `stateStore` still need a counter.
  //   2. Hot-path reads avoid hitting SQLite on every emission.
  const memTracker = new Map<string, InMemoryEntry>();

  const off = deps.bus.on('skill:outcome', ({ taskId, skill, success }) => {
    if (!success || !skill?.taskSignature) return;

    const signatureKey = `${skill.agentId ?? 'shared'}:${skill.taskSignature}`;

    // 1. Recompute threshold lazily — bounded by `recomputeIntervalMs`
    //    so a high-traffic emission storm doesn't pound SQLite.
    const now = Date.now();
    if (now - lastRecomputedAt >= recomputeIntervalMs) {
      lastRecomputedAt = now;
      currentThreshold = recomputeThresholdAndRecord(deps, profile, currentThreshold, policyEnabled, staticThreshold);
    }

    // 2. Persist + bump the counter. Falls back to in-memory if the
    //    durable store is missing.
    let durable: { successes: number; successesAtBoot: number; cooldownUntil: number } | null = null;
    if (deps.stateStore && bootId) {
      try {
        const record = deps.stateStore.recordSuccess({
          profile,
          signatureKey,
          bootId,
          taskId,
        });
        durable = {
          successes: record.successes,
          successesAtBoot: record.successesAtBoot,
          cooldownUntil: record.cooldownUntil,
        };
      } catch (err) {
        console.warn('[skill-autogen] state recordSuccess failed:', err);
      }
    }

    const memEntry = memTracker.get(signatureKey) ?? {
      successes: 0,
      successesAtBoot: 0,
      lastSeen: 0,
      taskIds: [],
      cooldownUntil: 0,
    };
    memEntry.successes += 1;
    memEntry.lastSeen = now;
    if (memEntry.taskIds.length < 25 && !memEntry.taskIds.includes(taskId)) {
      memEntry.taskIds.push(taskId);
    }
    memTracker.set(signatureKey, memEntry);
    if (memTracker.size > MAX_TRACKED_SIGNATURES_IN_MEM) {
      evictOldest(memTracker);
    }

    // 3. Promotion gate. Use durable state when present (R3 zero-trust
    //    against carryover), otherwise the in-memory map.
    const successes = durable?.successes ?? memEntry.successes;
    const successesAtBoot = durable?.successesAtBoot ?? memEntry.successesAtBoot;
    const cooldownUntil = durable?.cooldownUntil ?? memEntry.cooldownUntil;
    const sinceBoot = Math.max(0, successes - successesAtBoot);

    // G4: a row that hasn't reached threshold yet is "still climbing"
    // — that is normal autogen progress, NOT a block to surface to
    // the operator. Emit `_promotion_blocked` only when the row has
    // crossed the threshold but a guard (cooldown / fresh-evidence)
    // refused promotion. Below-threshold returns silently so the
    // event stream stays signal-rich.
    const meetsThreshold = successes >= currentThreshold;

    if (cooldownUntil > now) {
      if (meetsThreshold) {
        deps.bus.emit('skill:autogen_promotion_blocked', {
          profile,
          signatureKey,
          reason: 'cooldown',
          successes,
          threshold: currentThreshold,
        });
      }
      return;
    }
    if (sinceBoot < 1) {
      // R3: refuse promotion until at least one fresh success is
      // observed in this runtime. Without this, a row carrying
      // `successes >= threshold` from a previous boot could promote
      // on the very first emit post-restart. Only emit the event
      // when the row would otherwise have promoted.
      if (meetsThreshold) {
        deps.bus.emit('skill:autogen_promotion_blocked', {
          profile,
          signatureKey,
          reason: 'fresh-evidence',
          successes,
          threshold: currentThreshold,
        });
      }
      return;
    }
    if (!meetsThreshold) {
      // Normal accumulation — silent. `successes` < threshold is the
      // common case on every climb, not an operator-actionable
      // signal.
      return;
    }

    // 4. Threshold reached, fresh evidence collected, no cooldown —
    //    generate (or merge) the proposal.
    try {
      const proposedName = autogenName(skill);
      const skillMd = renderSkillMd(skill, successes);
      // The store's merge path adds `input.successCount` to existing,
      // so pass `1` per emission. Idempotent on `proposedName`.
      deps.store.create({
        profile,
        proposedName,
        proposedCategory: 'auto-generated',
        skillMd,
        capabilityTags: [skill.agentId ?? 'shared'].filter(Boolean) as string[],
        sourceTaskIds: [taskId],
        evidenceEventIds: [],
        successCount: 1,
      });
      // Mark the cooldown window (R1: debounce per signature).
      memEntry.cooldownUntil = now + cooldownMs;
      if (deps.stateStore) {
        try {
          deps.stateStore.recordEmit({ profile, signatureKey, cooldownMs });
        } catch (err) {
          console.warn('[skill-autogen] state recordEmit failed:', err);
        }
      }
    } catch (err) {
      console.warn('[skill-autogen] proposal create failed:', err);
    }
  });

  return off;
}

/**
 * Compute the threshold for the *first* emission. Order:
 *   1. Persisted ledger value (operator may have explicitly tuned).
 *   2. Fresh adaptive computation (when policy enabled).
 *   3. Static fallback.
 */
function readInitialThreshold(
  deps: SkillProposalAutogenDeps,
  staticThreshold: number,
): number {
  if (deps.policyEnabled === false) return staticThreshold;
  if (deps.ledger) {
    const persisted = readPersistedThreshold(deps.ledger);
    if (persisted !== null) return persisted;
  }
  if (deps.stateStore && deps.store) {
    const snapshot = computeAdaptiveThreshold(deps.store, deps.defaultProfile ?? 'default', {
      enabled: true,
      staticThreshold,
    });
    return snapshot.threshold;
  }
  return staticThreshold;
}

function recomputeThresholdAndRecord(
  deps: SkillProposalAutogenDeps,
  profile: string,
  oldThreshold: number,
  policyEnabled: boolean,
  staticThreshold: number,
): number {
  let snapshot: AutogenPolicySnapshot;
  try {
    snapshot = computeAdaptiveThreshold(deps.store, profile, {
      enabled: policyEnabled,
      staticThreshold,
    });
  } catch (err) {
    console.warn('[skill-autogen] policy compute failed:', err);
    return oldThreshold;
  }
  if (snapshot.threshold === oldThreshold) return oldThreshold;
  if (deps.ledger) {
    try {
      const recorded = recordThresholdChange(
        deps.ledger,
        oldThreshold,
        snapshot,
        'autogen periodic recompute',
      );
      if (recorded) {
        deps.bus.emit('skill:autogen_threshold_changed', {
          profile,
          oldThreshold,
          newThreshold: snapshot.threshold,
          reason: 'autogen periodic recompute',
          explanation: snapshot.explanation,
        });
      }
    } catch (err) {
      console.warn('[skill-autogen] ledger append failed:', err);
    }
  } else {
    deps.bus.emit('skill:autogen_threshold_changed', {
      profile,
      oldThreshold,
      newThreshold: snapshot.threshold,
      reason: 'autogen periodic recompute (no ledger)',
      explanation: snapshot.explanation,
    });
  }
  return snapshot.threshold;
}

function evictOldest(map: Map<string, InMemoryEntry>): void {
  let oldestKey: string | null = null;
  let oldestSeen = Infinity;
  for (const [k, v] of map.entries()) {
    if (v.lastSeen < oldestSeen) {
      oldestSeen = v.lastSeen;
      oldestKey = k;
    }
  }
  if (oldestKey) map.delete(oldestKey);
}

function clampThreshold(value: number): number {
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, value));
}

/**
 * Convert a `taskSignature` into a slug that survives the proposed-
 * name regex (`/^[a-z][a-z0-9-]*$/`).
 */
function autogenName(skill: CachedSkill): string {
  const raw = `auto-${skill.agentId ?? 'shared'}-${skill.taskSignature}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug.slice(0, 80) : `s-${slug}`.slice(0, 80);
}

/**
 * Render a minimal SKILL.md draft from the cached skill + run total.
 * Operator edits the body before approving.
 */
function renderSkillMd(skill: CachedSkill, successCount: number): string {
  const lines: string[] = [];
  lines.push(`# ${autogenName(skill)}`);
  lines.push('');
  lines.push(
    `Auto-generated from ${successCount} successful runs of task signature \`${skill.taskSignature}\`.`,
  );
  lines.push('');
  lines.push('## Approach');
  lines.push(skill.approach || '(no approach text recorded)');
  lines.push('');
  lines.push('## Provenance');
  lines.push(`- **agent:** ${skill.agentId ?? 'shared'}`);
  lines.push(`- **success rate:** ${(skill.successRate * 100).toFixed(0)}%`);
  lines.push(`- **usage count:** ${skill.usageCount}`);
  lines.push(`- **last verified:** ${new Date(skill.lastVerifiedAt).toISOString()}`);
  lines.push('');
  lines.push(
    '> **Quarantined.** This proposal was generated automatically. Review the approach above and the linked tasks before approving.',
  );
  return lines.join('\n');
}

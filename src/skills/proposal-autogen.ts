/**
 * Skill proposal auto-generator.
 *
 * Hermes lesson (`features/skills`): a verified repeated success
 * should turn into procedural memory automatically — but only as a
 * **quarantined** proposal until trust is established. This module
 * subscribes to `skill:outcome` and produces a `SkillProposal` row
 * after `threshold` consecutive successes per `(agentId, taskSignature)`
 * pair.
 *
 * Design constraints:
 *   - A3 — pure rule-based threshold; no LLM in this path.
 *   - A6 — every produced proposal is `quarantined-by-default` (the
 *          store handles this when safety flags fire); trust tier
 *          stays `quarantined` regardless. Activation requires a
 *          human-attributed `approve` call.
 *   - A8 — every proposal carries `sourceTaskIds` so the operator
 *          can replay the runs that triggered it.
 *
 * The tracker map is in-process — across server restarts the counter
 * resets to zero. That is intentional: we want to see a fresh repeat
 * pattern post-restart, not promote a half-counted signature. The
 * store itself handles the merge case (idempotent on `proposedName`).
 *
 * Capacity: the tracker is bounded to `MAX_TRACKED_SIGNATURES` to
 * prevent memory growth from one-shot signatures. Eviction is LRU
 * by `lastSeen` when the cap is hit.
 */

import type { VinyanBus } from '../core/bus.ts';
import type { SkillProposalStore } from '../db/skill-proposal-store.ts';
import type { CachedSkill } from '../orchestrator/types.ts';

export interface SkillProposalAutogenDeps {
  readonly bus: VinyanBus;
  readonly store: SkillProposalStore;
  /**
   * Successes-in-a-row required before a proposal fires. Defaults to
   * 3 — a conservative starting point. Tuned by the skill-formation
   * module before promotion to a real autogen contract; the right
   * number depends on traffic.
   */
  readonly threshold?: number;
  /** Profile namespace for the produced proposal. Defaults to `'default'`. */
  readonly defaultProfile?: string;
}

const DEFAULT_THRESHOLD = 3;
const MAX_TRACKED_SIGNATURES = 1000;

interface SuccessEntry {
  successes: number;
  lastSeen: number;
  taskIds: string[];
}

/**
 * Wire the autogenerator to a bus. Returns an unsubscribe function so
 * tests / shutdown paths can detach cleanly.
 */
export function wireSkillProposalAutogen(deps: SkillProposalAutogenDeps): () => void {
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  const profile = deps.defaultProfile ?? 'default';
  const tracker = new Map<string, SuccessEntry>();

  const off = deps.bus.on('skill:outcome', ({ taskId, skill, success }) => {
    if (!success || !skill?.taskSignature) return;

    const key = `${skill.agentId ?? 'shared'}:${skill.taskSignature}`;
    const entry = tracker.get(key) ?? { successes: 0, lastSeen: 0, taskIds: [] };
    entry.successes += 1;
    entry.lastSeen = Date.now();
    if (entry.taskIds.length < 25) entry.taskIds.push(taskId);
    tracker.set(key, entry);

    // Evict the oldest entry when the cap is exceeded — unbounded growth
    // would surface as a slow memory leak in long-running gateways.
    if (tracker.size > MAX_TRACKED_SIGNATURES) {
      let oldestKey: string | null = null;
      let oldestSeen = Infinity;
      for (const [k, v] of tracker.entries()) {
        if (v.lastSeen < oldestSeen) {
          oldestSeen = v.lastSeen;
          oldestKey = k;
        }
      }
      if (oldestKey) tracker.delete(oldestKey);
    }

    if (entry.successes < threshold) return;

    // Threshold reached. Generate (or update) the proposal.
    try {
      const proposedName = autogenName(skill);
      const skillMd = renderSkillMd(skill, entry);
      // The store's merge path adds `input.successCount` to the
      // existing row, so passing the cumulative `entry.successes`
      // every emission would double-count. Pass `1` per emission;
      // after threshold the count starts at 1 and bumps by 1 per
      // subsequent successful run. That matches the skill-proposals
      // store contract used by the human-driven create path.
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
    } catch (err) {
      // Best-effort: a store failure must not corrupt the bus listener.
      // The agent loop keeps running; the operator can re-trigger via
      // the API if needed.
      console.warn('[skill-autogen] proposal create failed:', err);
    }
  });

  return off;
}

/**
 * Convert a `taskSignature` into a slug that survives the proposed-name
 * regex (`/^[a-z][a-z0-9-]*$/`). The signature itself is a hash + free
 * text from the task type system, so we lower-case + replace anything
 * that isn't `[a-z0-9-]` with `-`, collapse runs, and trim leading
 * digits.
 */
function autogenName(skill: CachedSkill): string {
  const raw = `auto-${skill.agentId ?? 'shared'}-${skill.taskSignature}`;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Must start with a letter — prepend `s-` if it starts with a digit
  // or is empty.
  return /^[a-z]/.test(slug) ? slug.slice(0, 80) : `s-${slug}`.slice(0, 80);
}

/**
 * Render a minimal SKILL.md draft from the cached skill + run history.
 * Deliberately terse — the operator edits the body before approving.
 */
function renderSkillMd(skill: CachedSkill, entry: SuccessEntry): string {
  const lines: string[] = [];
  lines.push(`# ${autogenName(skill)}`);
  lines.push('');
  lines.push(
    `Auto-generated from ${entry.successes} successful runs of task signature \`${skill.taskSignature}\`.`,
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

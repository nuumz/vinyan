/**
 * Task outcome recorder — Phase-4 wiring activation.
 *
 * At task completion the orchestrator knows:
 *   - which persona ran the task (`TaskInput.agentId`)
 *   - whether the task succeeded or failed (`TaskResult.status`)
 *   - which task family it belongs to (signature derived from `taskType`)
 *
 * The persona's loaded skills are recoverable from the registry, so the
 * recorder can fan ONE outcome out to every skill in the persona's loadout
 * via `recordSkillOutcomesFromBid`. This unblocks Phase-5 autonomous skill
 * promotion (Wilson LB on per-(persona, skill, taskSig) outcomes).
 *
 * Phase-15 (M2 closure): when callers pass `viewedSkillIds` (the set the
 * `SkillUsageTracker` accumulated from `skill_view` calls during execution),
 * only viewed-and-loaded skills are credited. Empty/undefined viewed set
 * preserves the legacy equal-credit behaviour — see WHY in
 * `recordSkillOutcomesFromBid`.
 */
import type { SkillOutcome, SkillOutcomeStore } from '../../db/skill-outcome-store.ts';
import { recordSkillOutcomesFromBid } from '../../db/skill-outcome-store.ts';
import type { TaskInput, TaskResult } from '../types.ts';
import type { AgentRegistry } from './registry.ts';

export interface TaskOutcomeRecord {
  /** Number of skills credited (equal-credit fan-out). 0 = no-op. */
  skillsRecorded: number;
  /** Resolved task signature used for attribution. */
  taskSignature: string;
  /** The outcome that was recorded ('success' or 'failure'). */
  outcome: SkillOutcome;
}

/**
 * Record one task outcome against every skill currently bound to the
 * persona that ran the task. Returns a summary; safe to call when no
 * persona is set or no skills are bound (no-op, returns count 0).
 *
 * Outcome derivation: `result.status === 'completed'` → `'success'`,
 * everything else (failed, escalated, uncertain, input-required) → `'failure'`.
 * The autonomous skill creator interprets this signal — partial successes
 * eventually demote skills that don't help.
 */
export function recordTaskOutcomeForPersona(
  input: TaskInput,
  result: TaskResult,
  registry: Pick<AgentRegistry, 'getDerivedCapabilities'>,
  store: SkillOutcomeStore,
  viewedSkillIds?: ReadonlySet<string>,
  now = Date.now(),
): TaskOutcomeRecord {
  const taskSignature = deriveTaskSignature(input);
  const outcome: SkillOutcome = result.status === 'completed' ? 'success' : 'failure';

  if (!input.agentId) {
    return { skillsRecorded: 0, taskSignature, outcome };
  }
  const derived = registry.getDerivedCapabilities(input.agentId);
  if (!derived) {
    return { skillsRecorded: 0, taskSignature, outcome };
  }

  const loadedSkillIds = derived.loadedSkills.map((s) => s.frontmatter.id);
  const skillsRecorded = recordSkillOutcomesFromBid(
    store,
    { personaId: input.agentId, loadedSkillIds },
    taskSignature,
    outcome,
    viewedSkillIds,
    now,
  );
  return { skillsRecorded, taskSignature, outcome };
}

/**
 * Hybrid skill redesign — record one task outcome for every Claude-Code-style
 * simple skill whose body was inlined into the task's prompt. Independent of
 * the heavy-stack `recordTaskOutcomeForPersona` so the simple layer can earn
 * its own outcome history without sharing the auction's bid structure.
 *
 * The Phase-5 bridge reads this same SkillOutcomeStore via `listForSkill` to
 * decide whether a simple skill has earned a heavy-schema graduation.
 *
 * Best-effort: per-skill failures are swallowed (A9). Returns the count of
 * rows successfully written.
 */
export function recordSimpleSkillOutcomes(
  input: TaskInput,
  result: TaskResult,
  invokedSimpleSkillNames: ReadonlySet<string>,
  store: SkillOutcomeStore,
  now = Date.now(),
): { recorded: number; taskSignature: string } {
  const taskSignature = deriveTaskSignature(input);
  if (!input.agentId || invokedSimpleSkillNames.size === 0) {
    return { recorded: 0, taskSignature };
  }
  const outcome: SkillOutcome = result.status === 'completed' ? 'success' : 'failure';
  let recorded = 0;
  for (const name of invokedSimpleSkillNames) {
    try {
      store.recordOutcome(
        { personaId: input.agentId, skillId: name, taskSignature },
        outcome,
        now,
      );
      recorded += 1;
    } catch {
      /* per-skill best-effort */
    }
  }
  return { recorded, taskSignature };
}

/**
 * Derive a task signature for outcome attribution. Stable across runs of
 * the same task family so the autonomous skill creator can aggregate.
 *
 *   - With `taskType` and an `actionVerb`-style hint in the goal: `${taskType}::${verb}`
 *   - With `taskType` only: `${taskType}`
 *   - Fallback: `'unknown'`
 *
 * The shape is intentionally coarse — fine-grained signatures (per-symbol,
 * per-file) inflate cardinality and starve Wilson-LB pools.
 */
export function deriveTaskSignature(input: TaskInput): string {
  const verb = extractFirstVerb(input.goal);
  if (input.taskType && verb) return `${input.taskType}::${verb}`;
  if (input.taskType) return input.taskType;
  return 'unknown';
}

/**
 * Extract the first action verb from a goal string for the task signature.
 * A small allowlist of common verbs mirrors `TaskFingerprint.actionVerb`
 * vocabulary so signatures align with the capability-router's match terms.
 */
function extractFirstVerb(goal: string | undefined): string | null {
  if (!goal) return null;
  const lower = goal.trim().toLowerCase();
  for (const verb of [
    'refactor',
    'fix',
    'add',
    'remove',
    'rename',
    'extract',
    'inline',
    'implement',
    'optimize',
    'review',
    'audit',
    'design',
    'write',
    'document',
    'translate',
    'summarize',
    'compare',
    'research',
  ]) {
    if (lower.startsWith(`${verb} `) || lower.startsWith(`${verb}:`) || lower === verb) {
      return verb;
    }
  }
  return null;
}

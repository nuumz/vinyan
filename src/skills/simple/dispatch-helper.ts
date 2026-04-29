/**
 * Shared dispatch-time helper for simple skills.
 *
 * Two consumers go through this helper so they cannot drift:
 *
 *   1. WorkerPool — the full-pipeline path. Matches at IPC boundary so the
 *      subprocess prompt sees the same [AVAILABLE SKILLS] / [ACTIVE SKILLS]
 *      blocks the in-process worker would render.
 *   2. ConversationalResultBuilder — the short-circuit path. Hand-builds its
 *      system prompt without `assemblePrompt`, so it appends the rendered
 *      blocks directly via `renderSimpleSkillSections`.
 *
 * Without this helper the conversational path quietly skipped simple skills
 * entirely (a `/code-review review this file` would never inject the skill
 * body), and worker-pool's resolution logic would be the only source of
 * truth — duplicating it inline in the conversational builder invites drift.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { SimpleSkill } from './loader.ts';
import {
  detectExplicitInvocation,
  matchSkillsForTask,
  type MatchOptions,
} from './matcher.ts';
import type { SimpleSkillRegistry } from './registry.ts';

export interface ResolveSimpleSkillsOptions {
  readonly registry: SimpleSkillRegistry | undefined;
  readonly goal: string;
  readonly agentId?: string;
  readonly matcherOpts?: MatchOptions;
  /** Bus + taskId emit `skill:simple_invoked` per inlined body. Pass empty taskId to suppress. */
  readonly bus?: VinyanBus;
  readonly taskId?: string;
}

export interface ResolvedSimpleSkills {
  readonly simpleSkills: readonly SimpleSkill[];
  readonly simpleSkillBodies: readonly SimpleSkill[];
}

/**
 * Resolve the visible skill snapshot + matched bodies for a task.
 * - When the registry is missing, returns empty arrays (no-op).
 * - Explicit `/<skill-name>` invocation always wins over similarity matching
 *   (matches the human-typed Claude Code convention).
 * - Matcher errors degrade to "no bodies inlined" — boot never fails because
 *   of a single broken skill (A9).
 */
export function resolveSimpleSkillsForDispatch(
  opts: ResolveSimpleSkillsOptions,
): ResolvedSimpleSkills {
  if (!opts.registry) return { simpleSkills: [], simpleSkillBodies: [] };
  const snapshot = opts.registry.getForAgent(opts.agentId);
  if (snapshot.length === 0) return { simpleSkills: [], simpleSkillBodies: [] };

  let bodies: readonly SimpleSkill[] = [];
  try {
    const explicit = detectExplicitInvocation(opts.goal, snapshot);
    if (explicit) {
      bodies = [explicit];
    } else {
      bodies = matchSkillsForTask(opts.goal, snapshot, opts.matcherOpts ?? {}).map(
        (m) => m.skill,
      );
    }
  } catch (err) {
    console.warn(`[skill:simple-match] matcher failed: ${(err as Error).message}`);
  }

  if (bodies.length > 0 && opts.bus && opts.taskId) {
    for (const skill of bodies) {
      try {
        opts.bus.emit('skill:simple_invoked', {
          taskId: opts.taskId,
          skillName: skill.name,
          scope: skill.scope,
          ...(skill.agentId ? { agentId: skill.agentId } : {}),
        });
      } catch {
        /* observational */
      }
    }
  }

  return { simpleSkills: snapshot, simpleSkillBodies: bodies };
}

/**
 * Render the [AVAILABLE SKILLS] / [ACTIVE SKILLS] blocks the same way the
 * prompt-section-registry does for the full-pipeline path. The conversational
 * builder calls this and appends the resulting strings to its hand-built
 * system prompt so a `/code-review` invocation works identically in both
 * dispatch paths.
 *
 * Returns `null` for any block that has no content so callers can skip
 * empty-section emission cleanly.
 */
export function renderSimpleSkillSections(
  skills: readonly SimpleSkill[],
  bodies: readonly SimpleSkill[],
): { available: string | null; active: string | null } {
  const available = skills.length === 0 ? null : renderAvailable(skills);
  const active = bodies.length === 0 ? null : renderActive(bodies);
  return { available, active };
}

function renderAvailable(skills: readonly SimpleSkill[]): string {
  const lines = ['[AVAILABLE SKILLS]'];
  lines.push(
    'These skills can be invoked when relevant. Bodies for matched skills follow if they apply to the current task.',
  );
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description || '(no description)'}`);
  }
  return lines.join('\n');
}

function renderActive(bodies: readonly SimpleSkill[]): string {
  const lines = ['[ACTIVE SKILLS]'];
  lines.push(
    "Bodies of skills matched to this task. Apply when the situation fits the skill's \"when to use\" guidance.",
  );
  for (const skill of bodies) {
    lines.push('');
    lines.push(`── ${skill.name} ──`);
    if (skill.description) lines.push(skill.description);
    lines.push('');
    lines.push(skill.body.trim());
  }
  return lines.join('\n');
}

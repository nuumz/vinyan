/**
 * Runtime skill hints — read-only execution context augmentation.
 *
 * A1: generation receives hints; verification/outcome feedback remains separate.
 * A3: selection, dedupe, ordering, and truncation are deterministic.
 */
import type { AgentMemoryAPI } from './agent-memory/agent-memory-api.ts';
import { computeTaskSignature } from './prediction/self-model.ts';
import type { CachedSkill, TaskInput } from './types.ts';

export interface SkillHintsConfig {
  enabled: boolean;
  topK: number;
}

export interface ResolveRuntimeSkillHintOptions {
  input: TaskInput;
  config?: SkillHintsConfig;
  agentMemory?: AgentMemoryAPI;
  matchedSkill?: CachedSkill | null;
}

export interface RuntimeSkillHintResolution {
  constraints: string[];
  skills: CachedSkill[];
}

/**
 * Format top-k CachedSkills as a constraint block the worker prompt assembler
 * renders under [USER CONSTRAINTS]. Each entry shows the proven approach +
 * success rate and stays bounded so verbose approaches cannot dominate a turn.
 */
export function formatSkillHintConstraints(skills: CachedSkill[]): string[] {
  if (skills.length === 0) return [];
  const out: string[] = [
    `[SKILL HINTS] ${skills.length} proven approach(es) for similar prior tasks (reference only, not mandates):`,
  ];
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i]!;
    const pct = Math.round((s.successRate ?? 0) * 100);
    const approach = s.approach.length > 200 ? `${s.approach.slice(0, 200)}…` : s.approach;
    out.push(`  ${i + 1}. ${approach} (success: ${pct}%, uses: ${s.usageCount ?? 0})`);
  }
  return out;
}

export async function resolveRuntimeSkillHintConstraints(
  options: ResolveRuntimeSkillHintOptions,
): Promise<RuntimeSkillHintResolution> {
  if (options.config?.enabled !== true) {
    return { constraints: [], skills: [] };
  }

  const skills: CachedSkill[] = [];
  if (options.matchedSkill) {
    skills.push(options.matchedSkill);
  }

  if (options.agentMemory) {
    try {
      const sig = computeTaskSignature(options.input);
      skills.push(...(await options.agentMemory.queryRelatedSkills(sig, { k: options.config.topK })));
    } catch {
      // Read-only memory failures must not block execution.
    }
  }

  const deduped = dedupeSkills(skills);
  return { constraints: formatSkillHintConstraints(deduped), skills: deduped };
}

function dedupeSkills(skills: readonly CachedSkill[]): CachedSkill[] {
  const seen = new Set<string>();
  const out: CachedSkill[] = [];
  for (const skill of skills) {
    if (seen.has(skill.taskSignature)) continue;
    seen.add(skill.taskSignature);
    out.push(skill);
  }
  return out;
}

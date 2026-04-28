/**
 * Persona-bound skill persistence — disk IO for `.vinyan/agents/<id>/skills.json`.
 *
 * Three skill scopes coexist on a persona:
 *   - **base** — declared in the persona TS file (`AgentSpec.baseSkills`),
 *     ships with Vinyan, never changes per workspace.
 *   - **bound** — workspace-scoped, persisted to disk by `vinyan skill bind`,
 *     survives restarts. This module owns that scope's IO.
 *   - **acquired** — task-scoped, runtime-only, cleaned up at task end. Phase 4.
 *
 * Design notes:
 *   - A9 Resilient Degradation: missing file → empty list (not an error). A
 *     malformed file emits a warning and degrades to empty list rather than
 *     crashing registry load.
 *   - A8 Traceable Accountability: every load/save is logged with persona id,
 *     skill count, and content snapshot via console.warn for now (event bus
 *     wiring is a follow-up).
 *   - The schema is versioned so we can evolve the file format with a clear
 *     upgrade path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';
import type { SkillRef } from '../types.ts';

const SkillRefSchema = z.object({
  id: z.string().min(1),
  pinnedVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional(),
  contentHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

const BoundSkillsFileSchema = z.object({
  version: z.literal(1),
  personaId: z.string().min(1),
  skills: z.array(SkillRefSchema).default([]),
});

export type BoundSkillsFile = z.infer<typeof BoundSkillsFileSchema>;

/**
 * Resolve the on-disk path for a persona's bound-skills manifest. The path
 * is `<workspace>/.vinyan/agents/<personaId>/skills.json`.
 */
export function boundSkillsPath(workspace: string, personaId: string): string {
  return join(workspace, '.vinyan', 'agents', personaId, 'skills.json');
}

/**
 * Load the bound skills for a persona. Returns an empty array when the file
 * is missing or malformed (A9 — never crashes registry load). Malformed
 * files emit a warning so the user sees the issue.
 */
export function loadBoundSkills(workspace: string, personaId: string): SkillRef[] {
  const path = boundSkillsPath(workspace, personaId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = BoundSkillsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      console.warn(`[skill:bound-load] '${personaId}' skills.json failed validation: ${parsed.error.message}`);
      return [];
    }
    if (parsed.data.personaId !== personaId) {
      console.warn(
        `[skill:bound-load] '${personaId}' skills.json declares personaId='${parsed.data.personaId}' (mismatch). Ignoring file.`,
      );
      return [];
    }
    return parsed.data.skills;
  } catch (err) {
    console.warn(`[skill:bound-load] '${personaId}' skills.json could not be read: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Persist the bound skill list for a persona. Creates parent directories as
 * needed. Writes a stable on-disk format with sorted skill ids so diffs are
 * minimal across binds/unbinds.
 */
export function saveBoundSkills(workspace: string, personaId: string, skills: SkillRef[]): void {
  const dir = join(workspace, '.vinyan', 'agents', personaId);
  mkdirSync(dir, { recursive: true });
  const file: BoundSkillsFile = {
    version: 1,
    personaId,
    skills: [...skills].sort((a, b) => a.id.localeCompare(b.id)),
  };
  writeFileSync(boundSkillsPath(workspace, personaId), `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
}

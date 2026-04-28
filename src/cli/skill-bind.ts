/**
 * `vinyan skill bind/unbind` CLI commands — Phase 2.
 *
 * Manages workspace-scoped skill bindings persisted to
 * `.vinyan/agents/<persona-id>/skills.json`. The registry reloads bindings on
 * every `getDerivedCapabilities` call so a bind takes effect for the next
 * routing decision without restarting the process.
 *
 * Validates:
 *   - persona exists in the registry (built-in or vinyan.json)
 *   - skill exists in the workspace artifact store
 *   - `--pin <version>` matches the artifact's frontmatter (refuses bind on mismatch)
 *
 * Does NOT (Phase 4 will add):
 *   - check the skill against the persona's `acquirableSkillTags` glob
 *   - verify ed25519 signature
 *   - import from hub on miss (`vinyan skills import` is a separate command)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoundSkills, saveBoundSkills } from '../orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../orchestrator/agents/registry.ts';
import type { SkillRef } from '../orchestrator/types.ts';
import { SkillArtifactStore } from '../skills/artifact-store.ts';

interface ParsedArgs {
  personaId: string;
  skillId: string;
  pinnedVersion?: string;
}

function parseArgs(argv: string[], commandName: 'bind' | 'unbind'): ParsedArgs {
  const positional: string[] = [];
  let pinnedVersion: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pin') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) throw new Error('Flag --pin requires a version (e.g. 1.2.0)');
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`--pin '${v}' is not a valid semver version`);
      pinnedVersion = v;
      i++;
      continue;
    }
    if (a !== undefined && a.startsWith('--pin=')) {
      const v = a.slice('--pin='.length);
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`--pin '${v}' is not a valid semver version`);
      pinnedVersion = v;
      continue;
    }
    if (a !== undefined && !a.startsWith('-')) positional.push(a);
  }
  if (positional.length < 2) {
    throw new Error(
      `Usage: vinyan skill ${commandName} <persona-id> <skill-id>${commandName === 'bind' ? ' [--pin <version>]' : ''}`,
    );
  }
  return { personaId: positional[0]!, skillId: positional[1]!, pinnedVersion };
}

/**
 * Bind a skill to a persona at workspace scope.
 *
 * Idempotent: re-binding an existing skill replaces its pin (or removes the
 * pin when called without `--pin`).
 */
export async function runSkillBindCommand(argv: string[], workspace: string): Promise<void> {
  const { personaId, skillId, pinnedVersion } = parseArgs(argv, 'bind');

  // Validate persona
  const registry = loadAgentRegistry(workspace, undefined);
  if (!registry.has(personaId)) {
    console.error(`Unknown persona '${personaId}'. Run 'vinyan agent list' to see available personas.`);
    process.exit(1);
  }

  // Validate skill artifact exists in workspace store
  const skillsRoot = join(workspace, '.vinyan', 'skills');
  if (!existsSync(skillsRoot)) {
    console.error(`No skills directory at ${skillsRoot}. Import a skill first with 'vinyan skills import <id>'.`);
    process.exit(1);
  }
  const store = new SkillArtifactStore({ rootDir: skillsRoot });
  let frontmatterVersion: string;
  let frontmatterHash: string | undefined;
  try {
    const record = await store.read(skillId);
    frontmatterVersion = record.frontmatter.version;
    frontmatterHash = record.frontmatter.content_hash;
  } catch (err) {
    console.error(`Skill '${skillId}' not found in ${skillsRoot}: ${(err as Error).message}`);
    process.exit(1);
    return; // unreachable, but narrows types
  }

  if (pinnedVersion && pinnedVersion !== frontmatterVersion) {
    console.error(
      `--pin ${pinnedVersion} does not match the on-disk skill version ${frontmatterVersion}. Bind aborted.`,
    );
    process.exit(1);
  }

  // Merge with existing bindings (replace by id)
  const existing = loadBoundSkills(workspace, personaId);
  const filtered = existing.filter((r) => r.id !== skillId);
  const next: SkillRef = { id: skillId };
  if (pinnedVersion) next.pinnedVersion = pinnedVersion;
  if (pinnedVersion && frontmatterHash) next.contentHash = frontmatterHash;
  filtered.push(next);
  saveBoundSkills(workspace, personaId, filtered);

  console.log(
    `Bound '${skillId}' (${frontmatterVersion}${pinnedVersion ? ', pinned' : ''}) to '${personaId}'. Stored at .vinyan/agents/${personaId}/skills.json`,
  );
}

/**
 * Remove a skill binding from a persona. Idempotent: silently no-op when the
 * binding is absent so scripts can `unbind` defensively without checking.
 */
export async function runSkillUnbindCommand(argv: string[], workspace: string): Promise<void> {
  const { personaId, skillId } = parseArgs(argv, 'unbind');

  const registry = loadAgentRegistry(workspace, undefined);
  if (!registry.has(personaId)) {
    console.error(`Unknown persona '${personaId}'. Run 'vinyan agent list' to see available personas.`);
    process.exit(1);
  }

  const existing = loadBoundSkills(workspace, personaId);
  const filtered = existing.filter((r) => r.id !== skillId);
  if (filtered.length === existing.length) {
    console.log(`No binding for '${skillId}' on '${personaId}'. Nothing to do.`);
    return;
  }
  saveBoundSkills(workspace, personaId, filtered);
  console.log(`Unbound '${skillId}' from '${personaId}'.`);
}

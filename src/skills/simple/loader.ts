/**
 * Simple skill loader — Claude-Code-compatible SKILL.md format.
 *
 * The hybrid skill redesign keeps the heavy `src/skills/skill-md/` schema
 * (Zod-validated, content-hashed, ACL-composing, tier-laddered) for the
 * epistemic stack. The simple layer ships a strictly-flat alternative format
 * that matches Claude Code's `~/.claude/skills/<name>/SKILL.md` convention:
 *
 *     ---
 *     name: code-review
 *     description: Review code for bugs and style. Use when reviewing PRs.
 *     ---
 *
 *     When reviewing code:
 *     1. Check null derefs and error handling
 *     2. ...
 *
 * Four scopes are supported (most-specific wins on name conflict):
 *
 *   1. project-agent — `<workspace>/.vinyan/agents/<agent-id>/skills/<name>/SKILL.md`
 *   2. project       — `<workspace>/.vinyan/skills/<name>/SKILL.md`
 *   3. user-agent    — `~/.vinyan/agents/<agent-id>/skills/<name>/SKILL.md`
 *   4. user          — `~/.vinyan/skills/<name>/SKILL.md`
 *
 * Per-agent scopes are isolated: a skill at `~/.vinyan/agents/developer/skills/X`
 * is visible to the `developer` persona only — never to `reviewer` or any other
 * persona. Loaders that don't supply an `agentId` return ONLY the shared
 * scopes (user + project) for backward compatibility.
 *
 * Description cap: 1,536 chars (Claude Code's listing cap). Longer descriptions
 * are truncated with a warning so the operator sees the issue rather than
 * silently bloating the system prompt.
 *
 * No Zod, no schema enforcement, no required fields beyond `name`. The format
 * is intentionally opinion-light — drop a markdown file, it works.
 *
 * A9 (resilient degradation): missing scope dirs, malformed frontmatter, and
 * IO errors all degrade to "skill skipped" with a structured warning. Boot
 * never fails because of a broken simple skill.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DESCRIPTION_CHAR_CAP = 1536;

export type SimpleSkillScope = 'user' | 'project' | 'user-agent' | 'project-agent';

export interface SimpleSkill {
  /** Filesystem-derived id (the `<name>` directory). Frontmatter `name` overrides if present. */
  readonly name: string;
  /** Description — capped at DESCRIPTION_CHAR_CAP chars (truncated with `…` suffix on overflow). */
  readonly description: string;
  /** Markdown body verbatim (everything after the frontmatter block). */
  readonly body: string;
  /** Where this skill came from. */
  readonly scope: SimpleSkillScope;
  /**
   * Agent id this skill is bound to. Only set when `scope === 'user-agent'`
   * or `'project-agent'`. Shared-scope skills (user/project) leave this
   * undefined so consumers know they're not persona-restricted.
   */
  readonly agentId?: string;
  /** Absolute path to the SKILL.md file. */
  readonly path: string;
}

export interface LoadSimpleSkillsOptions {
  /** Override `~/.vinyan/skills/` location (mainly for tests). */
  readonly userSkillsDir?: string;
  /** Workspace path. Project skills live under `<workspace>/.vinyan/skills/`. */
  readonly workspace: string;
  /** Override `<workspace>/.vinyan/skills/` location (mainly for tests). */
  readonly projectSkillsDir?: string;
  /**
   * Override `~/.vinyan/agents/` location for per-agent user-scope skills.
   * Mainly for tests. Per-agent skills are loaded for every agent id found
   * under this dir at scan time; visibility filtering happens at access time
   * via `SimpleSkillRegistry.getForAgent(agentId)`.
   */
  readonly userAgentsDir?: string;
  /** Override `<workspace>/.vinyan/agents/` for project-scoped per-agent skills. */
  readonly projectAgentsDir?: string;
}

export interface LoadSimpleSkillsResult {
  readonly skills: readonly SimpleSkill[];
  /** Skill names that failed to parse (logged but non-fatal). */
  readonly failedNames: readonly string[];
}

/**
 * Load all simple skills from every scope. Returns the FULL union without
 * agent-visibility filtering — callers (registry / CLI) filter at access
 * time so a single watcher can serve all agents.
 *
 * Same-name conflict precedence: project-agent (for the same agent id) >
 * project-shared > user-agent (same agent id) > user-shared. Cross-agent
 * conflicts are NOT collapsed — each agent's per-agent skill is a distinct
 * record, separated by `agentId`.
 */
export function loadSimpleSkills(opts: LoadSimpleSkillsOptions): LoadSimpleSkillsResult {
  const failed: string[] = [];
  const userDir = opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
  const projectDir = opts.projectSkillsDir ?? join(opts.workspace, '.vinyan', 'skills');
  const userAgentsDir = opts.userAgentsDir ?? join(homedir(), '.vinyan', 'agents');
  const projectAgentsDir = opts.projectAgentsDir ?? join(opts.workspace, '.vinyan', 'agents');

  // Shared-scope: keyed by name.
  const sharedByName = new Map<string, SimpleSkill>();
  for (const skill of scanScope(userDir, 'user', failed)) {
    sharedByName.set(skill.name, skill);
  }
  for (const skill of scanScope(projectDir, 'project', failed)) {
    sharedByName.set(skill.name, skill);
  }

  // Per-agent scopes: keyed by `<agentId>::<name>` so different agents can
  // own a skill of the same name without colliding.
  const agentByKey = new Map<string, SimpleSkill>();
  for (const skill of scanAgentRoot(userAgentsDir, 'user-agent', failed)) {
    agentByKey.set(`${skill.agentId}::${skill.name}`, skill);
  }
  for (const skill of scanAgentRoot(projectAgentsDir, 'project-agent', failed)) {
    agentByKey.set(`${skill.agentId}::${skill.name}`, skill);
  }

  const skills = [...sharedByName.values(), ...agentByKey.values()].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    // Stable ordering for tests: shared first, then by scope rank, then by agent id.
    return scopeRank(a.scope) - scopeRank(b.scope) || (a.agentId ?? '').localeCompare(b.agentId ?? '');
  });
  return { skills, failedNames: failed };
}

/**
 * Precedence rank for same-name conflicts (higher wins).
 *
 * Design: `project-agent > project > user-agent > user`. Project-scope shared
 * wins over a user-scope per-agent variant — operators editing the project's
 * shared SKILL.md expect their change to take effect for everyone, including
 * agents who happen to have a user-global per-agent variant of the same name.
 */
function scopeRank(scope: SimpleSkillScope): number {
  switch (scope) {
    case 'user':
      return 0;
    case 'user-agent':
      return 1;
    case 'project':
      return 2;
    case 'project-agent':
      return 3;
  }
}

/**
 * Scan an "agents root" directory — `<root>/<agent-id>/skills/<name>/SKILL.md`.
 * Each subdir under `agentsRoot` is treated as a candidate `agentId`; missing
 * `skills/` subdirectory is silently skipped.
 */
function scanAgentRoot(
  agentsRoot: string,
  scope: 'user-agent' | 'project-agent',
  failed: string[],
): SimpleSkill[] {
  if (!existsSync(agentsRoot)) return [];
  let agentEntries: string[];
  try {
    agentEntries = readdirSync(agentsRoot);
  } catch (err) {
    console.warn(
      `[skill:simple-loader] cannot read ${agentsRoot} (${scope}): ${(err as Error).message}`,
    );
    return [];
  }

  const out: SimpleSkill[] = [];
  for (const agentId of agentEntries) {
    const skillsDir = join(agentsRoot, agentId, 'skills');
    if (!safeIsDir(skillsDir)) continue;
    for (const skill of scanScope(skillsDir, scope, failed, agentId)) {
      out.push(skill);
    }
  }
  return out;
}

function scanScope(
  rootDir: string,
  scope: SimpleSkillScope,
  failed: string[],
  agentId?: string,
): SimpleSkill[] {
  if (!existsSync(rootDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch (err) {
    console.warn(
      `[skill:simple-loader] cannot read ${rootDir} (${scope}): ${(err as Error).message}`,
    );
    return [];
  }

  const skills: SimpleSkill[] = [];
  for (const entry of entries) {
    const directPath = join(rootDir, entry, 'SKILL.md');
    const namespaceDir = join(rootDir, entry);
    if (!safeIsDir(namespaceDir)) continue;

    // Skip the "local/" namespace used by SkillArtifactStore — those are
    // heavy-schema skills owned by the epistemic stack. Only skip at SHARED
    // scopes where the artifact store coexists; at per-agent scopes the
    // user is free to use the name.
    if ((scope === 'user' || scope === 'project') && entry === 'local') continue;

    if (existsSync(directPath)) {
      const skill = tryLoad(directPath, entry, scope, failed, agentId);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

function tryLoad(
  filePath: string,
  dirName: string,
  scope: SimpleSkillScope,
  failed: string[],
  agentId?: string,
): SimpleSkill | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[skill:simple-loader] cannot read ${filePath}: ${(err as Error).message}`);
    failed.push(dirName);
    return null;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    console.warn(`[skill:simple-loader] '${dirName}' missing or malformed frontmatter at ${filePath}`);
    failed.push(dirName);
    return null;
  }
  const name = parsed.frontmatter.name?.trim() || dirName;
  if (!name) {
    failed.push(dirName);
    return null;
  }
  const rawDescription = parsed.frontmatter.description?.trim() ?? '';
  const description = capDescription(rawDescription, name);
  return {
    name,
    description,
    body: parsed.body,
    scope,
    ...(agentId ? { agentId } : {}),
    path: filePath,
  };
}

/**
 * Filter the FULL skill list down to those visible to a specific agent —
 * shared-scope skills + that agent's per-agent skills. Used by the dispatch
 * path so each persona sees only their own + global skills.
 *
 * Same-name precedence within the visible set:
 *   project-agent (for THIS agent) > project (shared)
 *     > user-agent (for THIS agent) > user (shared)
 *
 * Cross-agent skills (other agents' per-agent dirs) are filtered OUT.
 */
export function filterSkillsForAgent(
  skills: readonly SimpleSkill[],
  agentId: string | undefined,
): readonly SimpleSkill[] {
  if (!agentId) {
    // No agent context → only shared skills are visible.
    return skills.filter((s) => s.scope === 'user' || s.scope === 'project');
  }
  // Step 1: keep shared + this agent's per-agent skills only.
  const visible = skills.filter(
    (s) =>
      s.scope === 'user' ||
      s.scope === 'project' ||
      ((s.scope === 'user-agent' || s.scope === 'project-agent') && s.agentId === agentId),
  );
  // Step 2: collapse same-name conflicts using precedence.
  const byName = new Map<string, SimpleSkill>();
  for (const skill of visible) {
    const existing = byName.get(skill.name);
    if (!existing || scopeRank(skill.scope) > scopeRank(existing.scope)) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function capDescription(raw: string, name: string): string {
  if (raw.length <= DESCRIPTION_CHAR_CAP) return raw;
  console.warn(
    `[skill:simple-loader] '${name}' description exceeds ${DESCRIPTION_CHAR_CAP} chars (got ${raw.length}); truncating. Long context belongs in the body.`,
  );
  return `${raw.slice(0, DESCRIPTION_CHAR_CAP - 1)}…`;
}

interface ParsedSkillFile {
  readonly frontmatter: Record<string, string | undefined>;
  readonly body: string;
}

/**
 * Minimal YAML-ish frontmatter parser. Supports `key: value` lines only —
 * no nested structures, no arrays. Anything past the closing `---` is the body.
 *
 * Why not pull in `yaml`? The simple-skill format is narrow (name +
 * description + free-form body). A 30-line regex parser is more robust to
 * imperfect user input than a strict YAML parser would be — Claude Code's
 * users routinely write malformed YAML and Anthropic forgives it.
 */
export function parseFrontmatter(text: string): ParsedSkillFile | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const [, headerBlock, body] = match;
  const frontmatter: Record<string, string | undefined> = {};
  for (const rawLine of headerBlock!.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: body!.trimStart() };
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

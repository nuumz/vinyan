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
 * Two scopes are supported:
 *   1. User-global  — `~/.vinyan/skills/<name>/SKILL.md`
 *   2. Project      — `<workspace>/.vinyan/skills/<name>/SKILL.md`
 *
 * Project scope wins on name conflict (mirrors Claude Code precedence).
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

export type SimpleSkillScope = 'user' | 'project';

export interface SimpleSkill {
  /** Filesystem-derived id (the `<name>` directory). Frontmatter `name` overrides if present. */
  readonly name: string;
  /** Description — capped at DESCRIPTION_CHAR_CAP chars (truncated with `…` suffix on overflow). */
  readonly description: string;
  /** Markdown body verbatim (everything after the frontmatter block). */
  readonly body: string;
  /** Where this skill came from. */
  readonly scope: SimpleSkillScope;
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
}

export interface LoadSimpleSkillsResult {
  readonly skills: readonly SimpleSkill[];
  /** Skill names that failed to parse (logged but non-fatal). */
  readonly failedNames: readonly string[];
}

/**
 * Load all simple skills from both scopes. Project wins on name conflict.
 */
export function loadSimpleSkills(opts: LoadSimpleSkillsOptions): LoadSimpleSkillsResult {
  const failed: string[] = [];
  const userDir = opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
  const projectDir = opts.projectSkillsDir ?? join(opts.workspace, '.vinyan', 'skills');

  const byName = new Map<string, SimpleSkill>();
  // Load user-global first; project entries overwrite.
  for (const skill of scanScope(userDir, 'user', failed)) {
    byName.set(skill.name, skill);
  }
  for (const skill of scanScope(projectDir, 'project', failed)) {
    byName.set(skill.name, skill);
  }

  // Stable order: name asc.
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, failedNames: failed };
}

function scanScope(rootDir: string, scope: SimpleSkillScope, failed: string[]): SimpleSkill[] {
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
    // Allow either a directory (`<name>/SKILL.md`) — Claude Code convention —
    // or a flat file (`<name>.md`). Skip the heavy-schema layout (`local/<id>/SKILL.md`)
    // so the simple loader doesn't double-claim epistemic-stack skills.
    const directPath = join(rootDir, entry, 'SKILL.md');
    const namespaceDir = join(rootDir, entry);
    if (!safeIsDir(namespaceDir)) continue;

    // Skip the "local/" namespace used by SkillArtifactStore — those are
    // heavy-schema skills owned by the epistemic stack.
    if (entry === 'local') continue;

    if (existsSync(directPath)) {
      const skill = tryLoad(directPath, entry, scope, failed);
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
    path: filePath,
  };
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

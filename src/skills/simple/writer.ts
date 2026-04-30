/**
 * Simple SKILL.md writer — creates / updates / deletes user-authored simple
 * skills under the four scopes supported by the loader. Used by the unified
 * `/api/v1/skills` CRUD surface so the UI can manage skills without hand-
 * editing files.
 *
 * The schema mirrors `parseFrontmatter` in `loader.ts`:
 *
 *     ---
 *     name: <slug>
 *     description: <one-liner>
 *     ---
 *
 *     <markdown body...>
 *
 * Layout per scope:
 *   user           → `<userSkillsDir>/<name>/SKILL.md`
 *   project        → `<workspace>/.vinyan/skills/<name>/SKILL.md`
 *   user-agent     → `<userAgentsDir>/<agentId>/skills/<name>/SKILL.md`
 *   project-agent  → `<workspace>/.vinyan/agents/<agentId>/skills/<name>/SKILL.md`
 *
 * Security:
 *   - `name` and `agentId` must match a strict slug regex; rejects `..`, path
 *     separators, leading dots, and anything that would escape the scope dir.
 *   - Resolved paths are checked against the scope root with `isPathInside`
 *     before any IO (defense in depth).
 *
 * Atomicity:
 *   - Write goes to a temp sibling and renames into place (same pattern as
 *     `SkillArtifactStore.write`).
 *
 * Description cap: enforced by the loader at read time. Caller is responsible
 * for trimming long inputs before calling write.
 */
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SimpleSkillScope } from './loader.ts';

export class SimpleSkillNameError extends Error {
  constructor(name: string) {
    super(`Invalid simple-skill name '${name}' — must match /^[a-z][a-z0-9-]*$/`);
    this.name = 'SimpleSkillNameError';
  }
}

export class SimpleSkillAgentIdError extends Error {
  constructor(agentId: string) {
    super(`Invalid agent id '${agentId}' — must match /^[a-z][a-z0-9-]*$/`);
    this.name = 'SimpleSkillAgentIdError';
  }
}

export class SimpleSkillPathTraversalError extends Error {
  constructor(p: string) {
    super(`Path traversal rejected: '${p}'`);
    this.name = 'SimpleSkillPathTraversalError';
  }
}

export class SimpleSkillNotFoundError extends Error {
  constructor(skillId: string) {
    super(`Simple skill '${skillId}' not found`);
    this.name = 'SimpleSkillNotFoundError';
  }
}

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export interface SimpleSkillWriteOptions {
  /** Override `~/.vinyan/skills/` root (mainly for tests). */
  readonly userSkillsDir?: string;
  /** Workspace root — `<workspace>/.vinyan/skills/` is the project-scope base. */
  readonly workspace: string;
  /** Override `<workspace>/.vinyan/skills/` (mainly for tests). */
  readonly projectSkillsDir?: string;
  /** Override `~/.vinyan/agents/` (per-agent user-scope skills). */
  readonly userAgentsDir?: string;
  /** Override `<workspace>/.vinyan/agents/` (per-agent project-scope skills). */
  readonly projectAgentsDir?: string;
}

export interface SimpleSkillWriteInput {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly scope: SimpleSkillScope;
  readonly agentId?: string;
}

/**
 * Resolve the absolute SKILL.md path for `(scope, name, agentId?)`. Throws
 * if any input fails the slug check or if the resolved path escapes the
 * scope root after symlink/`..` resolution.
 */
export function resolveSimpleSkillPath(
  input: { scope: SimpleSkillScope; name: string; agentId?: string },
  opts: SimpleSkillWriteOptions,
): string {
  if (!SLUG_RE.test(input.name)) throw new SimpleSkillNameError(input.name);
  if ((input.scope === 'user-agent' || input.scope === 'project-agent') && !input.agentId) {
    throw new SimpleSkillAgentIdError('(missing)');
  }
  if (input.agentId !== undefined && !SLUG_RE.test(input.agentId)) {
    throw new SimpleSkillAgentIdError(input.agentId);
  }

  const userDir = opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
  const projectDir = opts.projectSkillsDir ?? join(opts.workspace, '.vinyan', 'skills');
  const userAgentsDir = opts.userAgentsDir ?? join(homedir(), '.vinyan', 'agents');
  const projectAgentsDir = opts.projectAgentsDir ?? join(opts.workspace, '.vinyan', 'agents');

  let scopeRoot: string;
  let absDir: string;
  switch (input.scope) {
    case 'user':
      scopeRoot = resolve(userDir);
      absDir = resolve(scopeRoot, input.name);
      break;
    case 'project':
      scopeRoot = resolve(projectDir);
      absDir = resolve(scopeRoot, input.name);
      break;
    case 'user-agent':
      scopeRoot = resolve(userAgentsDir);
      absDir = resolve(scopeRoot, input.agentId!, 'skills', input.name);
      break;
    case 'project-agent':
      scopeRoot = resolve(projectAgentsDir);
      absDir = resolve(scopeRoot, input.agentId!, 'skills', input.name);
      break;
  }

  if (!isPathInside(absDir, scopeRoot)) {
    throw new SimpleSkillPathTraversalError(input.name);
  }
  return join(absDir, 'SKILL.md');
}

/**
 * Atomically create or overwrite a simple skill. Creates parent dirs as
 * needed. Caller-supplied `body` is written verbatim — no markdown
 * normalization, so user formatting is preserved.
 */
export async function writeSimpleSkill(
  input: SimpleSkillWriteInput,
  opts: SimpleSkillWriteOptions,
): Promise<{ path: string }> {
  const fullPath = resolveSimpleSkillPath(input, opts);
  const targetDir = resolve(fullPath, '..');
  await mkdir(targetDir, { recursive: true });

  const text = serialize(input);
  const tempPath = `${fullPath}.${randomSuffix()}.tmp`;
  await writeFile(tempPath, text, 'utf-8');
  await rename(tempPath, fullPath);
  return { path: fullPath };
}

/**
 * Delete a simple skill — removes the entire `<name>/` (or `<agent>/skills/<name>/`)
 * directory recursively. Ignores non-existent paths so `DELETE` is idempotent.
 */
export async function deleteSimpleSkill(
  input: { scope: SimpleSkillScope; name: string; agentId?: string },
  opts: SimpleSkillWriteOptions,
): Promise<void> {
  const fullPath = resolveSimpleSkillPath(input, opts);
  const targetDir = resolve(fullPath, '..');
  try {
    const st = await stat(targetDir);
    if (!st.isDirectory()) return;
  } catch {
    return; // not present → idempotent success
  }
  await rm(targetDir, { recursive: true, force: true });
}

function serialize(input: SimpleSkillWriteInput): string {
  const desc = input.description.includes('\n')
    ? input.description.replace(/\r?\n/g, ' ').trim()
    : input.description.trim();
  const body = input.body.replace(/^\s+/, '');
  return `---\nname: ${input.name}\ndescription: ${desc}\n---\n\n${body}\n`;
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  if (rel === '') return true;
  return !rel.split(sep).includes('..');
}

function randomSuffix(): string {
  return `${process.hrtime.bigint().toString(36)}-${Math.floor(Math.random() * 1e8).toString(36)}`;
}

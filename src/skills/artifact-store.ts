/**
 * SkillArtifactStore — read/write SKILL.md files on disk.
 *
 * Layout:
 *     <rootDir>/
 *       <namespace>/<skillId>/SKILL.md
 *       <namespace>/<skillId>/files/<relative-path>
 *
 * Skill IDs that embed a namespace separator (`refactor/extract-method-ts`)
 * live under their namespace directory. Flat ids (`extract-method-ts`) fall
 * under the `local/` namespace. The layout mirrors the agentskills.io hub
 * convention so the same directory is trivially publishable.
 *
 * Security:
 *   - `readFile` ONLY serves paths whitelisted in the SKILL.md's `## Files`
 *     section (throws `SkillFileNotWhitelistedError` otherwise). This is a
 *     rule-based check — no LLM involved (A3).
 *   - Path-traversal attempts (`..`, absolute paths, paths that escape the
 *     skill directory once resolved) are rejected with a `SkillPathTraversalError`.
 *
 * Atomicity:
 *   - `write` serializes the record via `writeSkillMd`, writes to a
 *     temporary sibling, then renames into place.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { SkillMdRecord } from './skill-md/index.ts';
import { parseSkillMd, writeSkillMd } from './skill-md/index.ts';

export interface SkillArtifactStoreOptions {
  readonly rootDir: string;
}

export class SkillFileNotWhitelistedError extends Error {
  constructor(skillId: string, relativePath: string) {
    super(`Skill '${skillId}' does not whitelist file '${relativePath}' in its '## Files' section`);
    this.name = 'SkillFileNotWhitelistedError';
  }
}

export class SkillPathTraversalError extends Error {
  constructor(relativePath: string) {
    super(`Path traversal rejected: '${relativePath}'`);
    this.name = 'SkillPathTraversalError';
  }
}

export class SkillArtifactNotFoundError extends Error {
  constructor(skillId: string) {
    super(`SKILL.md for '${skillId}' not found`);
    this.name = 'SkillArtifactNotFoundError';
  }
}

export class SkillArtifactStore {
  private readonly rootDir: string;

  constructor(opts: SkillArtifactStoreOptions) {
    this.rootDir = resolve(opts.rootDir);
  }

  /** Return the absolute directory that holds this skill's SKILL.md and files/. */
  private dirFor(skillId: string): string {
    const slashIdx = skillId.indexOf('/');
    if (slashIdx >= 0) {
      const namespace = skillId.slice(0, slashIdx);
      const leaf = skillId.slice(slashIdx + 1);
      if (!namespace || !leaf) {
        throw new Error(`Invalid skill id '${skillId}'`);
      }
      return join(this.rootDir, namespace, leaf);
    }
    return join(this.rootDir, 'local', skillId);
  }

  /** Absolute path to the SKILL.md artifact for the given id. */
  pathFor(skillId: string): string {
    return join(this.dirFor(skillId), 'SKILL.md');
  }

  /** Enumerate every SKILL.md under the root (non-recursive beyond namespace/leaf). */
  async list(): Promise<readonly { id: string; absolutePath: string }[]> {
    if (!existsSync(this.rootDir)) return [];
    const out: Array<{ id: string; absolutePath: string }> = [];
    for (const namespace of readdirSync(this.rootDir)) {
      const nsDir = join(this.rootDir, namespace);
      if (!safeIsDir(nsDir)) continue;
      for (const leaf of readdirSync(nsDir)) {
        const leafDir = join(nsDir, leaf);
        if (!safeIsDir(leafDir)) continue;
        const skillMdPath = join(leafDir, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;
        const id = namespace === 'local' ? leaf : `${namespace}/${leaf}`;
        out.push({ id, absolutePath: skillMdPath });
      }
    }
    return out;
  }

  /** Parse the SKILL.md for `skillId`. */
  async read(skillId: string): Promise<SkillMdRecord> {
    const path = this.pathFor(skillId);
    if (!existsSync(path)) {
      throw new SkillArtifactNotFoundError(skillId);
    }
    const text = readFileSync(path, 'utf-8');
    return parseSkillMd(text);
  }

  /**
   * Read a whitelisted companion file. The path must:
   *   1. Not be absolute.
   *   2. Not contain `..` segments.
   *   3. Resolve to within the skill's own directory.
   *   4. Appear in the SKILL.md's `body.files` whitelist.
   */
  async readFile(skillId: string, relativePath: string): Promise<{ content: string; bytes: number }> {
    assertSafeRelativePath(relativePath);

    const record = await this.read(skillId);
    const allowList = record.body.files ?? [];
    if (!allowList.includes(relativePath)) {
      throw new SkillFileNotWhitelistedError(skillId, relativePath);
    }

    const skillDir = this.dirFor(skillId);
    const filesDir = join(skillDir, 'files');
    const resolved = resolve(filesDir, relativePath);
    if (!isPathInside(resolved, filesDir)) {
      throw new SkillPathTraversalError(relativePath);
    }
    if (!existsSync(resolved)) {
      throw new Error(`Whitelisted file '${relativePath}' does not exist on disk for skill '${skillId}'`);
    }
    const content = readFileSync(resolved, 'utf-8');
    return { content, bytes: Buffer.byteLength(content, 'utf-8') };
  }

  /** Persist a record (and optional companion files) atomically. */
  async write(record: SkillMdRecord, files?: ReadonlyMap<string, string>): Promise<void> {
    const skillId = record.frontmatter.id;
    const skillDir = this.dirFor(skillId);
    await mkdir(skillDir, { recursive: true });

    const canonicalText = writeSkillMd(record);
    const skillMdPath = join(skillDir, 'SKILL.md');
    const tempPath = `${skillMdPath}.${randomSuffix()}.tmp`;
    await writeFile(tempPath, canonicalText, 'utf-8');
    await rename(tempPath, skillMdPath);

    if (files && files.size > 0) {
      const filesDir = join(skillDir, 'files');
      await mkdir(filesDir, { recursive: true });
      for (const [relativePath, content] of files) {
        assertSafeRelativePath(relativePath);
        const target = resolve(filesDir, relativePath);
        if (!isPathInside(target, filesDir)) {
          throw new SkillPathTraversalError(relativePath);
        }
        await mkdir(resolve(target, '..'), { recursive: true });
        const tempFile = `${target}.${randomSuffix()}.tmp`;
        await writeFile(tempFile, content, 'utf-8');
        await rename(tempFile, target);
      }
    }
  }
}

// ── internal helpers ─────────────────────────────────────────────────

function assertSafeRelativePath(relativePath: string): void {
  if (relativePath.length === 0) {
    throw new SkillPathTraversalError(relativePath);
  }
  if (isAbsolute(relativePath)) {
    throw new SkillPathTraversalError(relativePath);
  }
  // Windows-ish drive prefix.
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) {
    throw new SkillPathTraversalError(relativePath);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((s) => s === '..' || s === '')) {
    throw new SkillPathTraversalError(relativePath);
  }
}

function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  // Empty string means child === parent; treat as inside (the files/ dir itself).
  if (rel === '') return true;
  return !rel.split(sep).includes('..');
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function randomSuffix(): string {
  return createHash('sha256')
    .update(String(process.hrtime.bigint()) + Math.random())
    .digest('hex')
    .slice(0, 8);
}

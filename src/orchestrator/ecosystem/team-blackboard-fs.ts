/**
 * TeamBlackboardFs — filesystem-backed team blackboard.
 *
 * One markdown file per (teamId, key). Layout:
 *
 *   .vinyan/teams/{sanitized_teamId}/{sanitized_key}.md
 *
 * File format — YAML frontmatter + JSON-encoded body:
 *
 *   ---
 *   key: shared:outline
 *   version: 7
 *   author: room:abc123
 *   updatedAt: 2026-04-18T10:30:00Z
 *   ---
 *   <JSON-encoded value>
 *
 * Design choices (see docs/plans/sqlite-joyful-lynx.md §Phase 2):
 *
 *  - **Sync IO.** Keeps the existing TeamManager API sync and avoids an
 *    await-ripple across 30+ call sites. Vinyan is a single-process
 *    orchestrator; cross-process locking is out of scope.
 *  - **Atomic rename.** Writes land in `{file}.tmp.{pid}.{nonce}` and are
 *    `fs.renameSync`-ed into place. POSIX rename is atomic — readers see
 *    either the old content or the new content, never a torn write.
 *  - **CAS retry.** Before writing, we re-read the current on-disk
 *    version; if it differs from the caller's baseline, the write
 *    aborts (caller's responsibility to re-read and retry). In-process
 *    writes serialize naturally through JS's single-threaded event loop,
 *    so retry is only needed against external edits.
 *  - **Sanitization.** `/` → `__`; reject chars outside `[A-Za-z0-9_\-:.]`.
 *    Keys longer than 200 bytes after sanitization are hash-truncated;
 *    the original key is preserved in frontmatter.
 *
 * Source of truth for authored content: this file + filesystem.
 * The SQLite `team_blackboard` table is kept as a mirror during Phase 2
 * and removed in Phase 4.
 */

import { createHash, randomBytes } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

// ── Types ────────────────────────────────────────────────────────────

export interface FsBlackboardEntry {
  readonly teamId: string;
  readonly key: string;
  readonly version: number;
  readonly value: unknown;
  readonly authorId: string;
  readonly updatedAt: number;
  /** Absolute path the entry was read from. */
  readonly path: string;
}

export interface WriteParams {
  readonly teamId: string;
  readonly key: string;
  readonly value: unknown;
  readonly authorId: string;
  readonly updatedAt: number;
}

export interface TeamBlackboardFsConfig {
  /** Workspace root. The blackboard directory is `<root>/.vinyan/teams/`. */
  readonly root: string;
  /**
   * Optional clock injection for deterministic tests. Production uses
   * `Date.now` via `updatedAt` on each write.
   */
  readonly now?: () => number;
}

// ── Sanitization ─────────────────────────────────────────────────────

/** Maximum length of the sanitized base name (without `.md` extension). */
const MAX_BASENAME = 200;

/** Characters allowed in a sanitized name. Rejects everything else. */
const VALID_CHARS = /^[A-Za-z0-9_\-:.]+$/;

/**
 * Sanitize a teamId or key for safe filesystem use.
 *  - `/` becomes `__` (matches SoulStore convention).
 *  - Invalid characters throw — we NEVER silently discard input because
 *    that would cause collisions.
 *  - Over-long names hash-truncate: `name[0..180]` + `__` + first 12 hex
 *    of sha256(original).
 */
function sanitizeName(raw: string, kind: 'team' | 'key'): string {
  if (!raw || raw.length === 0) {
    throw new Error(`team-blackboard-fs: empty ${kind} id`);
  }
  const underscored = raw.replace(/\//g, '__');
  if (!VALID_CHARS.test(underscored)) {
    throw new Error(
      `team-blackboard-fs: invalid ${kind} id '${raw}' — allowed: [A-Za-z0-9_\\-:./]`,
    );
  }
  if (underscored.length <= MAX_BASENAME) return underscored;
  const head = underscored.slice(0, 180);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${head}__${hash}`;
}

// ── Frontmatter parser/emitter (tiny, matches our format exactly) ────

interface Frontmatter {
  key: string;
  version: number;
  author: string;
  updatedAt: string; // ISO-8601
}

function parseEntry(raw: string, path: string, teamId: string): FsBlackboardEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const fmRaw = m[1]!;
  const body = m[2]!;
  const fm: Partial<Frontmatter> = {};
  for (const line of fmRaw.split('\n')) {
    const [k, ...rest] = line.split(':');
    if (!k || rest.length === 0) continue;
    const value = rest.join(':').trim();
    switch (k.trim()) {
      case 'key':
        fm.key = value;
        break;
      case 'version':
        fm.version = Number.parseInt(value, 10);
        break;
      case 'author':
        fm.author = value;
        break;
      case 'updatedAt':
        fm.updatedAt = value;
        break;
    }
  }
  if (
    fm.key === undefined ||
    fm.version === undefined ||
    Number.isNaN(fm.version) ||
    fm.author === undefined ||
    fm.updatedAt === undefined
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    // Body is not JSON — treat as raw string (we still support string values
    // so callers can hand-author markdown content).
    value = body.trim();
  }
  const updatedAtMs = Date.parse(fm.updatedAt);
  return {
    teamId,
    key: fm.key,
    version: fm.version,
    value,
    authorId: fm.author,
    updatedAt: Number.isNaN(updatedAtMs) ? 0 : updatedAtMs,
    path,
  };
}

function emitEntry(params: {
  key: string;
  version: number;
  author: string;
  updatedAt: number;
  value: unknown;
}): string {
  const iso = new Date(params.updatedAt).toISOString();
  const body = JSON.stringify(params.value, null, 2);
  return `---
key: ${params.key}
version: ${params.version}
author: ${params.author}
updatedAt: ${iso}
---
${body}
`;
}

// ── Store ────────────────────────────────────────────────────────────

export class TeamBlackboardFs {
  private readonly root: string;
  private readonly now: () => number;

  constructor(config: TeamBlackboardFsConfig) {
    this.root = join(config.root, '.vinyan', 'teams');
    this.now = config.now ?? (() => Date.now());
  }

  // ── Paths ────────────────────────────────────────────────────────

  teamDir(teamId: string): string {
    return join(this.root, sanitizeName(teamId, 'team'));
  }

  filePath(teamId: string, key: string): string {
    return join(this.teamDir(teamId), `${sanitizeName(key, 'key')}.md`);
  }

  // ── Reads ────────────────────────────────────────────────────────

  /**
   * Return the latest entry for (teamId, key) or null if no file exists
   * / the file is malformed. Never throws on missing file — that's the
   * normal "no state yet" case.
   */
  read(teamId: string, key: string): FsBlackboardEntry | null {
    const path = this.filePath(teamId, key);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf-8');
      return parseEntry(raw, path, teamId);
    } catch {
      return null;
    }
  }

  /**
   * List every key (sanitized filename minus `.md`) persisted for a team.
   * Returns the STORED key from each file's frontmatter so the caller
   * sees the original pre-sanitization key. Empty array when the team
   * directory does not exist.
   */
  listKeys(teamId: string): readonly string[] {
    const dir = this.teamDir(teamId);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    const keys: string[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), 'utf-8');
        const entry = parseEntry(raw, join(dir, f), teamId);
        if (entry) keys.push(entry.key);
      } catch {
        // Skip malformed files; next boot migration can repair.
      }
    }
    return keys.sort();
  }

  // ── Writes ───────────────────────────────────────────────────────

  /**
   * Write a new version for (teamId, key). The on-disk file must currently
   * be at `baselineVersion` (or absent, in which case baselineVersion must
   * be null). If the baseline doesn't match, the write is a no-op and the
   * returned value is null so the caller can retry after re-reading.
   *
   * Successful writes increment from the baseline and return the new entry.
   */
  writeWithCas(params: {
    teamId: string;
    key: string;
    value: unknown;
    authorId: string;
    baselineVersion: number | null;
  }): FsBlackboardEntry | null {
    const path = this.filePath(params.teamId, params.key);
    const current = this.read(params.teamId, params.key);
    const onDiskVersion = current?.version ?? null;

    if (onDiskVersion !== params.baselineVersion) {
      return null; // CAS miss — caller retries
    }

    const newVersion = (params.baselineVersion ?? 0) + 1;
    const updatedAt = this.now();
    const contents = emitEntry({
      key: params.key,
      version: newVersion,
      author: params.authorId,
      updatedAt,
      value: params.value,
    });

    this.writeAtomic(path, contents);

    return {
      teamId: params.teamId,
      key: params.key,
      version: newVersion,
      value: params.value,
      authorId: params.authorId,
      updatedAt,
      path,
    };
  }

  /**
   * Convenience wrapper: read current version, bump, write. Matches the
   * pre-FS `writeBlackboard` semantics (monotonic increment, no CAS for
   * the caller). In single-process operation the read-write sequence
   * cannot be interleaved by another in-process writer — JS is
   * single-threaded. External editors are a Phase 3 concern.
   */
  write(params: WriteParams): FsBlackboardEntry {
    const baseline = this.read(params.teamId, params.key)?.version ?? null;
    const written = this.writeWithCas({
      teamId: params.teamId,
      key: params.key,
      value: params.value,
      authorId: params.authorId,
      baselineVersion: baseline,
    });
    if (!written) {
      // Extremely unlikely in single-process operation — implies a
      // concurrent external writer. Retry once.
      const retryBaseline = this.read(params.teamId, params.key)?.version ?? null;
      const retry = this.writeWithCas({
        teamId: params.teamId,
        key: params.key,
        value: params.value,
        authorId: params.authorId,
        baselineVersion: retryBaseline,
      });
      if (!retry) {
        throw new Error(
          `team-blackboard-fs: CAS retry exhausted for ${params.teamId}/${params.key}`,
        );
      }
      return retry;
    }
    return written;
  }

  /**
   * Backfill write — forces the file to contain the given version number
   * instead of incrementing. ONLY for boot-migration from the legacy DB
   * backend. Regular writes should use `write` / `writeWithCas`.
   */
  backfill(params: {
    teamId: string;
    key: string;
    value: unknown;
    authorId: string;
    version: number;
    updatedAt: number;
  }): FsBlackboardEntry {
    const path = this.filePath(params.teamId, params.key);
    const contents = emitEntry({
      key: params.key,
      version: params.version,
      author: params.authorId,
      updatedAt: params.updatedAt,
      value: params.value,
    });
    this.writeAtomic(path, contents);
    return {
      teamId: params.teamId,
      key: params.key,
      version: params.version,
      value: params.value,
      authorId: params.authorId,
      updatedAt: params.updatedAt,
      path,
    };
  }

  /**
   * Delete every file for (teamId, key). Returns the number of files
   * removed (0 or 1 in practice — we have a single file per key).
   */
  delete(teamId: string, key: string): number {
    const path = this.filePath(teamId, key);
    if (!existsSync(path)) return 0;
    try {
      unlinkSync(path);
      return 1;
    } catch {
      return 0;
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  private writeAtomic(path: string, contents: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, contents, 'utf-8');
    try {
      renameSync(tmp, path);
    } catch (err) {
      // Best-effort cleanup of the tmp file on rename failure.
      try {
        unlinkSync(tmp);
      } catch {}
      throw err;
    }
  }

  /** Informational helper for callers (e.g. metrics). */
  teamDirExists(teamId: string): boolean {
    const dir = this.teamDir(teamId);
    try {
      return existsSync(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }
}

/**
 * AutoMemory loader — loads a user's long-lived, LLM-written memory index.
 *
 * Modeled after Claude Code's `memdir/` (see
 * docs/analysis/claude-code-architecture-lessons.md §3.2): a single
 * `MEMORY.md` acts as an index pointing at typed topic files (user /
 * feedback / project / reference). Content is *operationally useful for
 * prompt orientation* but NOT epistemically verified — every injection
 * into a prompt MUST carry `trustTier: 'probabilistic'` and pass through
 * `sanitizeForPrompt()` (Red Team mitigation #3 — second-order injection).
 *
 * Path resolution (in precedence order, first existing wins):
 *  1. Explicit `overridePath` argument (test hook / config override).
 *  2. `$VINYAN_AUTO_MEMORY_PATH` env var.
 *  3. `~/.vinyan/memory/<slug>/MEMORY.md` (Vinyan's own namespace).
 *  4. `~/.claude/projects/<slug>/memory/MEMORY.md` (Claude Code shared
 *     memory — opt-in via config; falls through when absent).
 *
 * `<slug>` is the workspace absolute path with `/` replaced by `-`, matching
 * Claude Code's convention so users with existing `.claude/projects/` data
 * can expose it to Vinyan without duplication.
 *
 * Caps (tight, enforced before returning):
 *  - MAX_ENTRYPOINT_LINES = 200  (matches Claude Code)
 *  - MAX_ENTRYPOINT_BYTES = 25_000
 *  - MAX_ENTRY_FILE_BYTES = 10_000 per pointed-at topic file
 *  - MAX_ENTRIES = 50 entries from the index
 *
 * The loader is BEST-EFFORT: every IO is try/catch, every missing path is
 * a soft null. The orchestrator pipeline proceeds when auto-memory is
 * absent — memory is advisory, never load-bearing (A5 + backwards compat).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sanitizeForPrompt } from '../guardrails/index.ts';
import { lintAutoMemoryContent, type LinterWarning } from './auto-memory-linter.ts';

// ── Caps (matched to Claude Code's `memdir.ts`) ─────────────────────────

export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;
export const MAX_ENTRY_FILE_BYTES = 10_000;
export const MAX_ENTRIES = 50;

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Typed taxonomy for AutoMemory entries. The MEMORY.md index links to
 * files and the loader classifies each entry by filename pattern.
 * 'unknown' is a valid bucket for entries that don't match the vocab —
 * we surface them as-is rather than silently discarding.
 */
export type AutoMemoryEntryType =
  | 'user'       // user profile / role / preferences
  | 'feedback'   // collaboration guidance
  | 'project'    // current-project context
  | 'reference'  // external system pointers
  | 'unknown';

/** A single loaded + sanitized entry. Content is TRUNCATED at MAX_ENTRY_FILE_BYTES. */
export interface AutoMemoryEntry {
  readonly type: AutoMemoryEntryType;
  /** Relative path as it appears in MEMORY.md (for provenance). */
  readonly ref: string;
  /** Absolute path of the resolved file on disk. */
  readonly absolutePath: string;
  /** One-line description (the text after "—" on the index line). */
  readonly description: string;
  /**
   * Sanitized content. `sanitizeForPrompt` has been applied; any injection
   * patterns have been replaced by `[REDACTED: ...]`. Downstream code MAY
   * sanitize again as defense-in-depth — it's idempotent.
   */
  readonly content: string;
  /** True when sanitization detected suspicious patterns. Surface to logs. */
  readonly sanitized: boolean;
  /** Byte length of the original (pre-sanitization) content — for observability. */
  readonly originalBytes: number;
  /** True when the file was truncated at MAX_ENTRY_FILE_BYTES. */
  readonly truncated: boolean;
  /**
   * Semantic-linter warnings (agent-imperative phrases detected).
   * Empty when the entry is clean. When `hasStrongWarning` is true the
   * comprehender's relevance scorer MUST downgrade this entry.
   */
  readonly linterWarnings: readonly LinterWarning[];
  /** True when at least one `strong` linter warning fired. */
  readonly hasStrongWarning: boolean;
}

/** The full loaded memory. Consumers should treat content as advisory. */
export interface AutoMemory {
  /** Absolute path to the MEMORY.md entrypoint that was successfully read. */
  readonly entrypoint: string;
  /** Sanitized first-200-lines of MEMORY.md (the index itself). */
  readonly indexContent: string;
  /** Parsed + loaded entries, in the order they appeared in the index. */
  readonly entries: readonly AutoMemoryEntry[];
  /** Whether the index itself was truncated. */
  readonly indexTruncated: boolean;
  /** Total bytes loaded across index + entries (for budget tracking). */
  readonly totalBytes: number;
  /** A5: every AutoMemory load is probabilistic by construction. */
  readonly trustTier: 'probabilistic';
  /** Epoch ms — when this snapshot was loaded. */
  readonly loadedAt: number;
}

export interface LoadAutoMemoryOptions {
  /** Absolute workspace root. */
  workspace: string;
  /**
   * Explicit override for the MEMORY.md path. When set, skips all other
   * resolution steps. Used for testing and for users with non-default layouts.
   */
  overridePath?: string;
  /**
   * Opt-in: also look under `~/.claude/projects/<slug>/memory/MEMORY.md`
   * when the Vinyan-native path is missing. Default `true` — users who
   * have existing Claude Code memory get it for free.
   */
  useClaudeCodePath?: boolean;
  /** Environment hook (so tests can inject isolated env). */
  env?: NodeJS.ProcessEnv;
}

// ── Slug derivation ─────────────────────────────────────────────────────

/**
 * Canonical slug: absolute path with `/` replaced by `-`. Mirrors
 * Claude Code's `paths.ts#getProjectSlug` so a user's existing
 * `.claude/projects/<slug>/memory/` directory is reusable without
 * migration.
 */
export function workspaceSlug(workspace: string): string {
  const abs = resolve(workspace);
  return abs.replace(/\//g, '-');
}

// ── Path resolution ─────────────────────────────────────────────────────

function resolveEntrypoint(opts: LoadAutoMemoryOptions): string | null {
  if (opts.overridePath) {
    return existsSync(opts.overridePath) ? opts.overridePath : null;
  }

  const env = opts.env ?? process.env;
  const envPath = env.VINYAN_AUTO_MEMORY_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const home = homedir();
  const slug = workspaceSlug(opts.workspace);

  const vinyanPath = join(home, '.vinyan', 'memory', slug, 'MEMORY.md');
  if (existsSync(vinyanPath)) return vinyanPath;

  if (opts.useClaudeCodePath !== false) {
    const claudePath = join(home, '.claude', 'projects', slug, 'memory', 'MEMORY.md');
    if (existsSync(claudePath)) return claudePath;
  }

  return null;
}

// ── Reading helpers ─────────────────────────────────────────────────────

/**
 * Safely read a file with a byte cap and a line cap (whichever hits first).
 * Returns `null` on any IO error — callers treat as "file absent".
 */
function readCapped(
  path: string,
  maxBytes: number,
  maxLines?: number,
): { content: string; truncated: boolean; originalBytes: number } | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const originalBytes = stat.size;
    // Over-read slightly then clip — avoids two-pass file reading.
    const raw = readFileSync(path, { encoding: 'utf-8' });

    let content = raw;
    let truncated = false;
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes);
      truncated = true;
    }
    if (maxLines !== undefined) {
      const lines = content.split('\n');
      if (lines.length > maxLines) {
        content = `${lines.slice(0, maxLines).join('\n')}`;
        truncated = true;
      }
    }
    return { content, truncated, originalBytes };
  } catch {
    return null;
  }
}

// ── Index parsing ───────────────────────────────────────────────────────

/** Pattern: `- [Title](file.md) — description` (Claude Code index format). */
const INDEX_LINE_RE = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—\-–]\s*(.*)$/;

/** Typed-file naming vocab (filename prefix → entry type). */
function classifyEntry(ref: string): AutoMemoryEntryType {
  const lower = ref.toLowerCase();
  if (lower.startsWith('user')) return 'user';
  if (lower.startsWith('feedback')) return 'feedback';
  if (lower.startsWith('project')) return 'project';
  if (lower.startsWith('reference')) return 'reference';
  return 'unknown';
}

function loadEntry(
  entrypointDir: string,
  ref: string,
  description: string,
): AutoMemoryEntry | null {
  // Reject obvious path traversal — the index should only point at
  // siblings of MEMORY.md, not arbitrary filesystem locations.
  if (ref.includes('..') || ref.startsWith('/') || ref.startsWith('~')) {
    return null;
  }
  const absolutePath = join(entrypointDir, ref);
  const read = readCapped(absolutePath, MAX_ENTRY_FILE_BYTES);
  if (!read) return null;

  const sanitizeResult = sanitizeForPrompt(read.content);
  // Defense-in-depth: after syntactic sanitization, run the semantic
  // poisoning linter to catch agent-imperative phrases that the
  // injection scanner lets through. Warnings are advisory — callers
  // (the comprehender's relevance scorer) decide how to react.
  const lintResult = lintAutoMemoryContent(sanitizeResult.cleaned);
  return {
    type: classifyEntry(ref),
    ref,
    absolutePath,
    description: description.trim(),
    content: sanitizeResult.cleaned,
    sanitized: sanitizeResult.detections.length > 0,
    originalBytes: read.originalBytes,
    truncated: read.truncated,
    linterWarnings: lintResult.warnings,
    hasStrongWarning: lintResult.hasStrong,
  };
}

// ── Public loader ────────────────────────────────────────────────────────

/**
 * Load the user's AutoMemory for the given workspace. Returns `null` when
 * no entrypoint is resolvable — callers treat this as "no auto-memory, use
 * empty lane" (graceful degradation).
 */
export function loadAutoMemory(opts: LoadAutoMemoryOptions): AutoMemory | null {
  const entrypoint = resolveEntrypoint(opts);
  if (!entrypoint) return null;

  const index = readCapped(entrypoint, MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES);
  if (!index) return null;

  // Sanitize the index itself — the first 200 lines are always loaded so
  // any injection here is particularly dangerous.
  const sanitizedIndex = sanitizeForPrompt(index.content);

  const entrypointDir = dirname(entrypoint);
  const entries: AutoMemoryEntry[] = [];
  let totalBytes = sanitizedIndex.cleaned.length;

  for (const line of index.content.split('\n')) {
    if (entries.length >= MAX_ENTRIES) break;
    const match = line.match(INDEX_LINE_RE);
    if (!match) continue;
    const ref = match[2]!;
    const description = match[3] ?? '';
    const entry = loadEntry(entrypointDir, ref, description);
    if (entry) {
      entries.push(entry);
      totalBytes += entry.content.length;
    }
  }

  return {
    entrypoint,
    indexContent: sanitizedIndex.cleaned,
    entries,
    indexTruncated: index.truncated,
    totalBytes,
    trustTier: 'probabilistic',
    loadedAt: Date.now(),
  };
}

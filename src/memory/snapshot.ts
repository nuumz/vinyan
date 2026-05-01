/**
 * MemorySnapshot — Hermes-style frozen capture of bounded memory at
 * task / session start.
 *
 * Hermes lesson (`features/memory`): "the snapshot never changes
 * mid-session — changes persist to disk immediately but won't appear
 * in the system prompt until the next session." This file makes that
 * contract explicit in Vinyan.
 *
 * The auto-memory subsystem already loads once and returns
 * `readonly`-typed structures — but TypeScript `readonly` is
 * compile-time only. `captureMemorySnapshot` calls `Object.freeze`
 * on the wrapper AND its `autoMemory.entries` array so a runtime
 * accidental mutation (e.g. a comprehender plugin pushing into
 * `entries`) throws in strict mode instead of silently corrupting
 * the next prompt.
 *
 * Provenance / cache stability: every snapshot carries a `contentHash`
 * computed from the sanitised index + entry contents. Two snapshots
 * with the same hash MUST be substituted in the prompt without
 * busting prefix-cache (deterministic — A3). A memory write that
 * actually changes content produces a fresh hash on the *next*
 * snapshot but does not retroactively mutate the captured one.
 *
 * Profile scoping: every capture takes a `profile` parameter. The
 * resolver lives in `auto-memory-loader.ts` and reads from
 * `~/.vinyan/memory/<slug>/MEMORY.md`. A future profile-namespaced
 * path (`~/.vinyan/memory/<profile>/<slug>/`) plugs in by passing
 * `overridePath`.
 */

import { createHash } from 'node:crypto';
import { type AutoMemory, loadAutoMemory, type LoadAutoMemoryOptions } from './auto-memory-loader.ts';

export interface MemorySnapshot {
  /** Profile namespace this snapshot was captured under. */
  readonly profile: string;
  /** Underlying auto-memory tree. `null` when no MEMORY.md was found. */
  readonly autoMemory: AutoMemory | null;
  /** Epoch ms — when the capture happened. Distinct from `autoMemory.loadedAt`. */
  readonly capturedAt: number;
  /**
   * SHA-256 of the canonical content (index + every entry's sanitized
   * content joined with NUL separators). Stable for byte-equal payloads;
   * changes the moment any entry's text diverges. The chat / comprehender
   * pipeline can use this as the prefix-cache key without re-hashing the
   * full block per prompt.
   */
  readonly contentHash: string;
  /** Total entries surfaced — bounded by `MAX_ENTRIES`. */
  readonly entryCount: number;
  /** Total character count across index + entries — operator visibility. */
  readonly characterCount: number;
}

export interface CaptureMemorySnapshotOptions extends LoadAutoMemoryOptions {
  /**
   * Profile namespace to record on the snapshot. Defaults to `'default'`
   * — callers running in the API server pass the resolved
   * `defaultProfile` / `X-Vinyan-Profile`.
   */
  profile?: string;
  /**
   * Test hook — pre-loaded `AutoMemory`. When set, the snapshot wraps
   * this value instead of calling `loadAutoMemory`. Lets unit tests
   * verify freeze / hash semantics without touching the filesystem.
   */
  preloaded?: AutoMemory | null;
}

/**
 * Capture an immutable memory snapshot. Always returns a frozen
 * `MemorySnapshot`; never throws (auto-memory load failures degrade
 * to `autoMemory: null`).
 */
export function captureMemorySnapshot(opts: CaptureMemorySnapshotOptions): MemorySnapshot {
  const profile = opts.profile ?? 'default';
  let autoMemory: AutoMemory | null = opts.preloaded ?? null;
  if (autoMemory === null && opts.preloaded === undefined) {
    try {
      autoMemory = loadAutoMemory(opts);
    } catch {
      autoMemory = null;
    }
  }

  // Freeze the entries array so a downstream consumer cannot push or
  // splice into it. `Object.freeze` is shallow; entries themselves are
  // plain objects with `readonly` fields — TS prevents mutation at
  // compile time and a runtime mutation attempt produces a TypeError
  // in strict mode.
  if (autoMemory && Array.isArray(autoMemory.entries)) {
    Object.freeze(autoMemory.entries);
  }

  const contentHash = hashSnapshotContent(autoMemory);
  const characterCount = autoMemory
    ? autoMemory.indexContent.length +
      autoMemory.entries.reduce((acc, e) => acc + e.content.length, 0)
    : 0;

  const snapshot: MemorySnapshot = Object.freeze({
    profile,
    autoMemory: autoMemory ? Object.freeze(autoMemory) : null,
    capturedAt: Date.now(),
    contentHash,
    entryCount: autoMemory?.entries.length ?? 0,
    characterCount,
  });

  return snapshot;
}

/**
 * Two snapshots are prefix-cache-equivalent when their content hashes
 * match — the underlying bytes the LLM sees are identical. The
 * `capturedAt` and `profile` fields are deliberately ignored: the
 * cache key is the content, not the wall-clock.
 */
export function isMemorySnapshotEquivalent(a: MemorySnapshot, b: MemorySnapshot): boolean {
  return a.contentHash === b.contentHash;
}

/**
 * Compose a stable content key from a snapshot. The `null` / empty
 * cases hash a sentinel so cache-equivalent "no memory" snapshots all
 * collapse to the same key (instead of every empty snapshot getting
 * its own bucket via `capturedAt`).
 */
function hashSnapshotContent(autoMemory: AutoMemory | null): string {
  const hash = createHash('sha256');
  if (!autoMemory) {
    hash.update('vinyan:memory:empty');
    return hash.digest('hex');
  }
  hash.update('vinyan:memory:v1\n');
  hash.update(autoMemory.indexContent);
  hash.update('\0');
  for (const entry of autoMemory.entries) {
    hash.update(entry.ref);
    hash.update('\0');
    hash.update(entry.type);
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

// ────────────────────────────────────────────────────────────────────
// Duplicate detection — used at memory-write boundary
// ────────────────────────────────────────────────────────────────────

/**
 * Normalised duplicate check. Returns `true` when `candidate` is
 * already represented in `existing` to within whitespace +
 * case-insensitive equality. The naive `LIKE %text%` substring check
 * is intentionally avoided: short candidates ("ok") would falsely
 * match every long entry containing the word.
 *
 * The intended call site is the memory-write surface (`/api/v1/memory`
 * + the autoMemory linter approval path). A `true` verdict means the
 * write should be a no-op or merged into the existing entry; a
 * `false` verdict means the write may proceed.
 */
export function isDuplicateMemoryEntry(existing: ReadonlyArray<string>, candidate: string): boolean {
  const norm = normalise(candidate);
  if (norm.length === 0) return true;
  for (const e of existing) {
    if (normalise(e) === norm) return true;
  }
  return false;
}

function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ────────────────────────────────────────────────────────────────────
// Safety verdict for new memory writes
// ────────────────────────────────────────────────────────────────────

/**
 * Determine whether a candidate memory write is safe to persist.
 *
 * The existing `sanitizeForPrompt` (`src/guardrails/index.ts`) handles
 * literal prompt-injection patterns. This helper layers two more
 * deterministic checks the Hermes design calls out:
 *
 *  - **Hidden Unicode** — bidi controls (U+202A..U+202E, U+2066..U+2069),
 *    zero-width / word-joiner / soft-hyphen, BOM. Most legitimate text
 *    has none.
 *  - **Credential-shaped tokens** — sk-, ghp_, AKIA…, Bearer eyJ…,
 *    `password=`. These don't belong in long-lived memory regardless
 *    of intent (A6 zero-trust).
 *
 * A `safe: false` verdict surfaces `flags` so the operator can see the
 * specific reason. The check is pure (A3) — no LLM in this path.
 */
export interface MemorySafetyVerdict {
  readonly safe: boolean;
  readonly flags: ReadonlyArray<string>;
}

export function memorySafetyVerdict(content: string): MemorySafetyVerdict {
  const flags: string[] = [];

  // Hidden unicode — bidi, zero-width, BOM.
  // Pre-built character class avoids regex re-compilation on the hot path.
  if (/[‪-‮⁦-⁩​-‍⁠﻿­]/.test(content)) {
    flags.push('hidden-unicode');
  }

  // Credential-shaped tokens (anchored — we want substring matches).
  // Each pattern is purposefully strict; loose forms here would bounce
  // legitimate text containing the word "password" or "Bearer".
  if (/\bsk-[A-Za-z0-9]{20,}/.test(content)) flags.push('credential:openai');
  if (/\bghp_[A-Za-z0-9]{30,}/.test(content)) flags.push('credential:github');
  if (/\bAKIA[0-9A-Z]{16}\b/.test(content)) flags.push('credential:aws');
  if (/\bBearer\s+eyJ[A-Za-z0-9_\-]{10,}/.test(content)) flags.push('credential:jwt');
  if (/(?:password|api[_-]?key|secret)\s*[:=]\s*\S+/i.test(content)) flags.push('credential:keyvalue');

  // Destructive shell snippets — do NOT block; flag for review. Memory
  // is meant to capture lessons, including "don't run rm -rf /". The
  // `/` does not have a word boundary on its right side, so anchor on
  // `rm`'s left boundary only.
  if (/\brm\s+-rf\s+\/|:\(\)\s*\{\s*:\s*\|:\s*&\s*\}\s*;\s*:/.test(content)) {
    flags.push('destructive-shell-pattern');
  }

  return Object.freeze({
    safe: flags.filter((f) => !f.startsWith('destructive-shell-pattern')).length === 0,
    flags: Object.freeze(flags),
  });
}

/**
 * Knowledge Index Builder — Phase C2 of the knowledge-loop RFC.
 *
 * Walks the project's `src/` tree, extracts a 1-line description for each
 * top-level module from its leading JSDoc block, and writes a curated
 * catalog to `.vinyan/knowledge-index.md`. Pattern lifted from
 * obsidian-second-brain's `index.md` (read FIRST before searching) — the
 * goal is token discipline: a hand-curated catalog beats a `Glob` + `Grep`
 * sweep on every agent boot.
 *
 * Trigger surfaces:
 *   1. `SleepCycleRunner` (when wired) — rebuilds nightly so the catalog
 *      stays current with code drift.
 *   2. CLI `vinyan index` (when wired) — manual refresh.
 *   3. Direct programmatic call from any orchestrator path that wants to
 *      surface project structure without paying for a full filesystem walk.
 *
 * Output format: deterministic Markdown. Stable across runs that don't
 * change the source tree, so it's safe to commit if a project chooses.
 *
 * Axiom anchor:
 *   - A3 Deterministic Governance: pure rule-based scan, no LLM in path.
 *   - A6 Zero-Trust: read-only filesystem walk + write to a single
 *     well-known artifact path. No effects outside `<workspace>/.vinyan/`.
 *
 * Source: docs/design/knowledge-loop-rfc.md §6.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Public types ───────────────────────────────────────────────────────

export interface KnowledgeIndexEntry {
  /** Path relative to workspace root, with trailing slash. */
  readonly path: string;
  /** First non-empty line of the module's leading JSDoc, capped to 120 chars. */
  readonly description: string;
  /** Total `.ts` files under this module (recursive). */
  readonly fileCount: number;
  /** Latest mtime across all `.ts` files under this module (epoch ms). */
  readonly lastModified: number;
}

export interface KnowledgeIndex {
  readonly generatedAt: number;
  readonly workspaceRoot: string;
  readonly srcDir: string;
  readonly modules: readonly KnowledgeIndexEntry[];
}

export interface BuildOptions {
  /** Source directory relative to workspace root (default: `'src'`). */
  readonly srcDir?: string;
  /** When true, include directories that start with `_` (default: `false`). */
  readonly includeUnderscoreDirs?: boolean;
  /** Override `Date.now()` for deterministic snapshots in tests. */
  readonly nowMs?: number;
  /** When set, only walk this many bytes per file (cheap-cap for huge files). */
  readonly maxFileBytes?: number;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Cap each description so the rendered index stays under ~500 tokens for ~30 modules. */
const DESCRIPTION_MAX_CHARS = 120;
/** Cap on bytes read per file when extracting the JSDoc — JSDoc is at the top, no need to slurp the whole file. */
const DEFAULT_MAX_FILE_BYTES = 4096;
/** First JSDoc block in a file. Captures inner content; matches both single- and multi-line forms. */
const JSDOC_BLOCK_RE = /\/\*\*\s*([\s\S]*?)\s*\*\//;

const NO_DESCRIPTION_PLACEHOLDER = '(no description)';

// ── Build ──────────────────────────────────────────────────────────────

export function buildKnowledgeIndex(workspaceRoot: string, opts: BuildOptions = {}): KnowledgeIndex {
  const srcDir = opts.srcDir ?? 'src';
  const includeUnderscore = opts.includeUnderscoreDirs ?? false;
  const generatedAt = opts.nowMs ?? Date.now();
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const absSrc = join(workspaceRoot, srcDir);
  if (!existsSync(absSrc)) {
    return { generatedAt, workspaceRoot, srcDir, modules: [] };
  }

  const entries = readdirSync(absSrc)
    .sort()
    .filter((name) => {
      if (name.startsWith('.')) return false;
      if (!includeUnderscore && name.startsWith('_')) return false;
      return true;
    });

  const modules: KnowledgeIndexEntry[] = [];
  for (const name of entries) {
    const absDir = join(absSrc, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const description = extractModuleDescription(absDir, maxFileBytes) ?? NO_DESCRIPTION_PLACEHOLDER;
    const counts = collectModuleStats(absDir);
    modules.push({
      path: `${srcDir}/${name}/`,
      description,
      fileCount: counts.fileCount,
      lastModified: counts.lastModified,
    });
  }

  return { generatedAt, workspaceRoot, srcDir, modules };
}

// ── Description extraction ─────────────────────────────────────────────

/**
 * Pull the first non-empty line of the leading JSDoc block from the most
 * authoritative file in the module directory: prefer `index.ts`, then fall
 * back to alphabetically first `.ts` file. Returns `null` when no docstring
 * is found.
 */
function extractModuleDescription(absDir: string, maxBytes: number): string | null {
  const tsFiles = listTsFilesShallow(absDir);
  if (tsFiles.length === 0) return null;

  const ordered = ['index.ts', ...tsFiles.filter((n) => n !== 'index.ts')];

  for (const name of ordered) {
    const filePath = join(absDir, name);
    if (!existsSync(filePath)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = readHead(filePath, maxBytes);
    } catch {
      continue;
    }

    const description = extractFirstJsdocLine(content);
    if (description) return description;
  }
  return null;
}

function extractFirstJsdocLine(content: string): string | null {
  const match = content.match(JSDOC_BLOCK_RE);
  if (!match) return null;
  const block = (match[1] ?? '').trim();
  if (block.length === 0) return null;
  // Multi-line block: each interior line is prefixed with "* ". Single-line
  // block (e.g. `/** desc */`) has no leading `*` and no newline. Handle both
  // by stripping the leading `*` per line and picking the first non-empty.
  for (const rawLine of block.split('\n')) {
    const stripped = rawLine
      .trim()
      .replace(/^\*\s?/, '')
      .trim();
    if (stripped.length === 0) continue;
    return truncate(stripped, DESCRIPTION_MAX_CHARS);
  }
  return null;
}

function listTsFilesShallow(absDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts')).sort();
}

function readHead(path: string, maxBytes: number): string {
  const buffer = readFileSync(path);
  return buffer.subarray(0, Math.min(maxBytes, buffer.length)).toString('utf8');
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return `${s.slice(0, cap - 1)}…`;
}

// ── Stats ──────────────────────────────────────────────────────────────

function collectModuleStats(absDir: string): { fileCount: number; lastModified: number } {
  let fileCount = 0;
  let lastModified = 0;

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(p);
      } else if (s.isFile() && name.endsWith('.ts')) {
        fileCount += 1;
        if (s.mtimeMs > lastModified) lastModified = s.mtimeMs;
      }
    }
  };

  walk(absDir);
  return { fileCount, lastModified };
}

// ── Render ─────────────────────────────────────────────────────────────

/**
 * Render the index as Markdown for human inspection or for injection into
 * an LLM context window. Output is deterministic when input is.
 */
export function formatAsMarkdown(index: KnowledgeIndex): string {
  const stamp = new Date(index.generatedAt).toISOString().slice(0, 16).replace('T', ' ');
  const lines: string[] = [
    '# Vinyan Knowledge Index',
    '',
    `> Auto-generated. Updated: ${stamp} UTC. Total modules: ${index.modules.length}.`,
    '> Read this BEFORE running `Glob`/`Grep` for project structure — token-discipline catalog.',
    '> See `docs/design/knowledge-loop-rfc.md` §6.',
    '',
    '## Top-level modules',
    '',
  ];
  for (const m of index.modules) {
    lines.push(`- \`${m.path}\` — ${m.description}`);
  }
  if (index.modules.length === 0) {
    lines.push('_(no modules detected)_');
  }
  lines.push('');
  return lines.join('\n');
}

// ── Persist ────────────────────────────────────────────────────────────

export interface WriteOptions {
  /** Override the output directory (default: `<workspaceRoot>/.vinyan`). */
  readonly outputDir?: string;
  /** Override the filename (default: `knowledge-index.md`). */
  readonly filename?: string;
}

/** Write the rendered index to disk. Returns the absolute path written. */
export function writeKnowledgeIndex(workspaceRoot: string, index: KnowledgeIndex, opts: WriteOptions = {}): string {
  const outputDir = opts.outputDir ?? join(workspaceRoot, '.vinyan');
  const filename = opts.filename ?? 'knowledge-index.md';
  mkdirSync(outputDir, { recursive: true });
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, formatAsMarkdown(index), 'utf-8');
  return filePath;
}

// ── Convenience ────────────────────────────────────────────────────────

/**
 * Build + write in a single call. The common case for sleep-cycle and CLI
 * triggers. Returns both the in-memory index and the path written.
 */
export function rebuildKnowledgeIndex(
  workspaceRoot: string,
  opts: BuildOptions & WriteOptions = {},
): { index: KnowledgeIndex; path: string } {
  const index = buildKnowledgeIndex(workspaceRoot, opts);
  const path = writeKnowledgeIndex(workspaceRoot, index, opts);
  return { index, path };
}

/**
 * Instruction Hierarchy — multi-tier instruction loading with @include and glob-conditional rules.
 *
 * Beats Claude Code and VSCode Copilot by combining their best ideas:
 *  - Claude Code: tier hierarchy (user/project/local), @include, glob-conditional rules
 *  - Copilot: applyTo glob patterns with priority
 *  - Vinyan: priority-ordered merging, per-rule tier_reliability hints, circular detection
 *
 * Tier precedence (later overrides earlier):
 *   M1 User preferences   ~/.vinyan/preferences.md
 *   M2 Project root       ./VINYAN.md
 *   M3 Project rules      ./.vinyan/rules/**\/*.md (with applyTo frontmatter)
 *   M4 Learned conventions ./.vinyan/memory/learned.md (agent-proposed, oracle-gated)
 *
 * A1 compliance: All M1-M3 tiers are human-authored only.
 * M4 (learned conventions) requires human review before entries are committed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, resolve, isAbsolute } from 'path';
import { homedir } from 'os';

/** Max per-file instruction size (50KB) — prevents context window blowout. */
const MAX_INSTRUCTION_SIZE = 50_000;

/** Max total merged instruction size (150KB) — caps aggregate memory budget. */
const MAX_MERGED_SIZE = 150_000;

/** Max @include depth (prevents deeply nested chains). */
const MAX_INCLUDE_DEPTH = 5;

/** Instruction tier identifiers in precedence order (later wins on conflict). */
export type InstructionTier = 'user' | 'project' | 'scoped-rule' | 'learned';

/** Parsed YAML frontmatter fields that Vinyan understands. */
export interface RuleFrontmatter {
  /** Glob patterns this rule applies to. If omitted, rule is always active. */
  applyTo?: string[];
  /** Priority for merge order (higher = applied later = overrides). Default 50. */
  priority?: number;
  /** Human description for debugging / UI. */
  description?: string;
  /** Trust tier hint — affects how LLM weighs this rule. */
  tier?: 'deterministic' | 'heuristic' | 'probabilistic';
  /** Task types this rule applies to. 'code' | 'reasoning'. If omitted, both. */
  taskTypes?: Array<'code' | 'reasoning'>;
  /** Only apply when task matches these action verbs (fix, refactor, add, etc.). */
  applyToActions?: string[];
  /** Do NOT apply when task action matches any of these verbs. */
  excludeActions?: string[];
}

/** A single instruction source (file) with metadata. */
export interface InstructionSource {
  /** Which tier this source belongs to. */
  tier: InstructionTier;
  /** Absolute path to the file. */
  filePath: string;
  /** Raw content of the instruction file (post @include expansion). */
  content: string;
  /** SHA-256 hash of content for cache invalidation. */
  contentHash: string;
  /** Parsed frontmatter (empty object if none). */
  frontmatter: RuleFrontmatter;
  /** Set of files included via @include (for invalidation tracking). */
  includes: string[];
  /** Discovery order within tier — preserves intentional file ordering (e.g., VINYAN.md before AGENTS.md). */
  discoveryIndex?: number;
}

/** Resolved instruction memory — the final merged view for a specific task context. */
export interface InstructionMemory {
  /** Raw content of the merged instruction content. */
  content: string;
  /** SHA-256 hash of merged content (stable across calls with same inputs). */
  contentHash: string;
  /** Primary file path (for backwards compatibility — points to M2 VINYAN.md if present). */
  filePath: string;
  /** All sources that contributed to this memory, in merge order. */
  sources: InstructionSource[];
}

/** Context for per-task instruction resolution. */
export interface InstructionContext {
  /** Absolute workspace root. */
  workspace: string;
  /** Target files for this task (used for applyTo matching). */
  targetFiles?: string[];
  /** Task type — influences which rules apply. */
  taskType?: 'code' | 'reasoning';
  /** Action verb from task understanding (e.g., 'fix', 'refactor'). Enables applyToActions/excludeActions filtering. */
  actionVerb?: string;
}

// ── Cache ─────────────────────────────────────────────────────────────

/** Per-source cache keyed by absolute path. Invalidated by content hash. */
const sourceCache = new Map<string, InstructionSource>();

/** Resolved merged cache keyed by (workspace + target file set + task type). */
const resolvedCache = new Map<string, InstructionMemory>();

/** Clear all caches (for testing or config reload). */
export function clearInstructionHierarchyCache(): void {
  sourceCache.clear();
  resolvedCache.clear();
}

// ── Frontmatter parsing ───────────────────────────────────────────────

/**
 * Parse YAML-ish frontmatter at the start of a markdown file.
 * Supports a minimal subset: string arrays, strings, numbers.
 * No external yaml dependency — avoids adding a new dep for simple key: value parsing.
 */
export function parseFrontmatter(content: string): { frontmatter: RuleFrontmatter; body: string } {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }
  // Find closing ---
  const closing = content.indexOf('\n---', 4);
  if (closing < 0) {
    return { frontmatter: {}, body: content };
  }
  const fmBlock = content.slice(4, closing);
  const body = content.slice(closing + 4).replace(/^\r?\n/, '');

  const frontmatter: RuleFrontmatter = {};
  let currentKey: string | null = null;
  const lines = fmBlock.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    // List item continuation: "  - value"
    const listMatch = line.match(/^\s+-\s*(.+)$/);
    if (listMatch && currentKey === 'applyTo') {
      const val = listMatch[1]!.replace(/^["']|["']$/g, '');
      if (!frontmatter.applyTo) frontmatter.applyTo = [];
      frontmatter.applyTo.push(val);
      continue;
    }

    // List continuation for any recognized list key
    if (listMatch && (currentKey === 'taskTypes' || currentKey === 'applyToActions' || currentKey === 'excludeActions')) {
      const val = listMatch[1]!.replace(/^["']|["']$/g, '');
      if (currentKey === 'taskTypes') {
        if (val === 'code' || val === 'reasoning') {
          if (!frontmatter.taskTypes) frontmatter.taskTypes = [];
          frontmatter.taskTypes.push(val);
        }
      } else if (currentKey === 'applyToActions') {
        if (!frontmatter.applyToActions) frontmatter.applyToActions = [];
        frontmatter.applyToActions.push(val);
      } else if (currentKey === 'excludeActions') {
        if (!frontmatter.excludeActions) frontmatter.excludeActions = [];
        frontmatter.excludeActions.push(val);
      }
      continue;
    }

    // key: value
    const kvMatch = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();
      currentKey = key;

      if (key === 'applyTo') {
        if (value === '' || value === '[]') {
          frontmatter.applyTo = [];
        } else if (value.startsWith('[')) {
          // inline array: [a, b, c]
          frontmatter.applyTo = value
            .slice(1, value.endsWith(']') ? -1 : undefined)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        } else if (value) {
          // Single glob on one line
          frontmatter.applyTo = [value.replace(/^["']|["']$/g, '')];
        }
      } else if (key === 'priority') {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n)) frontmatter.priority = n;
      } else if (key === 'description') {
        frontmatter.description = value.replace(/^["']|["']$/g, '');
      } else if (key === 'tier') {
        const t = value.replace(/^["']|["']$/g, '');
        if (t === 'deterministic' || t === 'heuristic' || t === 'probabilistic') {
          frontmatter.tier = t;
        }
      } else if (key === 'taskTypes') {
        if (value.startsWith('[')) {
          const parts = value
            .slice(1, value.endsWith(']') ? -1 : undefined)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''));
          frontmatter.taskTypes = parts.filter(
            (p): p is 'code' | 'reasoning' => p === 'code' || p === 'reasoning',
          );
        } else if (value && (value === 'code' || value === 'reasoning')) {
          frontmatter.taskTypes = [value];
        }
      } else if (key === 'applyToActions' || key === 'excludeActions') {
        const field = key;
        if (value.startsWith('[')) {
          const parts = value
            .slice(1, value.endsWith(']') ? -1 : undefined)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
          frontmatter[field] = parts;
        } else if (value) {
          frontmatter[field] = [value.replace(/^["']|["']$/g, '')];
        }
      }
    }
  }
  return { frontmatter, body };
}

// ── @include expansion ────────────────────────────────────────────────

/** Regex for @include directive matching standalone lines. */
const INCLUDE_RE = /^@([^\s\\]+)\s*$/gm;

/**
 * Resolve an @include target to an absolute path.
 * Supports: @./relative, @/absolute, @~/home, @name (resolved relative to base).
 */
function resolveIncludePath(target: string, baseDir: string): string | null {
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return join(homedir(), target.slice(2));
  }
  if (isAbsolute(target)) {
    return target;
  }
  if (target.startsWith('./') || target.startsWith('../')) {
    return resolve(baseDir, target);
  }
  // Bare name — treat as relative to baseDir
  return resolve(baseDir, target);
}

/**
 * Expand @include directives in content recursively, with circular detection.
 * @param content source content
 * @param baseDir directory to resolve relative @includes against
 * @param visited set of already-visited absolute paths (for cycle detection)
 * @param depth current nesting depth
 * @param includedPaths out parameter: list of all files included (in order)
 */
function expandIncludes(
  content: string,
  baseDir: string,
  visited: Set<string>,
  depth: number,
  includedPaths: string[],
): string {
  if (depth > MAX_INCLUDE_DEPTH) {
    return `<!-- @include max depth (${MAX_INCLUDE_DEPTH}) exceeded -->\n${content}`;
  }

  return content.replace(INCLUDE_RE, (_match, target: string) => {
    const resolvedPath = resolveIncludePath(target, baseDir);
    if (!resolvedPath) return `<!-- @include: cannot resolve "${target}" -->`;

    // Cycle detection
    if (visited.has(resolvedPath)) {
      return `<!-- @include: circular reference to ${target} -->`;
    }

    if (!existsSync(resolvedPath)) {
      return `<!-- @include: file not found: ${target} -->`;
    }

    try {
      const stat = statSync(resolvedPath);
      if (stat.size > MAX_INSTRUCTION_SIZE) {
        return `<!-- @include: file too large (${stat.size} bytes): ${target} -->`;
      }
      const raw = readFileSync(resolvedPath, 'utf-8');
      includedPaths.push(resolvedPath);
      visited.add(resolvedPath);
      // Recursively expand (but skip frontmatter in included files — it only applies to the root)
      const { body } = parseFrontmatter(raw);
      const expanded = expandIncludes(body, dirname(resolvedPath), visited, depth + 1, includedPaths);
      visited.delete(resolvedPath);
      return `<!-- @include ${target} -->\n${expanded}\n<!-- end @include -->`;
    } catch {
      return `<!-- @include: read error: ${target} -->`;
    }
  });
}

// ── Source loading ────────────────────────────────────────────────────

/**
 * Load a single instruction source file with caching and @include expansion.
 * Returns null if file doesn't exist or is too large.
 */
function loadSource(filePath: string, tier: InstructionTier): InstructionSource | null {
  if (!existsSync(filePath)) return null;
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_INSTRUCTION_SIZE) return null;

    const rawContent = readFileSync(filePath, 'utf-8');
    const contentHash = createHash('sha256').update(rawContent).digest('hex');

    // Fast-path: return cached if content hash matches
    const cached = sourceCache.get(filePath);
    if (cached && cached.contentHash === contentHash) {
      return cached;
    }

    // Parse frontmatter
    const { frontmatter, body } = parseFrontmatter(rawContent);

    // Expand @includes in body
    const includes: string[] = [];
    const visited = new Set<string>([filePath]);
    const expanded = expandIncludes(body, dirname(filePath), visited, 0, includes);

    const source: InstructionSource = {
      tier,
      filePath,
      content: expanded,
      contentHash,
      frontmatter,
      includes,
    };
    sourceCache.set(filePath, source);
    return source;
  } catch {
    return null;
  }
}

// ── Glob matching ─────────────────────────────────────────────────────

/**
 * Minimal glob matcher — supports *, **, ?, [abc], {a,b}.
 * No external dependency; fast-path for common patterns.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  // Normalize separators
  const p = filePath.replace(/\\/g, '/');
  const g = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  let re = '^';
  let i = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        // ** matches anything including slashes
        if (g[i + 2] === '/') {
          re += '(?:.*/)?'; // **/ → 0+ directories
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) { re += '\\{'; i += 1; continue; }
      const options = g.slice(i + 1, end).split(',').map((o) => o.trim());
      re += `(?:${options.map((o) => o.replace(/[.+^$|()[\]\\]/g, '\\$&')).join('|')})`;
      i = end + 1;
    } else if (/[.+^$|()[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += '$';
  try {
    return new RegExp(re).test(p);
  } catch {
    return false;
  }
}

/** Check if a rule applies to the current task context (files + task type + action). */
function ruleAppliesToContext(rule: InstructionSource, ctx: InstructionContext): boolean {
  const fm = rule.frontmatter;
  const targetFiles = ctx.targetFiles ?? [];

  // Task type filter
  if (fm.taskTypes && fm.taskTypes.length > 0 && ctx.taskType) {
    if (!fm.taskTypes.includes(ctx.taskType)) return false;
  }

  // Action-verb filters
  if (ctx.actionVerb) {
    const verb = ctx.actionVerb.toLowerCase();
    if (fm.excludeActions?.some((a) => a.toLowerCase() === verb)) return false;
    if (fm.applyToActions && fm.applyToActions.length > 0) {
      if (!fm.applyToActions.some((a) => a.toLowerCase() === verb)) return false;
    }
  }

  // File-glob filter (applyTo)
  const applyTo = fm.applyTo;
  if (!applyTo || applyTo.length === 0) return true; // always-active rule
  if (targetFiles.length === 0) return false; // scoped rule, no scope to match

  for (const file of targetFiles) {
    for (const pattern of applyTo) {
      if (matchesGlob(file, pattern)) return true;
    }
  }
  return false;
}

// ── Tier discovery ────────────────────────────────────────────────────

/**
 * Discovery order for the M2 "project" tier.
 *
 * Ecosystem hospitality: Vinyan reads its own VINYAN.md first, but also
 * honors AGENTS.md (cross-ecosystem standard), CLAUDE.md (Claude Code),
 * and .github/copilot-instructions.md (VSCode Copilot) so existing repos
 * work without migration. Earlier files win on conflict, and Vinyan-specific
 * entries stay first to preserve Vinyan's semantics.
 */
const PROJECT_TIER_CANDIDATES = [
  'VINYAN.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.github/copilot-instructions.md',
] as const;

/**
 * Walk the workspace to find all instruction sources across tiers.
 * Does NOT apply filtering — that happens in resolveInstructions().
 */
function discoverSources(workspace: string): InstructionSource[] {
  const sources: InstructionSource[] = [];
  let discoveryIndex = 0;
  const push = (source: InstructionSource | null) => {
    if (source) sources.push({ ...source, discoveryIndex: discoveryIndex++ });
  };

  // M1: User preferences (cross-project)
  push(loadSource(join(homedir(), '.vinyan', 'preferences.md'), 'user'));

  // M2: Project root — Vinyan-native first, then ecosystem-compatible.
  for (const candidate of PROJECT_TIER_CANDIDATES) {
    push(loadSource(join(workspace, candidate), 'project'));
  }

  // M3: Scoped rules from Vinyan-native + Claude Code + Copilot locations.
  const scopedRuleDirs = [
    join(workspace, '.vinyan', 'rules'),
    join(workspace, '.claude', 'rules'),
    join(workspace, '.github', 'instructions'),
  ];
  for (const rulesDir of scopedRuleDirs) {
    if (!existsSync(rulesDir)) continue;
    try {
      const ruleFiles = walkMarkdownFiles(rulesDir);
      for (const ruleFile of ruleFiles) {
        push(loadSource(ruleFile, 'scoped-rule'));
      }
    } catch {
      // Silently skip unreadable rules dir
    }
  }

  // M4: Learned conventions (agent-proposed, human-reviewed)
  push(loadSource(join(workspace, '.vinyan', 'memory', 'learned.md'), 'learned'));

  return sources;
}

/** Recursively find all .md files in a directory. */
function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkMarkdownFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch {
    // Skip unreadable dirs
  }
  return results;
}

// ── Resolution (main API) ─────────────────────────────────────────────

/**
 * Resolve instruction memory for a specific task context.
 * This is the primary entry point — walks tier hierarchy, filters by applyTo,
 * sorts by priority, and returns a merged InstructionMemory.
 */
export function resolveInstructions(ctx: InstructionContext): InstructionMemory | null {
  // Cache key: (workspace + sorted target files + task type + action verb)
  const targetKey = (ctx.targetFiles ?? []).slice().sort().join('|');
  const cacheKey = `${ctx.workspace}\0${targetKey}\0${ctx.taskType ?? ''}\0${ctx.actionVerb ?? ''}`;

  // Check cache, but also invalidate if any source file has changed
  const allSources = discoverSources(ctx.workspace);
  const cached = resolvedCache.get(cacheKey);
  if (cached) {
    const cachedHashes = cached.sources.map((s) => s.contentHash).join('');
    const currentHashes = allSources.map((s) => s.contentHash).join('');
    if (cachedHashes === currentHashes) {
      return cached;
    }
  }

  if (allSources.length === 0) return null;

  // Filter rules by applyTo / taskType / action verb context
  const applicable = allSources.filter((s) => ruleAppliesToContext(s, ctx));
  if (applicable.length === 0) return null;

  // Sort by merge order:
  // 1. Tier precedence (user < project < scoped-rule < learned)
  // 2. Within tier, priority (lower first = earlier; later entries override)
  // 3. Within same tier+priority, alphabetical by path (stable order)
  const TIER_ORDER: Record<InstructionTier, number> = {
    user: 0,
    project: 1,
    'scoped-rule': 2,
    learned: 3,
  };
  applicable.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    const pa = a.frontmatter.priority ?? 50;
    const pb = b.frontmatter.priority ?? 50;
    if (pa !== pb) return pa - pb;
    // Preserve discovery order so PROJECT_TIER_CANDIDATES ordering is stable
    // (e.g., VINYAN.md comes before AGENTS.md even though A < V alphabetically).
    const ai = a.discoveryIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.discoveryIndex ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.filePath.localeCompare(b.filePath);
  });

  // Merge: concat content with tier headers. Enforce total size cap.
  const parts: string[] = [];
  let totalSize = 0;
  for (const source of applicable) {
    const header = buildSectionHeader(source);
    const piece = `${header}\n${source.content.trim()}`;
    if (totalSize + piece.length > MAX_MERGED_SIZE) {
      parts.push(`<!-- Instruction hierarchy truncated: ${applicable.length - parts.length} remaining sources omitted due to ${MAX_MERGED_SIZE}-byte cap -->`);
      break;
    }
    parts.push(piece);
    totalSize += piece.length + 2;
  }

  const merged = parts.join('\n\n');
  const contentHash = createHash('sha256').update(merged).digest('hex');
  const primaryPath = applicable.find((s) => s.tier === 'project')?.filePath
    ?? applicable[0]!.filePath;

  const result: InstructionMemory = {
    content: merged,
    contentHash,
    filePath: primaryPath,
    sources: applicable,
  };
  resolvedCache.set(cacheKey, result);
  return result;
}

/** Build a short section header for an instruction source. */
function buildSectionHeader(source: InstructionSource): string {
  const tierLabel = {
    user: 'USER PREFERENCES',
    project: 'PROJECT INSTRUCTIONS',
    'scoped-rule': 'SCOPED RULE',
    learned: 'LEARNED CONVENTIONS (agent-proposed, human-verified)',
  }[source.tier];
  const desc = source.frontmatter.description ? ` — ${source.frontmatter.description}` : '';
  const applyTo = source.frontmatter.applyTo?.length
    ? ` (applies to: ${source.frontmatter.applyTo.join(', ')})`
    : '';
  return `<!-- ${tierLabel}${desc}${applyTo} -->`;
}

// ── Backwards-compatible single-file loader ──────────────────────────

/**
 * Legacy single-file loader that resolveInstructions() wraps.
 * Kept for backwards compatibility with callers that only need VINYAN.md.
 * @deprecated Use resolveInstructions() for task-scoped resolution.
 */
export function loadInstructionMemoryLegacy(workspaceRoot: string): InstructionMemory | null {
  return resolveInstructions({ workspace: workspaceRoot });
}

/**
 * AGENT.md markdown loader (Round F — Claude Code drop-in compat).
 *
 * Scans `.claude/agents/<id>/AGENT.md` (project) and `~/.claude/agents/<id>/AGENT.md`
 * (user) for custom subagent definitions written in the format Claude Code uses.
 * Returns parsed `AgentSpecConfig` entries plus a map of in-memory soul strings
 * that the registry can apply when no Vinyan-native soul file is on disk.
 *
 * Format (matches Claude Code's AGENT.md convention):
 *
 *   ---
 *   description: One-line role summary (REQUIRED)
 *   name: Optional display name (derived from directory if missing)
 *   model: opus | sonnet | haiku            (informational; Vinyan routes by tier)
 *   tool-restrictions: true | false          (informational; v0 records but does not enforce)
 *   allowed-tools: [Read, Grep]              (becomes AgentSpecConfig.allowed_tools)
 *   skills: [refactor, lint]                 (informational; deferred)
 *   ---
 *
 *   System prompt instructions go here. The body content becomes the agent's
 *   soul (system prompt). Multi-paragraph markdown is fine.
 *
 * Path conventions accepted (id = directory name OR filename):
 *   - `<workspace>/.claude/agents/<id>/AGENT.md`     (CC nested-dir form)
 *   - `<workspace>/.claude/agents/<id>.md`           (CC flat-file form)
 *   - `~/.claude/agents/<id>/AGENT.md`               (user-level CC nested)
 *   - `~/.claude/agents/<id>.md`                     (user-level CC flat)
 *
 * Precedence (highest wins on id conflict):
 *   project (`.claude/agents/`) > user (`~/.claude/agents/`)
 *
 * Fail-soft: malformed YAML frontmatter or missing `description` logs a warning
 * and the file is skipped. A broken agent definition cannot block orchestrator
 * startup. `vinyan.json` `agents:` entries with the same id always win on the
 * outer merge inside `loadAgentRegistry`, so users can override AGENT.md
 * defaults without editing the markdown.
 *
 * Axioms: A3 (Deterministic Governance — pure file-system scan, no LLM in the
 * load path). The agent's soul is content, not behaviour; routing/governance
 * still flows through the existing risk-router + delegation-router gates.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentSpecConfig } from '../../config/schema.ts';

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
/** Lenient kebab-case-ish id matcher — same pattern as AgentSpecSchema. */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface MarkdownAgentSource {
  /** Path of the file the entry came from — used for diagnostics. */
  path: string;
  /** project = `<workspace>/.claude/agents/...`, user = `~/.claude/agents/...` */
  scope: 'project' | 'user';
}

export interface MarkdownAgentEntry {
  config: AgentSpecConfig;
  /** Body content of the markdown — becomes the agent's soul (system prompt). */
  soul: string;
  /** Source file the entry came from. */
  source: MarkdownAgentSource;
}

export interface ScanAgentMarkdownResult {
  /** Successfully parsed agent entries (project entries override user entries by id). */
  entries: MarkdownAgentEntry[];
  /** Files attempted, in scan order. Useful for tests + diagnostics. */
  attemptedPaths: string[];
  /** Files that were present but malformed. */
  invalidPaths: string[];
}

/**
 * Scan project + user-level `.claude/agents/` directories for AGENT.md files.
 *
 * Pure function — only filesystem reads. Returns parsed entries deduplicated
 * by id (project scope wins over user scope on conflict). Caller passes the
 * `entries[].config` array into `loadAgentRegistry()`'s `configAgents`
 * parameter, and the `entries[].soul` strings into the new `extraSouls` Map
 * so the registry can apply them after disk-soul lookup.
 */
export function scanAgentMarkdown(workspace: string): ScanAgentMarkdownResult {
  const attemptedPaths: string[] = [];
  const invalidPaths: string[] = [];
  const byId = new Map<string, MarkdownAgentEntry>();

  // User scope first — project entries below will overwrite on conflict.
  for (const dir of [join(homedir(), '.claude', 'agents'), join(workspace, '.claude', 'agents')]) {
    if (!existsSync(dir)) continue;
    const scope: 'project' | 'user' = dir.startsWith(workspace) ? 'project' : 'user';
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const candidate = resolveCandidate(dir, name);
      if (!candidate) continue;
      attemptedPaths.push(candidate.path);
      const parsed = readAndParse(candidate.path, candidate.id);
      if (!parsed) {
        invalidPaths.push(candidate.path);
        continue;
      }
      byId.set(candidate.id, { ...parsed, source: { path: candidate.path, scope } });
    }
  }

  return {
    entries: Array.from(byId.values()),
    attemptedPaths,
    invalidPaths,
  };
}

interface Candidate {
  id: string;
  path: string;
}

function resolveCandidate(dir: string, name: string): Candidate | null {
  // `.claude/agents/<id>/AGENT.md` — directory form
  const nestedPath = join(dir, name, 'AGENT.md');
  if (isFile(nestedPath) && ID_PATTERN.test(name)) {
    return { id: name, path: nestedPath };
  }
  // `.claude/agents/<id>.md` — flat-file form
  if (name.endsWith('.md')) {
    const id = name.slice(0, -3);
    if (ID_PATTERN.test(id)) {
      const flatPath = join(dir, name);
      if (isFile(flatPath)) return { id, path: flatPath };
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface ParsedFrontmatter {
  description?: unknown;
  name?: unknown;
  model?: unknown;
  'tool-restrictions'?: unknown;
  'allowed-tools'?: unknown;
  skills?: unknown;
  [key: string]: unknown;
}

function readAndParse(path: string, id: string): { config: AgentSpecConfig; soul: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.warn(`[vinyan] AGENT.md read failed at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    console.warn(`[vinyan] AGENT.md at ${path} has no YAML frontmatter — skipping`);
    return null;
  }

  let frontmatter: ParsedFrontmatter;
  try {
    const parsed = parseYaml(match[1] ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[vinyan] AGENT.md at ${path}: frontmatter is not an object — skipping`);
      return null;
    }
    frontmatter = parsed as ParsedFrontmatter;
  } catch (err) {
    console.warn(
      `[vinyan] AGENT.md frontmatter parse error at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (description.length === 0) {
    console.warn(`[vinyan] AGENT.md at ${path}: missing 'description' — skipping`);
    return null;
  }

  const allowedTools = toStringArray(frontmatter['allowed-tools']);
  const config: AgentSpecConfig = {
    id,
    name: typeof frontmatter.name === 'string' ? frontmatter.name : id,
    description,
    ...(allowedTools ? { allowed_tools: allowedTools } : {}),
  };

  const soul = (match[2] ?? '').trim();
  return { config, soul };
}

function toStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    // YAML scalar list: "Read Grep" or "Read,Grep"
    const items = value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

/** Build a `Map<id, soul>` from scan entries — convenient for `loadAgentRegistry`. */
export function soulsByIdFrom(entries: readonly MarkdownAgentEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) out.set(e.config.id, e.soul);
  return out;
}

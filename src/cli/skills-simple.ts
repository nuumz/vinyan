/**
 * `vinyan skills new|list|show|search|edit|remove|mode|install-system|install-examples`
 * — Claude-Code-style CLI for the hybrid skill redesign's simple layer.
 *
 * Authoring contract: drop a markdown file with `name + description` in the
 * frontmatter, the rest is body. No Zod schema, no tier ladder, no
 * version/hash/signature. Survives `vinyan skills mode` flips because the
 * file format is the same on disk; the loader is tolerant.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadSimpleSkills, parseFrontmatter, type SimpleSkill } from '../skills/simple/loader.ts';
import { matchSkillsForTask } from '../skills/simple/matcher.ts';

type Scope = 'user' | 'project';

interface CommandOptions {
  workspace: string;
  /**
   * Override the user-global `~/.vinyan/skills/` location. Mainly for tests
   * since Bun caches `os.homedir()` from process start and mutating
   * `process.env.HOME` at runtime does not change it. Production callers
   * leave this undefined.
   */
  userSkillsDir?: string;
}

export async function runSkillsSimpleCommand(args: readonly string[], opts: CommandOptions): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'new':
      return runNew(args.slice(1), opts);
    case 'list':
      return runList(args.slice(1), opts);
    case 'show':
      return runShow(args.slice(1), opts);
    case 'search':
      return runSearch(args.slice(1), opts);
    case 'edit':
      return runEdit(args.slice(1), opts);
    case 'remove':
    case 'rm':
    case 'delete':
      return runRemove(args.slice(1), opts);
    case 'mode':
      return runMode(args.slice(1), opts);
    case 'install-system':
      return runInstallSystem(args.slice(1), opts);
    case 'install-examples':
      return runInstallExamples(args.slice(1), opts);
    default:
      throw new Error(
        `Unknown skill subcommand '${sub}'. Available: new, list, show, search, edit, remove, mode, install-system, install-examples.`,
      );
  }
}

// ── `vinyan skills new <name>` ────────────────────────────────────────

function runNew(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) {
    throw new Error(
      'Usage: vinyan skills new <name> [--scope=user|project] [--agent=<id>] [--description="..."]',
    );
  }
  validateName(name);

  // Default scope changes based on --agent: per-agent skills land in user
  // scope by default (most useful — bind the persona machine-wide). Shared
  // skills default to project scope (existing behaviour).
  const agentId = flags.agent;
  if (agentId) validateAgentId(agentId);
  const defaultScope: Scope = agentId ? 'user' : 'project';
  const scope = parseScope(flags.scope ?? defaultScope);
  const description = flags.description ?? '';
  const skillDir = join(resolveSkillDir(scope, opts.workspace, agentId), name);

  if (existsSync(join(skillDir, 'SKILL.md'))) {
    throw new Error(
      `Skill '${name}' already exists at ${join(skillDir, 'SKILL.md')}. Edit it with 'vinyan skills edit ${name}${agentId ? ` --agent=${agentId}` : ''}'.`,
    );
  }

  mkdirSync(skillDir, { recursive: true });
  const template = `---
name: ${name}
description: ${description || `(write a 1-line description — when should this skill be invoked?)`}
---

# ${name}

(write the skill body here — markdown, no fixed structure required)

## When to use

(describe the situations where this skill applies)

## Procedure

1. (step one)
2. (step two)
`;
  const skillMdPath = join(skillDir, 'SKILL.md');
  writeFileSync(skillMdPath, template, 'utf-8');
  const scopeLabel = agentId ? `${scope}-agent (${agentId})` : scope;
  console.log(`Created ${skillMdPath} (scope: ${scopeLabel})`);

  if (!flags['no-edit']) {
    openEditor(skillMdPath);
  }
}

// ── `vinyan skills list` ──────────────────────────────────────────────

function runList(args: readonly string[], opts: CommandOptions): void {
  const { flags } = parseArgs(args);
  const scopeFilter = flags.scope ? parseScope(flags.scope) : null;
  const agentFilter = flags.agent;
  if (agentFilter && agentFilter !== 'ALL') validateAgentId(agentFilter);

  const result = loadSimpleSkills({
    workspace: opts.workspace,
    ...(opts.userSkillsDir !== undefined ? { userSkillsDir: opts.userSkillsDir } : {}),
  });
  let filtered = result.skills;
  if (agentFilter === 'ALL') {
    // Pass — show every skill including all per-agent variants.
  } else if (agentFilter) {
    // Show shared + this agent's per-agent skills only.
    filtered = filtered.filter(
      (s) =>
        s.scope === 'user' || s.scope === 'project' || s.agentId === agentFilter,
    );
  } else {
    // Default: shared scopes only — backward-compat with pre-per-agent CLI.
    filtered = filtered.filter((s) => s.scope === 'user' || s.scope === 'project');
  }
  if (scopeFilter) {
    if (agentFilter && agentFilter !== 'ALL') {
      filtered = filtered.filter((s) => {
        if (s.scope === 'user' || s.scope === 'project') return s.scope === scopeFilter;
        return scopeFilter === 'user' ? s.scope === 'user-agent' : s.scope === 'project-agent';
      });
    } else {
      filtered = filtered.filter((s) => s.scope === scopeFilter);
    }
  }

  if (filtered.length === 0) {
    const where = scopeFilter ? `${scopeFilter}-scope` : 'either scope';
    const ag = agentFilter && agentFilter !== 'ALL' ? ` for agent '${agentFilter}'` : '';
    console.log(`No simple skills found in ${where}${ag}.`);
    const flagHint = [scopeFilter ? ` --scope=${scopeFilter}` : '', agentFilter && agentFilter !== 'ALL' ? ` --agent=${agentFilter}` : ''].join('');
    console.log(`Create one: vinyan skills new <name>${flagHint}`);
    return;
  }

  // Pretty table.
  const nameWidth = Math.max(4, ...filtered.map((s) => s.name.length));
  const scopeWidth = Math.max(7, ...filtered.map((s) => s.scope.length));
  const agentWidth = Math.max(5, ...filtered.map((s) => (s.agentId ?? '').length));
  console.log(
    `${'NAME'.padEnd(nameWidth)}  ${'SCOPE'.padEnd(scopeWidth)}  ${'AGENT'.padEnd(agentWidth)}  DESCRIPTION`,
  );
  for (const skill of filtered) {
    const desc = truncate(skill.description, 80);
    const agent = skill.agentId ?? '-';
    console.log(
      `${skill.name.padEnd(nameWidth)}  ${skill.scope.padEnd(scopeWidth)}  ${agent.padEnd(agentWidth)}  ${desc}`,
    );
  }
  if (result.failedNames.length > 0) {
    console.warn(`\n[skill:list] ${result.failedNames.length} skill(s) failed to load: ${result.failedNames.join(', ')}`);
  }
}

// ── `vinyan skills show <name>` ───────────────────────────────────────

function runShow(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error('Usage: vinyan skills show <name> [--agent=<id>]');

  const findOpts: FindByNameOptions = {};
  if (flags.agent) {
    validateAgentId(flags.agent);
    findOpts.agent = flags.agent;
  }
  if (opts.userSkillsDir !== undefined) findOpts.userSkillsDir = opts.userSkillsDir;
  const skill = findByName(name, opts.workspace, findOpts);
  if (!skill) {
    const where = flags.agent ? ` for agent '${flags.agent}'` : '';
    throw new Error(`Skill '${name}'${where} not found. Run 'vinyan skills list${flags.agent ? ` --agent=${flags.agent}` : ''}' to see available skills.`);
  }

  console.log(`name: ${skill.name}`);
  console.log(`scope: ${skill.scope}`);
  if (skill.agentId) console.log(`agent: ${skill.agentId}`);
  console.log(`path: ${skill.path}`);
  console.log(`description: ${skill.description}`);
  console.log('');
  console.log(skill.body.trimEnd());
}

// ── `vinyan skills search <query>` ────────────────────────────────────

function runSearch(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ').trim();
  if (!query) throw new Error('Usage: vinyan skills search <query terms> [--agent=<id>] [--top-k=N]');

  const result = loadSimpleSkills({
    workspace: opts.workspace,
    ...(opts.userSkillsDir !== undefined ? { userSkillsDir: opts.userSkillsDir } : {}),
  });
  let pool = result.skills;
  if (flags.agent) {
    validateAgentId(flags.agent);
    // Mirror dispatch-time visibility: shared + this agent's per-agent skills.
    pool = pool.filter(
      (s) => s.scope === 'user' || s.scope === 'project' || s.agentId === flags.agent,
    );
  } else {
    // Default to shared scopes only — no random per-agent variants leaking
    // into a query that didn't ask for them.
    pool = pool.filter((s) => s.scope === 'user' || s.scope === 'project');
  }

  if (pool.length === 0) {
    console.log('No simple skills available to search. Create one: vinyan skills new <name>');
    return;
  }

  const topK = flags['top-k'] ? Number.parseInt(flags['top-k'], 10) : 5;
  const matches = matchSkillsForTask(query, pool, { topK });
  if (matches.length === 0) {
    console.log(`No skills matched '${query}' above the default threshold.`);
    return;
  }

  console.log(`Top ${matches.length} match(es) for: ${query}`);
  for (const m of matches) {
    const ag = m.skill.agentId ? `, ${m.skill.agentId}` : '';
    console.log(
      `  ${m.score.toFixed(3)}  ${m.skill.name}  (${m.skill.scope}${ag})  — ${truncate(m.skill.description, 80)}`,
    );
  }
}

// ── `vinyan skills edit <name>` ───────────────────────────────────────

function runEdit(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error('Usage: vinyan skills edit <name> [--agent=<id>]');
  const findOpts: FindByNameOptions = {};
  if (flags.agent) {
    validateAgentId(flags.agent);
    findOpts.agent = flags.agent;
  }
  if (opts.userSkillsDir !== undefined) findOpts.userSkillsDir = opts.userSkillsDir;
  const skill = findByName(name, opts.workspace, findOpts);
  if (!skill) {
    const where = flags.agent ? ` for agent '${flags.agent}'` : '';
    throw new Error(`Skill '${name}'${where} not found.`);
  }
  openEditor(skill.path);
}

// ── `vinyan skills remove <name>` ─────────────────────────────────────

function runRemove(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) {
    throw new Error('Usage: vinyan skills remove <name> [--scope=user|project] [--agent=<id>] [--force]');
  }
  const findOpts: FindByNameOptions = {};
  if (flags.scope) findOpts.scope = parseScope(flags.scope);
  if (flags.agent) {
    validateAgentId(flags.agent);
    findOpts.agent = flags.agent;
  }
  if (opts.userSkillsDir !== undefined) findOpts.userSkillsDir = opts.userSkillsDir;
  const skill = findByName(name, opts.workspace, findOpts);
  if (!skill) {
    const where = flags.agent ? ` for agent '${flags.agent}'` : '';
    throw new Error(`Skill '${name}'${where} not found.`);
  }

  if (!flags.force) {
    console.log(`Will delete: ${skill.path}`);
    console.log(`Re-run with --force to confirm.`);
    return;
  }
  rmSync(dirname(skill.path), { recursive: true, force: true });
  console.log(`Removed ${skill.path}`);
}

// ── `vinyan skills mode <simple|epistemic|both>` ─────────────────────

function runMode(args: readonly string[], opts: CommandOptions): void {
  const target = args[0];
  if (!target) {
    // Read current mode from vinyan.json
    const cfgPath = join(opts.workspace, 'vinyan.json');
    if (!existsSync(cfgPath)) {
      console.log("mode: simple (no vinyan.json — default)");
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { skills?: { mode?: string } };
      console.log(`mode: ${raw.skills?.mode ?? 'simple (default)'}`);
    } catch (err) {
      throw new Error(`Failed to read vinyan.json: ${(err as Error).message}`);
    }
    return;
  }

  if (target !== 'simple' && target !== 'epistemic' && target !== 'both') {
    throw new Error(`Invalid mode '${target}'. Choose one of: simple, epistemic, both.`);
  }

  const cfgPath = join(opts.workspace, 'vinyan.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to read vinyan.json: ${(err as Error).message}`);
    }
  }
  const skills = (cfg.skills as Record<string, unknown> | undefined) ?? {};
  skills.mode = target;
  cfg.skills = skills;
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
  console.log(`Skills mode set to '${target}' in ${cfgPath}`);
  console.log(`Restart any running 'vinyan serve' for the change to take effect.`);
}

// ── helpers ───────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

// Bare boolean flags (no value expected). We treat the presence of these as
// truthy regardless of what comes after — `--force --scope=user` should not
// swallow `--scope=user` as the value of `--force`.
const BARE_FLAGS = new Set(['force', 'no-edit', 'prune-old-starters']);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BARE_FLAGS.has(key)) {
        flags[key] = 'true';
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[key] = 'true';
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseScope(value: string): Scope {
  if (value === 'user' || value === 'project') return value;
  throw new Error(`Invalid scope '${value}'. Choose one of: user, project.`);
}

function scopeDir(scope: Scope, workspace: string): string {
  return scope === 'user' ? join(homedir(), '.vinyan', 'skills') : join(workspace, '.vinyan', 'skills');
}

/**
 * Resolve the on-disk skill directory for a (scope, agent) tuple. When
 * `agentId` is supplied, routes to the per-agent dir
 * (`<root>/.vinyan/agents/<agentId>/skills/`); otherwise to the shared dir.
 */
function resolveSkillDir(scope: Scope, workspace: string, agentId: string | undefined): string {
  const root = scope === 'user' ? homedir() : workspace;
  if (agentId) {
    validateAgentId(agentId);
    return join(root, '.vinyan', 'agents', agentId, 'skills');
  }
  return join(root, '.vinyan', 'skills');
}

function validateName(name: string): void {
  // 1 required leading [a-z0-9] + up to 63 more [a-z0-9_-] = 1–64 chars total
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      `Invalid skill name '${name}'. Use lowercase letters, digits, '-', '_'; start with a letter/digit; max 64 chars.`,
    );
  }
}

function validateAgentId(agentId: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    throw new Error(
      `Invalid agent id '${agentId}'. Use lowercase letters, digits, '-', '_'; start with a letter/digit; max 64 chars.`,
    );
  }
}

interface FindByNameOptions {
  /** Restrict to a single shared scope. */
  scope?: Scope;
  /**
   * Restrict to a specific agent's per-agent skills. Set to `'shared'` to
   * exclude per-agent dirs entirely; default is "any scope, any agent" so
   * `vinyan skills show <name>` can find a skill the user just created
   * without making them remember which scope/agent it lives under.
   */
  agent?: string | 'shared';
  /** Test override for the user-global skills dir. */
  userSkillsDir?: string;
}

function findByName(
  name: string,
  workspace: string,
  opts: FindByNameOptions = {},
): SimpleSkill | null {
  const result = loadSimpleSkills({
    workspace,
    ...(opts.userSkillsDir !== undefined ? { userSkillsDir: opts.userSkillsDir } : {}),
  });
  let candidates = result.skills;
  if (opts.agent === 'shared') {
    candidates = candidates.filter((s) => s.scope === 'user' || s.scope === 'project');
  } else if (opts.agent) {
    candidates = candidates.filter((s) => s.agentId === opts.agent);
  }
  if (opts.scope) {
    // Scope filter applies to the SHARED scopes only; per-agent variants are
    // matched by agent id above. Combining `--scope=user --agent=...` filters
    // to user-agent.
    if (opts.agent && opts.agent !== 'shared') {
      candidates = candidates.filter((s) =>
        opts.scope === 'user' ? s.scope === 'user-agent' : s.scope === 'project-agent',
      );
    } else {
      candidates = candidates.filter((s) => s.scope === opts.scope);
    }
  }
  return candidates.find((s) => s.name === name) ?? null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function openEditor(path: string): void {
  const editor = process.env.VISUAL ?? process.env.EDITOR;
  if (!editor) {
    console.log(`Edit: ${path}`);
    console.log('(set $EDITOR or $VISUAL to auto-open the file in your editor)');
    return;
  }
  // Fork the user's editor in the same TTY so they can edit interactively.
  const [bin, ...editorArgs] = editor.split(/\s+/);
  if (!bin) {
    console.log(`Edit: ${path}`);
    return;
  }
  const result = spawnSync(bin, [...editorArgs, path], { stdio: 'inherit' });
  if (result.error) {
    console.warn(`[skill:edit] could not launch ${editor}: ${result.error.message}`);
    console.log(`Edit: ${path}`);
  }
}

// Internal: re-export helpers used by `runFrontmatterParse` if anything wants
// to consume parseFrontmatter for downstream tooling.
export { parseFrontmatter };

// ── system-skill seeding ──────────────────────────────────────────────

/**
 * Default system-skill pack shipped with Vinyan. These are broad cognitive
 * scaffolds (intake, decomposition, dispatch, evidence, planning, verification,
 * review, recovery, output, learning, governance, budget, collaboration) — NOT
 * domain or language-specific skills. They live as plain SimpleSkills under
 * `~/.vinyan/skills/<name>/` after seeding; users can edit, override, or
 * remove them like any other skill.
 *
 * Domain-specific examples (the retired `code-review`/`debug-trace`/
 * `git-commit-message`/`unit-test-plan` pack) live under
 * `templates/examples/skills/` and ship via the opt-in
 * `vinyan skills install-examples` subcommand.
 */
export const SYSTEM_SKILL_NAMES = [
  'workflow-intake',
  'task-decomposition',
  'persona-dispatch',
  'capability-mapping',
  'evidence-gathering',
  'planning-contract',
  'verification-strategy',
  'reviewer-brief',
  'recovery-replan',
  'output-contract',
  'learning-capture',
  'governance-guardrails',
  'budget-and-scope',
  'collaboration-room',
] as const;

/**
 * Names retired from the default pack on 2026-04-30 — moved to
 * `templates/examples/skills/`. `install-system --prune-old-starters` may
 * remove them from a user's dir, but only when the file content matches the
 * bundled example byte-for-byte (so user-customised copies are left alone).
 */
export const RETIRED_STARTER_NAMES = [
  'code-review',
  'debug-trace',
  'git-commit-message',
  'unit-test-plan',
] as const;

/** Maximum directory levels to walk up when searching for `templates/`. */
const MAX_TEMPLATE_SEARCH_DEPTH = 6;

/**
 * Locate a bundled templates subdirectory by walking up from this file's
 * location until it finds a sibling `templates/<...subPath>` (works in both
 * source and shipped builds). Shared by `vinyan init`, `install-system`, and
 * `install-examples`.
 */
export function locateBundledSkillsDir(
  ...subPath: readonly string[]
): string | null {
  const startDir = dirname(fileURLToPath(import.meta.url));
  let cur = startDir;
  for (let i = 0; i < MAX_TEMPLATE_SEARCH_DEPTH; i++) {
    const candidate = join(cur, 'templates', ...subPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Idempotent first-init seeder: if `~/.vinyan/skills/` is missing OR has zero
 * entries, seed it with the bundled system-skill pack. Skips when the user
 * has already populated the directory so we never overwrite.
 *
 * Called from `vinyan init`. Existing users who already have skills (the old
 * starter pack or anything else) do NOT get the system pack auto-installed —
 * they run `vinyan skills install-system` explicitly.
 */
export function ensureSystemSkillPack(templatesRoot: string, userSkillsDir: string): {
  copied: readonly string[];
  reason?: string;
} {
  if (!existsSync(templatesRoot)) {
    return { copied: [], reason: `templates dir missing at ${templatesRoot}` };
  }
  const existingNames = existsSync(userSkillsDir)
    ? readdirSync(userSkillsDir).filter((entry) => {
        try {
          return statSync(join(userSkillsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  if (existingNames.length > 0) {
    return { copied: [], reason: 'user-global dir already populated — refusing to overwrite' };
  }
  mkdirSync(userSkillsDir, { recursive: true });
  const copied: string[] = [];
  for (const name of SYSTEM_SKILL_NAMES) {
    const src = join(templatesRoot, name, 'SKILL.md');
    if (!existsSync(src)) continue;
    const dstDir = join(userSkillsDir, name);
    mkdirSync(dstDir, { recursive: true });
    writeFileSync(join(dstDir, 'SKILL.md'), readFileSync(src, 'utf-8'), 'utf-8');
    copied.push(name);
  }
  return { copied };
}

export interface InstallSkillsResult {
  readonly copied: readonly string[];
  readonly skipped: readonly { name: string; reason: string }[];
}

interface InstallOptions {
  /** Overwrite existing same-name skills. Default false. */
  readonly force?: boolean;
}

/**
 * Operator-driven name-by-name installer for the system-skill pack. Skips
 * names that already exist on disk unless `force` is set. Used by
 * `vinyan skills install-system` so existing users who upgraded from the old
 * starter pack can opt in without losing customisations.
 */
export function installSystemSkills(
  templatesRoot: string,
  userSkillsDir: string,
  opts: InstallOptions = {},
): InstallSkillsResult {
  return installNamedSkills(templatesRoot, userSkillsDir, SYSTEM_SKILL_NAMES, opts);
}

/**
 * Operator-driven installer for the retired example pack
 * (`code-review`/`debug-trace`/`git-commit-message`/`unit-test-plan`). Same
 * semantics as `installSystemSkills`. Lets users opt back in to the old
 * code-centric starters after the redesign.
 */
export function installExampleSkills(
  examplesRoot: string,
  userSkillsDir: string,
  opts: InstallOptions = {},
): InstallSkillsResult {
  return installNamedSkills(examplesRoot, userSkillsDir, RETIRED_STARTER_NAMES, opts);
}

function installNamedSkills(
  templatesRoot: string,
  userSkillsDir: string,
  names: readonly string[],
  opts: InstallOptions,
): InstallSkillsResult {
  if (!existsSync(templatesRoot)) {
    return {
      copied: [],
      skipped: names.map((name) => ({ name, reason: `templates dir missing at ${templatesRoot}` })),
    };
  }
  mkdirSync(userSkillsDir, { recursive: true });
  const copied: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of names) {
    const src = join(templatesRoot, name, 'SKILL.md');
    if (!existsSync(src)) {
      skipped.push({ name, reason: 'template missing' });
      continue;
    }
    const dstDir = join(userSkillsDir, name);
    const dstFile = join(dstDir, 'SKILL.md');
    if (existsSync(dstFile) && !opts.force) {
      skipped.push({ name, reason: 'already exists (use --force to overwrite)' });
      continue;
    }
    mkdirSync(dstDir, { recursive: true });
    writeFileSync(dstFile, readFileSync(src, 'utf-8'), 'utf-8');
    copied.push(name);
  }
  return { copied, skipped };
}

/**
 * Remove retired starter skills from the user's dir IF the on-disk content
 * matches the bundled example byte-for-byte. User-customised copies are left
 * alone. Returns the set of names actually removed and those skipped (with
 * reason).
 */
export function pruneRetiredStarters(
  examplesRoot: string,
  userSkillsDir: string,
): { removed: readonly string[]; skipped: readonly { name: string; reason: string }[] } {
  const removed: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of RETIRED_STARTER_NAMES) {
    const dstFile = join(userSkillsDir, name, 'SKILL.md');
    if (!existsSync(dstFile)) {
      skipped.push({ name, reason: 'not present' });
      continue;
    }
    const exemplar = join(examplesRoot, name, 'SKILL.md');
    if (!existsSync(exemplar)) {
      skipped.push({ name, reason: 'no bundled exemplar to compare — refusing to delete' });
      continue;
    }
    const onDisk = readFileSync(dstFile, 'utf-8');
    const bundled = readFileSync(exemplar, 'utf-8');
    if (onDisk !== bundled) {
      skipped.push({ name, reason: 'content differs from bundled exemplar — user-customised; refusing to delete' });
      continue;
    }
    rmSync(join(userSkillsDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return { removed, skipped };
}

// ── `vinyan skills install-system` ────────────────────────────────────

function runInstallSystem(args: readonly string[], opts: CommandOptions): void {
  const { flags } = parseArgs(args);
  const userSkillsDir = flags['user-dir'] ?? opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
  const templatesRoot = locateBundledSkillsDir('skills');
  if (!templatesRoot) {
    throw new Error(
      'Could not locate bundled templates/skills/ directory next to the Vinyan install. Reinstall or run from the source tree.',
    );
  }

  const force = flags.force === 'true';
  const result = installSystemSkills(templatesRoot, userSkillsDir, { force });

  console.log(`System-skill install → ${userSkillsDir}`);
  if (result.copied.length > 0) {
    console.log(`Installed (${result.copied.length}): ${result.copied.join(', ')}`);
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped (${result.skipped.length}):`);
    for (const s of result.skipped) {
      console.log(`  - ${s.name}: ${s.reason}`);
    }
  }
  if (result.copied.length === 0 && result.skipped.every((s) => s.reason.startsWith('already exists'))) {
    console.log('All system skills already present. Re-run with --force to overwrite.');
  }

  // Optional pruning of retired starters.
  if (flags['prune-old-starters'] === 'true') {
    const examplesRoot = locateBundledSkillsDir('examples', 'skills');
    if (!examplesRoot) {
      console.warn('[skill:install-system] cannot locate templates/examples/skills/ — skipping prune step.');
      return;
    }
    const pr = pruneRetiredStarters(examplesRoot, userSkillsDir);
    if (pr.removed.length > 0) {
      console.log(`Pruned retired starters (${pr.removed.length}): ${pr.removed.join(', ')}`);
    }
    const skippedKept = pr.skipped.filter((s) => !s.reason.startsWith('not present'));
    if (skippedKept.length > 0) {
      console.log('Kept (user-customised or no exemplar):');
      for (const s of skippedKept) {
        console.log(`  - ${s.name}: ${s.reason}`);
      }
    }
  }
}

// ── `vinyan skills install-examples` ──────────────────────────────────

function runInstallExamples(args: readonly string[], opts: CommandOptions): void {
  const { flags } = parseArgs(args);
  const userSkillsDir = flags['user-dir'] ?? opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
  const examplesRoot = locateBundledSkillsDir('examples', 'skills');
  if (!examplesRoot) {
    throw new Error(
      'Could not locate bundled templates/examples/skills/ directory next to the Vinyan install. Reinstall or run from the source tree.',
    );
  }

  const force = flags.force === 'true';
  const result = installExampleSkills(examplesRoot, userSkillsDir, { force });

  console.log(`Example-skill install → ${userSkillsDir}`);
  if (result.copied.length > 0) {
    console.log(`Installed (${result.copied.length}): ${result.copied.join(', ')}`);
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped (${result.skipped.length}):`);
    for (const s of result.skipped) {
      console.log(`  - ${s.name}: ${s.reason}`);
    }
  }
  if (result.copied.length === 0 && result.skipped.every((s) => s.reason.startsWith('already exists'))) {
    console.log('All example skills already present. Re-run with --force to overwrite.');
  }
}

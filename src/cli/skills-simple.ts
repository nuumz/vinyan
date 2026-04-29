/**
 * `vinyan skills new|list|show|search|edit|mode` — Claude-Code-style CLI
 * for the hybrid skill redesign's simple layer.
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

import { loadSimpleSkills, parseFrontmatter, type SimpleSkill } from '../skills/simple/loader.ts';
import { matchSkillsForTask } from '../skills/simple/matcher.ts';

type Scope = 'user' | 'project';

interface CommandOptions {
  workspace: string;
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
    default:
      throw new Error(
        `Unknown skill subcommand '${sub}'. Available: new, list, show, search, edit, remove, mode.`,
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

  const result = loadSimpleSkills({ workspace: opts.workspace });
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

  const result = loadSimpleSkills({ workspace: opts.workspace });
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
const BARE_FLAGS = new Set(['force', 'no-edit']);

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
}

function findByName(
  name: string,
  workspace: string,
  opts: FindByNameOptions = {},
): SimpleSkill | null {
  const result = loadSimpleSkills({ workspace });
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

// ── starter pack copy on first init ───────────────────────────────────

const STARTER_NAMES = ['code-review', 'debug-trace', 'git-commit-message', 'unit-test-plan'] as const;

/**
 * Idempotent copy: if `~/.vinyan/skills/` is missing OR has zero entries,
 * seed it with the bundled starter pack from `templates/skills/`. Skips when
 * the user has already populated the directory so we never overwrite.
 *
 * Called from `vinyan init` and from factory boot (if user-global dir is
 * empty on first `vinyan run`).
 */
export function ensureStarterPack(templatesRoot: string, userSkillsDir: string): {
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
  for (const name of STARTER_NAMES) {
    const src = join(templatesRoot, name, 'SKILL.md');
    if (!existsSync(src)) continue;
    const dstDir = join(userSkillsDir, name);
    mkdirSync(dstDir, { recursive: true });
    writeFileSync(join(dstDir, 'SKILL.md'), readFileSync(src, 'utf-8'), 'utf-8');
    copied.push(name);
  }
  return { copied };
}

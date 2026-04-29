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
  if (!name) throw new Error('Usage: vinyan skills new <name> [--scope=user|project] [--description="..."]');
  validateName(name);

  const scope = parseScope(flags.scope ?? 'project');
  const description = flags.description ?? '';
  const skillDir = join(scopeDir(scope, opts.workspace), name);

  if (existsSync(join(skillDir, 'SKILL.md'))) {
    throw new Error(
      `Skill '${name}' already exists at ${join(skillDir, 'SKILL.md')}. Edit it with 'vinyan skills edit ${name}'.`,
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
  console.log(`Created ${skillMdPath} (scope: ${scope})`);

  if (!flags['no-edit']) {
    openEditor(skillMdPath);
  }
}

// ── `vinyan skills list` ──────────────────────────────────────────────

function runList(args: readonly string[], opts: CommandOptions): void {
  const { flags } = parseArgs(args);
  const scopeFilter = flags.scope ? parseScope(flags.scope) : null;

  const result = loadSimpleSkills({ workspace: opts.workspace });
  const filtered = scopeFilter ? result.skills.filter((s) => s.scope === scopeFilter) : result.skills;

  if (filtered.length === 0) {
    const where = scopeFilter ? `${scopeFilter}-scope` : 'either scope';
    console.log(`No simple skills found in ${where}.`);
    console.log(`Create one: vinyan skills new <name>${scopeFilter ? ` --scope=${scopeFilter}` : ''}`);
    return;
  }

  // Pretty table.
  const nameWidth = Math.max(4, ...filtered.map((s) => s.name.length));
  const scopeWidth = 7;
  console.log(`${'NAME'.padEnd(nameWidth)}  ${'SCOPE'.padEnd(scopeWidth)}  DESCRIPTION`);
  for (const skill of filtered) {
    const desc = truncate(skill.description, 80);
    console.log(`${skill.name.padEnd(nameWidth)}  ${skill.scope.padEnd(scopeWidth)}  ${desc}`);
  }
  if (result.failedNames.length > 0) {
    console.warn(`\n[skill:list] ${result.failedNames.length} skill(s) failed to load: ${result.failedNames.join(', ')}`);
  }
}

// ── `vinyan skills show <name>` ───────────────────────────────────────

function runShow(args: readonly string[], opts: CommandOptions): void {
  const { positional } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error('Usage: vinyan skills show <name>');

  const skill = findByName(name, opts.workspace);
  if (!skill) {
    throw new Error(`Skill '${name}' not found. Run 'vinyan skills list' to see available skills.`);
  }

  console.log(`name: ${skill.name}`);
  console.log(`scope: ${skill.scope}`);
  console.log(`path: ${skill.path}`);
  console.log(`description: ${skill.description}`);
  console.log('');
  console.log(skill.body.trimEnd());
}

// ── `vinyan skills search <query>` ────────────────────────────────────

function runSearch(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const query = positional.join(' ').trim();
  if (!query) throw new Error('Usage: vinyan skills search <query terms>');

  const result = loadSimpleSkills({ workspace: opts.workspace });
  if (result.skills.length === 0) {
    console.log('No simple skills available to search. Create one: vinyan skills new <name>');
    return;
  }

  const topK = flags['top-k'] ? Number.parseInt(flags['top-k'], 10) : 5;
  const matches = matchSkillsForTask(query, result.skills, { topK });
  if (matches.length === 0) {
    console.log(`No skills matched '${query}' above the default threshold.`);
    return;
  }

  console.log(`Top ${matches.length} match(es) for: ${query}`);
  for (const m of matches) {
    console.log(`  ${m.score.toFixed(3)}  ${m.skill.name}  (${m.skill.scope})  — ${truncate(m.skill.description, 80)}`);
  }
}

// ── `vinyan skills edit <name>` ───────────────────────────────────────

function runEdit(args: readonly string[], opts: CommandOptions): void {
  const { positional } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error('Usage: vinyan skills edit <name>');
  const skill = findByName(name, opts.workspace);
  if (!skill) throw new Error(`Skill '${name}' not found.`);
  openEditor(skill.path);
}

// ── `vinyan skills remove <name>` ─────────────────────────────────────

function runRemove(args: readonly string[], opts: CommandOptions): void {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error('Usage: vinyan skills remove <name> [--scope=user|project] [--force]');
  const skill = findByName(name, opts.workspace, flags.scope ? parseScope(flags.scope) : undefined);
  if (!skill) throw new Error(`Skill '${name}' not found.`);

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

function validateName(name: string): void {
  // 1 required leading [a-z0-9] + up to 63 more [a-z0-9_-] = 1–64 chars total
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(
      `Invalid skill name '${name}'. Use lowercase letters, digits, '-', '_'; start with a letter/digit; max 64 chars.`,
    );
  }
}

function findByName(name: string, workspace: string, scope?: Scope): SimpleSkill | null {
  const result = loadSimpleSkills({ workspace });
  const candidates = scope ? result.skills.filter((s) => s.scope === scope) : result.skills;
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

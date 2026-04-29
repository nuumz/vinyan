/**
 * vinyan init — detect project type and generate vinyan.json with sensible defaults.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { VinyanConfig } from '../config/schema.ts';
import { ensureStarterPack } from './skills-simple.ts';

interface ProjectInfo {
  hasTypeScript: boolean;
  hasPython: boolean;
  hasGo: boolean;
  hasRust: boolean;
  hasJava: boolean;
  hasPackageJson: boolean;
}

/** Detect project type by checking for common config files. */
function detectProject(workspacePath: string): ProjectInfo {
  return {
    hasTypeScript: existsSync(join(workspacePath, 'tsconfig.json')),
    hasPython: existsSync(join(workspacePath, 'pyproject.toml')) || existsSync(join(workspacePath, 'setup.py')) || existsSync(join(workspacePath, 'requirements.txt')),
    hasGo: existsSync(join(workspacePath, 'go.mod')),
    hasRust: existsSync(join(workspacePath, 'Cargo.toml')),
    hasJava: existsSync(join(workspacePath, 'pom.xml')) || existsSync(join(workspacePath, 'build.gradle')) || existsSync(join(workspacePath, 'build.gradle.kts')),
    hasPackageJson: existsSync(join(workspacePath, 'package.json')),
  };
}

/** Build a vinyan.json config based on detected project type. Phase 0 only. */
function buildConfig(project: ProjectInfo): VinyanConfig {
  const languages: string[] = [];
  if (project.hasTypeScript) languages.push('typescript');
  if (project.hasPython) languages.push('python');
  if (project.hasGo) languages.push('go');
  if (project.hasRust) languages.push('rust');
  if (project.hasJava) languages.push('java');
  if (languages.length === 0) languages.push('typescript'); // default

  const oracles: VinyanConfig['oracles'] = {
    ast: { enabled: true, languages, tier: 'deterministic', timeout_behavior: 'block' },
    dep: { enabled: true, tier: 'heuristic', timeout_behavior: 'block' },
  };

  // Language-specific oracles
  if (project.hasTypeScript) {
    oracles.type = { enabled: true, command: 'tsc --noEmit', tier: 'deterministic', timeout_behavior: 'block' };
  }
  if (project.hasGo) {
    oracles.go = { enabled: true, command: 'go vet ./...', tier: 'deterministic', timeout_behavior: 'warn' };
  }
  if (project.hasRust) {
    oracles.rust = { enabled: true, command: 'cargo check', tier: 'deterministic', timeout_behavior: 'warn' };
  }
  if (project.hasPython) {
    oracles.python = { enabled: true, command: 'python -m py_compile', tier: 'heuristic', timeout_behavior: 'warn' };
  }

  // The built-in role-pure persona roster (coordinator, developer, architect,
  // author, reviewer, assistant) is provided by the registry without needing
  // entries in vinyan.json. Users add custom agents via `vinyan agent create`
  // or by editing vinyan.json directly. Domain specialization (TypeScript,
  // fiction, etc.) arrives via skill packs, not new persona ids.
  return {
    version: 1,
    oracles,
  };
}

export interface InitResult {
  created: boolean;
  configPath: string;
  reason?: string;
  starterPackCopied?: readonly string[];
}

/** Maximum directory levels to walk up when searching for `templates/skills/`. */
const MAX_TEMPLATE_SEARCH_DEPTH = 6;

/**
 * Locate the bundled `templates/skills/` directory. Walks up from this file's
 * location until it finds a sibling `templates/` (works in both source and
 * shipped builds).
 */
function locateTemplatesDir(): string | null {
  const startDir = dirname(fileURLToPath(import.meta.url));
  let cur = startDir;
  for (let i = 0; i < MAX_TEMPLATE_SEARCH_DEPTH; i++) {
    const candidate = join(cur, 'templates', 'skills');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export interface InitOptions {
  /** Overwrite existing vinyan.json. */
  force?: boolean;
  /**
   * Override the user-global `~/.vinyan/skills/` location for starter pack
   * seeding. Mainly for tests so they don't pollute the real home dir.
   * Set to `false` to skip starter-pack seeding entirely.
   */
  userSkillsDir?: string | false;
}

/**
 * Initialize vinyan.json in the given workspace.
 * @param workspacePath - Where to create vinyan.json.
 * @param optsOrForce - Either an options bag or a legacy `force` boolean.
 */
export function init(workspacePath: string, optsOrForce: InitOptions | boolean = false): InitResult {
  const opts: InitOptions = typeof optsOrForce === 'boolean' ? { force: optsOrForce } : optsOrForce;
  const configPath = join(workspacePath, 'vinyan.json');

  if (existsSync(configPath) && !opts.force) {
    return { created: false, configPath, reason: 'vinyan.json already exists (use --force to overwrite)' };
  }

  const project = detectProject(workspacePath);
  const config = buildConfig(project);

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // Create skill artifact directory so users can drop in SKILL.md files
  // without needing to know the path. Mirrors Claude Code's
  // `~/.claude/skills/` convention at the project scope.
  mkdirSync(join(workspacePath, '.vinyan', 'skills'), { recursive: true });

  // Seed user-global ~/.vinyan/skills/ with the starter pack on first init.
  // Idempotent — won't overwrite an already-populated dir. Tests pass a temp
  // dir or `false` to opt out.
  let starterPackCopied: readonly string[] | undefined;
  if (opts.userSkillsDir !== false) {
    const templatesRoot = locateTemplatesDir();
    const userDir = opts.userSkillsDir ?? join(homedir(), '.vinyan', 'skills');
    if (templatesRoot) {
      const result = ensureStarterPack(templatesRoot, userDir);
      if (result.copied.length > 0) {
        starterPackCopied = result.copied;
      }
    }
  }

  return starterPackCopied
    ? { created: true, configPath, starterPackCopied }
    : { created: true, configPath };
}

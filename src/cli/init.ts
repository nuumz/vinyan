/**
 * vinyan init — detect project type and generate vinyan.json with sensible defaults.
 */
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { VinyanConfig } from '../config/schema.ts';

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

  // Phase 2: seed specialist agents based on detected project type.
  // Built-in registry always provides defaults; writing to vinyan.json makes
  // them visible/editable by users (e.g., `vinyan agent create` appends here).
  const agents: VinyanConfig['agents'] = [];
  if (project.hasTypeScript) {
    agents.push({
      id: 'ts-coder',
      name: 'TypeScript Coder',
      description: 'TypeScript/JavaScript specialist — refactoring, bug fixes, test generation.',
    });
  }
  // Writer is always seeded for documentation/README tasks
  agents.push({
    id: 'writer',
    name: 'Writer',
    description: 'Writing specialist — docs, creative content, README/blog generation.',
  });

  return {
    version: 1,
    oracles,
    agents: agents.length > 0 ? agents : undefined,
  };
}

export interface InitResult {
  created: boolean;
  configPath: string;
  reason?: string;
}

/**
 * Initialize vinyan.json in the given workspace.
 * @param force - Overwrite existing config if true.
 */
export function init(workspacePath: string, force = false): InitResult {
  const configPath = join(workspacePath, 'vinyan.json');

  if (existsSync(configPath) && !force) {
    return { created: false, configPath, reason: 'vinyan.json already exists (use --force to overwrite)' };
  }

  const project = detectProject(workspacePath);
  const config = buildConfig(project);

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { created: true, configPath };
}

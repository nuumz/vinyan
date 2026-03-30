/**
 * vinyan init — detect project type and generate vinyan.json with sensible defaults.
 */
import { existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import type { VinyanConfig } from "../config/schema.ts";

interface ProjectInfo {
  hasTypeScript: boolean;
  hasPython: boolean;
  hasPackageJson: boolean;
}

/** Detect project type by checking for common config files. */
function detectProject(workspacePath: string): ProjectInfo {
  return {
    hasTypeScript: existsSync(join(workspacePath, "tsconfig.json")),
    hasPython: existsSync(join(workspacePath, "pyproject.toml")) || existsSync(join(workspacePath, "setup.py")),
    hasPackageJson: existsSync(join(workspacePath, "package.json")),
  };
}

/** Build a vinyan.json config based on detected project type. Phase 0 only. */
function buildConfig(project: ProjectInfo): VinyanConfig {
  const languages: string[] = [];
  if (project.hasTypeScript) languages.push("typescript");
  if (project.hasPython) languages.push("python");
  if (languages.length === 0) languages.push("typescript"); // default

  const oracles: VinyanConfig["oracles"] = {
    ast: { enabled: true, languages, tier: "deterministic", timeout_behavior: "block" },
    dep: { enabled: true, tier: "heuristic", timeout_behavior: "block" },
  };

  // Enable type oracle only for TypeScript projects
  if (project.hasTypeScript) {
    oracles.type = { enabled: true, command: "tsc --noEmit", tier: "deterministic", timeout_behavior: "block" };
  }

  return {
    version: 1,
    oracles,
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
  const configPath = join(workspacePath, "vinyan.json");

  if (existsSync(configPath) && !force) {
    return { created: false, configPath, reason: "vinyan.json already exists (use --force to overwrite)" };
  }

  const project = detectProject(workspacePath);
  const config = buildConfig(project);

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  return { created: true, configPath };
}

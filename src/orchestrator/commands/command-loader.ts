/**
 * Phase 7d-2: Slash-command loader — discovers every `*.md` file under
 * `.vinyan/commands/` and parses it into a `SlashCommand`. Results are
 * cached per workspace path, mirroring the hook and permission loaders.
 *
 * Unlike hooks and permissions, this loader is forgiving: a single bad
 * file does NOT kill the whole directory. Bad files are skipped and the
 * error message attached to the registry so the CLI can surface it in
 * `/help`. This avoids the situation where one typo in one command
 * breaks every other command the user has defined.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { parseSlashCommand, type SlashCommand } from './command-schema.ts';

/**
 * A loaded command registry. `commands` maps lowercase command names to
 * parsed `SlashCommand`s. `errors` collects (file, reason) pairs for
 * files that failed to parse — the CLI can render them in `/help`.
 */
export interface SlashCommandRegistry {
  commands: Map<string, SlashCommand>;
  errors: Array<{ file: string; error: string }>;
}

const cache = new Map<string, SlashCommandRegistry>();

/** Clear cached registries. Intended for tests only. */
export function clearSlashCommandCache(): void {
  cache.clear();
}

/** An empty registry, used when `.vinyan/commands/` is absent. */
export const EMPTY_REGISTRY: SlashCommandRegistry = {
  commands: new Map(),
  errors: [],
};

/**
 * Load every `*.md` file under `{workspacePath}/.vinyan/commands/` and
 * return a registry. Missing directory yields an empty registry so
 * commands are opt-in per workspace.
 */
export function loadSlashCommands(workspacePath: string): SlashCommandRegistry {
  const cached = cache.get(workspacePath);
  if (cached) return cached;

  const dir = join(workspacePath, '.vinyan', 'commands');
  if (!existsSync(dir)) {
    cache.set(workspacePath, EMPTY_REGISTRY);
    return EMPTY_REGISTRY;
  }

  const registry: SlashCommandRegistry = { commands: new Map(), errors: [] };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    // Directory exists but can't be read — treat as empty and record the
    // error. The CLI will surface it in /help but chat still works.
    registry.errors.push({
      file: dir,
      error: e instanceof Error ? e.message : String(e),
    });
    cache.set(workspacePath, registry);
    return registry;
  }

  for (const entry of entries) {
    if (extname(entry) !== '.md') continue;
    const name = basename(entry, '.md').toLowerCase();
    const filePath = join(dir, entry);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseSlashCommand(name, raw);
      if (registry.commands.has(name)) {
        registry.errors.push({
          file: entry,
          error: `Duplicate command name "${name}" (case-insensitive)`,
        });
        continue;
      }
      registry.commands.set(name, parsed);
    } catch (e) {
      registry.errors.push({
        file: entry,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  cache.set(workspacePath, registry);
  return registry;
}

/**
 * Phase 7d-2: Slash-command expander. Pure function — takes a user
 * message and a command registry, and returns either an expanded
 * prompt (when the message begins with a recognized slash command) or
 * `null` (when the message isn't a slash command, or the command
 * doesn't exist in the registry).
 *
 * Built-in CLI commands like `/exit`, `/session`, `/history`, `/clear`
 * are NOT registered here — the CLI checks those first and only falls
 * through to this expander when the built-in branch misses.
 *
 * Expansion:
 *   `/commit docs typo`
 *   → look up `commit` in registry
 *   → replace `$ARGUMENTS` in the body with `docs typo`
 *   → return the substituted body as the new task goal
 */

import type { SlashCommandRegistry } from './command-loader.ts';

/** Result of attempting to expand a slash command. */
export type ExpansionResult =
  | { kind: 'not_a_command' }
  | { kind: 'unknown_command'; name: string }
  | { kind: 'expanded'; name: string; prompt: string; args: string };

/**
 * Try to expand a user message as a slash command. Returns a tagged
 * union describing what happened — the caller decides whether to
 * dispatch the expanded prompt, show an error, or pass the message
 * through unchanged.
 */
export function expandSlashCommand(message: string, registry: SlashCommandRegistry): ExpansionResult {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'not_a_command' };
  }

  // Split on the first run of whitespace. Everything before is the
  // command name (minus the leading slash); everything after is args.
  const spaceIdx = trimmed.search(/\s/);
  const rawName = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const name = rawName.toLowerCase();

  if (name === '') {
    return { kind: 'not_a_command' };
  }

  const command = registry.commands.get(name);
  if (!command) {
    return { kind: 'unknown_command', name };
  }

  // Substitute `$ARGUMENTS` globally in the body. We use split/join so
  // there's no regex escaping to worry about and the output is stable
  // regardless of args content.
  const prompt = command.body.split('$ARGUMENTS').join(args);

  return { kind: 'expanded', name, prompt, args };
}

/**
 * Phase 7d-2: Slash-command schema.
 *
 * Vinyan slash commands live as markdown files under `.vinyan/commands/`.
 * A file named `commit.md` becomes `/commit`. The file consists of an
 * optional YAML-ish frontmatter block (delimited by `---`) followed by
 * the prompt template body.
 *
 *   Example (.vinyan/commands/commit.md):
 *     ---
 *     description: Create a conventional git commit for staged changes
 *     argumentHint: [scope]
 *     ---
 *     Please stage relevant files and create a single git commit using
 *     a conventional message. Scope, if provided: $ARGUMENTS
 *
 * When the user types `/commit docs` in chat, the CLI looks up `commit`,
 * substitutes `$ARGUMENTS` with `docs`, and dispatches the resulting
 * prompt as the task goal.
 *
 * The parsed command is fully validated so malformed frontmatter is
 * caught at load time, not at expansion time.
 */

import { z } from 'zod/v4';

/**
 * Parsed slash command (frontmatter + body). The loader produces one of
 * these per file under `.vinyan/commands/`.
 */
export const SlashCommandSchema = z.object({
  /** Lowercase command name derived from the filename (without extension). */
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_-]*$/, 'Command name must be lowercase alphanumeric with -/_'),
  /**
   * Optional one-line description surfaced in `/help` listings. Empty
   * string is allowed for quick-and-dirty commands with no frontmatter.
   */
  description: z.string().default(''),
  /**
   * Optional hint shown to the user (e.g. `[scope]` or `<pr-number>`).
   * Purely cosmetic — not enforced at expansion time.
   */
  argumentHint: z.string().default(''),
  /**
   * The prompt template body. Supports `$ARGUMENTS` as a placeholder for
   * the trailing text after the command name. Must be non-empty.
   */
  body: z.string().min(1),
});

export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/**
 * Parse a raw markdown file into a `SlashCommand`. Accepts files with or
 * without a `---` frontmatter block. Throws a descriptive error if the
 * body is empty or the frontmatter is malformed.
 *
 * The frontmatter parser is intentionally minimal — `key: value` pairs,
 * no nested structures, no arrays. This avoids a full YAML dependency
 * for what's fundamentally a one-shot config surface.
 */
export function parseSlashCommand(name: string, fileContent: string): SlashCommand {
  const { frontmatter, body } = splitFrontmatter(fileContent);
  return SlashCommandSchema.parse({
    name,
    description: frontmatter.description ?? '',
    argumentHint: frontmatter.argumentHint ?? frontmatter['argument-hint'] ?? '',
    body: body.trim(),
  });
}

/**
 * Split a file's text into a `frontmatter` record and a `body` string.
 * Files without a `---` block return an empty frontmatter and the whole
 * text as the body.
 */
function splitFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Match a leading fence `---\n...\n---\n` only if it's the very first
  // thing in the file. Otherwise treat the whole text as body.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: text };
  }

  const rawFront = match[1] ?? '';
  const body = match[2] ?? '';
  const frontmatter: Record<string, string> = {};
  for (const line of rawFront.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      throw new Error(`Invalid frontmatter line (missing ':'): ${trimmed}`);
    }
    const key = trimmed.slice(0, colon).trim();
    // Strip optional surrounding quotes on the value.
    let value = trimmed.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

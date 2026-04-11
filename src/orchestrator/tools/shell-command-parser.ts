/**
 * Shell Command Parser — structured tokenizer for shell command validation.
 *
 * Replaces naive split(/\s+/) with proper tokenization that handles
 * edge cases: tabs, leading whitespace, metacharacters.
 *
 * A3 compliant: deterministic, same input → same output.
 */

export interface ParsedShellCommand {
  /** First token, normalized (lowercase for matching). */
  executable: string;
  /** Second token for git/bun/npm etc. */
  subcommand: string | undefined;
  /** Remaining tokens after executable and subcommand. */
  args: string[];
  /** Original input string. */
  raw: string;
  /** Whether the command contains shell metacharacters. */
  hasMetacharacters: boolean;
}

/**
 * Shell metacharacters that enable injection or chaining.
 * Checked as a character set for O(n) single-pass detection.
 */
const META_CHARS = new Set([
  ';', '|', '&', '`', '$', '(', ')', '{', '}',
  '>', '<', '\n',
]);

/**
 * Parse a raw shell command string into structured form.
 * Handles whitespace normalization and metacharacter detection in a single pass.
 */
export function parseShellCommand(raw: string): ParsedShellCommand {
  const trimmed = raw.trim();

  // Single-pass: split on whitespace, detect metacharacters
  let hasMetacharacters = false;
  const tokens: string[] = [];
  let currentToken = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;

    if (META_CHARS.has(ch)) {
      hasMetacharacters = true;
    }

    if (ch === ' ' || ch === '\t') {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = '';
      }
    } else {
      currentToken += ch;
    }
  }
  if (currentToken.length > 0) {
    tokens.push(currentToken);
  }

  const executable = tokens[0] ?? '';
  const subcommand = tokens[1];
  const args = tokens.slice(2);

  return {
    executable,
    subcommand,
    args,
    raw,
    hasMetacharacters,
  };
}

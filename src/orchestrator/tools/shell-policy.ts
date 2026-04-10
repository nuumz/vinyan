/**
 * Shell Policy — centralized command policy registry.
 *
 * Single source of truth for:
 * - Which commands are allowed (replaces SHELL_ALLOWLIST)
 * - Which subcommands are restricted (replaces INTERPRETER_SAFE_PATTERNS, DANGEROUS_GIT_*)
 * - Which commands are read-only (replaces isReadOnly regex in tool-authorization.ts)
 *
 * A3 compliant: deterministic, rule-based.
 */
import type { ParsedShellCommand } from './shell-command-parser.ts';

export interface CommandPolicy {
  allowed: boolean;
  readOnly: boolean;
  reason?: string;
}

interface CommandRule {
  readOnly: boolean;
  /** If set, only these subcommands are allowed. Undefined = all subcommands allowed. */
  allowedSubcommands?: Set<string>;
  /** For 'run' subcommand, only these scripts are allowed (e.g., bun run test). */
  allowedRunScripts?: Set<string>;
  /** Subcommands that are dangerous (blocked or require flag checks). */
  dangerousSubcommands?: Set<string>;
  /** Flags that make a command dangerous. */
  dangerousFlags?: Set<string>;
}

/**
 * Central command registry — every allowed command has explicit rules.
 * Adding a new command? Add it here with its policy.
 */
const COMMAND_RULES = new Map<string, CommandRule>([
  // Build/lint tools — read-only unless they modify files
  ['tsc', { readOnly: true }],
  ['eslint', { readOnly: true }],
  ['prettier', { readOnly: true }],
  ['ruff', { readOnly: true }],

  // Bun — only safe subcommands
  ['bun', {
    readOnly: false,
    allowedSubcommands: new Set(['test', 'run']),
    allowedRunScripts: new Set(['test', 'lint', 'check', 'build', 'typecheck', 'format']),
  }],

  // Node/Python — version check only
  ['node', {
    readOnly: true,
    allowedSubcommands: new Set(['--version']),
  }],
  ['python', {
    readOnly: true,
    allowedSubcommands: new Set(['--version']),
  }],

  // Git — allowed with dangerous subcommand/flag restrictions
  ['git', {
    readOnly: false,
    dangerousSubcommands: new Set(['push', 'reset', 'clean', 'remote']),
    dangerousFlags: new Set(['--force', '-f', '--hard', '--mirror']),
  }],

  // Read-only Unix tools
  ['cat', { readOnly: true }],
  ['head', { readOnly: true }],
  ['tail', { readOnly: true }],
  ['wc', { readOnly: true }],
  ['grep', { readOnly: true }],
  ['find', { readOnly: true }],
  ['ls', { readOnly: true }],
  ['diff', { readOnly: true }],
  ['echo', { readOnly: true }],
  ['type', { readOnly: true }],
  ['which', { readOnly: true }],
]);

/**
 * Evaluate a parsed shell command against the policy registry.
 * Returns whether the command is allowed, read-only, and rejection reason if any.
 */
export function evaluateCommand(parsed: ParsedShellCommand): CommandPolicy {
  // Metacharacters → always reject
  if (parsed.hasMetacharacters) {
    return { allowed: false, readOnly: false, reason: 'Shell command contains dangerous metacharacter' };
  }

  const rule = COMMAND_RULES.get(parsed.executable);
  if (!rule) {
    return { allowed: false, readOnly: false, reason: `Shell command '${parsed.executable}' is not in allowlist` };
  }

  // Subcommand restrictions (bun, node, python)
  if (rule.allowedSubcommands) {
    const sub = parsed.subcommand;
    if (!sub || !rule.allowedSubcommands.has(sub)) {
      return {
        allowed: false,
        readOnly: rule.readOnly,
        reason: `'${parsed.executable}' is only allowed with sub-commands: ${[...rule.allowedSubcommands].join(', ')}`,
      };
    }
    // For 'run' subcommand with allowedRunScripts (bun run test|lint|check|...)
    if (sub === 'run' && rule.allowedRunScripts) {
      const script = parsed.args[0];
      if (!script || !rule.allowedRunScripts.has(script)) {
        return {
          allowed: false,
          readOnly: rule.readOnly,
          reason: `'${parsed.executable} run' only allows: ${[...rule.allowedRunScripts].join(', ')}`,
        };
      }
    }
  }

  // Dangerous subcommand/flag restrictions (git)
  if (rule.dangerousSubcommands && parsed.subcommand) {
    if (rule.dangerousSubcommands.has(parsed.subcommand)) {
      // Some dangerous subcommands are always blocked (push, remote)
      if (parsed.subcommand === 'push' || parsed.subcommand === 'remote') {
        return {
          allowed: false,
          readOnly: false,
          reason: `Dangerous ${parsed.executable} operation: '${parsed.executable} ${parsed.subcommand}'`,
        };
      }
      // Others only blocked with dangerous flags (reset --hard, clean -f)
      if (rule.dangerousFlags) {
        const hasDangerousFlag = parsed.args.some(arg => rule.dangerousFlags!.has(arg));
        if (hasDangerousFlag) {
          return {
            allowed: false,
            readOnly: false,
            reason: `Dangerous ${parsed.executable} operation: '${parsed.executable} ${[parsed.subcommand, ...parsed.args].join(' ')}'`,
          };
        }
      }
    }
  }

  return { allowed: true, readOnly: rule.readOnly };
}

/**
 * Check if a command executable is read-only.
 * Used by tool-authorization.ts for capability classification.
 */
export function isReadOnlyCommand(executable: string): boolean {
  const rule = COMMAND_RULES.get(executable);
  return rule?.readOnly ?? false;
}

/**
 * Tool/command → MicrotheoryAction classifier.
 *
 * Pure function. Used by both the M2 oracle (when extracting application
 * context from a HypothesisTuple) and the future M4 sleep-cycle promoter
 * (when inferring microtheory from observed pattern).
 *
 * Accepts either a bare tool name (e.g., `'edit_file'`) or a full command
 * line (e.g., `'rm -rf /tmp/cache'`); the first whitespace-delimited token
 * is the lookup key.
 *
 * Returns `'universal'` for shell/unknown commands — action depends on the
 * args, which are unknown without parsing. The action axis is then a
 * wildcard at query time, so the registry's pattern + abnormality eval
 * does the real work.
 *
 * See `docs/design/commonsense-substrate-system-design.md` §6 (M3 mutation
 * classification, M4 microtheory inference).
 */
import type { MicrotheoryAction } from './types.ts';

const READONLY_TOOLS = new Set([
  'read_file',
  'list_files',
  'list_directory',
  'glob',
  'grep',
  'search',
  'search_codebase',
  'view',
  'cat',
  'head',
  'tail',
  'ls',
  'stat',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'delete_file',
  'remove_file',
  'rm',
  'rmdir',
  'truncate',
  'unlink',
]);

const ADDITIVE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'append_to_file',
  'insert_at_line',
  'apply_patch',
]);

/**
 * Classify a tool/command into a MicrotheoryAction. Returns `'universal'`
 * when input is empty OR when the first token is unknown — deferring action
 * narrowing to the registry's pattern eval at query time.
 */
export function classifyMutation(tool: string | undefined | null): MicrotheoryAction {
  if (!tool) return 'universal';

  const firstToken = tool.toLowerCase().split(/\s+/)[0];
  if (!firstToken) return 'universal';

  if (READONLY_TOOLS.has(firstToken)) return 'read-only';
  if (DESTRUCTIVE_TOOLS.has(firstToken)) return 'mutation-destructive';
  if (ADDITIVE_TOOLS.has(firstToken)) return 'mutation-additive';

  return 'universal';
}

/**
 * M4 — Pattern → microtheory inference for sleep-cycle promotion.
 *
 * Maps an ExtractedPattern (from sleep-cycle's pattern store) to a 3-axis
 * MicrotheoryLabel and a Pattern matcher. Used by `promotion.ts` to convert
 * mined patterns into commonsense rules.
 *
 * Inference axes:
 *  - language: parsed from `taskTypeSignature` extensions (`delete::ts::large` → `typescript-strict`)
 *  - domain: defaults to `universal` (M4 v1 — domain inference from approach
 *           text is deferred to v2)
 *  - action: parsed from `taskTypeSignature` action verb (`delete::*::*` → `mutation-destructive`)
 *
 * See `docs/design/commonsense-substrate-system-design.md` §6 (M4) and
 * §5 Q1 (three-axis hybrid microtheory partitioning).
 */
import type { ExtractedPattern } from '../../orchestrator/types.ts';
import type {
  MicrotheoryAction,
  MicrotheoryDomain,
  MicrotheoryLabel,
  MicrotheoryLanguage,
  Pattern as PatternMatcher,
} from './types.ts';

// ── Language axis: extension → MicrotheoryLanguage ───────────────────────

const EXTENSION_TO_LANGUAGE: Record<string, MicrotheoryLanguage> = {
  ts: 'typescript-strict',
  tsx: 'typescript-strict',
  mts: 'typescript-strict',
  cts: 'typescript-strict',
  py: 'python-typed', // pessimistic default
  sh: 'shell-bash',
  bash: 'shell-bash',
  zsh: 'shell-zsh',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
};

// ── Action axis: verb → MicrotheoryAction ────────────────────────────────
//
// Mirrors the canonical Vinyan action-verb vocabulary (see
// `src/orchestrator/task-fingerprint.ts` extractActionVerb), simplified to
// the 4 commonsense action classes.

const VERB_TO_ACTION: Record<string, MicrotheoryAction> = {
  // destructive
  delete: 'mutation-destructive',
  remove: 'mutation-destructive',
  drop: 'mutation-destructive',
  destroy: 'mutation-destructive',
  // additive
  add: 'mutation-additive',
  create: 'mutation-additive',
  write: 'mutation-additive',
  fix: 'mutation-additive', // most fixes are edits
  refactor: 'mutation-additive',
  edit: 'mutation-additive',
  update: 'mutation-additive',
  implement: 'mutation-additive',
  // read-only
  read: 'read-only',
  list: 'read-only',
  check: 'read-only',
  inspect: 'read-only',
  analyze: 'read-only',
  // tool-invocation
  run: 'tool-invocation',
  execute: 'tool-invocation',
  install: 'tool-invocation',
  test: 'tool-invocation',
  build: 'tool-invocation',
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Infer the 3-axis microtheory label from an ExtractedPattern.
 * Returns `universal` on each axis where the inference is uncertain — the
 * registry's `findApplicable` then matches via wildcard.
 */
export function inferMicrotheory(pattern: ExtractedPattern): MicrotheoryLabel {
  return {
    language: inferLanguage(pattern.taskTypeSignature),
    domain: inferDomain(pattern),
    action: inferAction(pattern.taskTypeSignature),
  };
}

/**
 * Generate a literal-substring Pattern matcher from an ExtractedPattern's
 * `approach` field (the textual approach that succeeded/failed).
 *
 * Returns null when the pattern's approach is too short or empty — caller
 * should treat that as "unparseable; do not promote".
 */
export function inferRuleMatcher(pattern: ExtractedPattern): PatternMatcher | null {
  const approach = pattern.approach?.trim();
  if (!approach || approach.length < 3) return null;

  // Use first non-trivial token (up to 50 chars) as the matcher needle.
  // Real production rules would use richer extraction; MVP uses literal text.
  const needle = approach.length > 50 ? approach.slice(0, 50).trimEnd() : approach;

  return {
    kind: 'literal-substring',
    target_field: 'command',
    needle,
    case_sensitive: false, // mined patterns are linguistically noisy
  };
}

// ── Axis inference (private helpers, exported for unit testing) ──────────

/**
 * Parse the language axis from a task type signature like
 * `delete::ts::large-blast` (verb::extensions::blast-bucket).
 *
 * Single extension → mapped language. Multiple extensions or unknown → universal.
 */
export function inferLanguage(taskTypeSignature: string): MicrotheoryLanguage {
  const parts = taskTypeSignature.split('::');
  if (parts.length < 2) return 'universal';
  const exts = parts[1]!.split(',').filter((e) => e.length > 0 && e !== 'none');
  if (exts.length === 0 || exts.length > 1) return 'universal'; // mixed/missing = universal
  const ext = exts[0]!.toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? 'universal';
}

/**
 * Parse the action axis from a task type signature.
 * Maps the verb (first `::`-separated segment) to a MicrotheoryAction.
 */
export function inferAction(taskTypeSignature: string): MicrotheoryAction {
  const parts = taskTypeSignature.split('::');
  if (parts.length === 0) return 'universal';
  const verb = parts[0]!.toLowerCase();
  return VERB_TO_ACTION[verb] ?? 'universal';
}

/**
 * Infer the domain axis. M4 v1 defaults to `universal` — domain inference
 * from approach text or trace context is deferred to v2.
 */
export function inferDomain(_pattern: ExtractedPattern): MicrotheoryDomain {
  return 'universal';
}

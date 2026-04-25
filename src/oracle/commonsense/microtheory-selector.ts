/**
 * Microtheory selector — extracts ApplicationContext from a HypothesisTuple
 * and infers the three-axis microtheory label `{language, domain, action}`.
 *
 * Deterministic. No LLM. No I/O. Used by the M2 oracle to decide which
 * commonsense rules apply to a proposed action.
 *
 * Reused by M4 (sleep-cycle promoter) to infer microtheory from observed
 * patterns — keeps the inference logic in one place so M3 (read) and M4
 * (write) cannot diverge.
 *
 * See `docs/design/commonsense-substrate-system-design.md` §3.3 / §6.
 */
import type { HypothesisTuple } from '../../core/types.ts';
import { classifyMutation } from './mutation-classifier.ts';
import type {
  ApplicationContext,
  MicrotheoryAction,
  MicrotheoryDomain,
  MicrotheoryLabel,
  MicrotheoryLanguage,
} from './types.ts';

/**
 * Extract an ApplicationContext from a HypothesisTuple. Pulls:
 *  - `command` from `context.command` if present (full invocation), else
 *    falls back to `context.tool` (bare tool name).
 *  - `path` from `target`.
 *  - `verb` from `context.understanding.actionVerb` (when L2+ comprehend has run).
 *  - `file_extension` from `target` suffix.
 *
 * Any missing field is left undefined — pattern eval skips fields it cannot
 * see (see `predicate-eval.ts`).
 *
 * Why `command` prefers full invocation: pattern matchers like
 * `'literal-substring'` with needle `'rm -rf'` need the whole command string,
 * not just the bare tool name `'rm'`.
 */
export function extractApplicationContext(hypothesis: HypothesisTuple): ApplicationContext {
  const ctx = (hypothesis.context ?? {}) as Record<string, unknown>;
  const tool = typeof ctx.tool === 'string' ? ctx.tool : undefined;
  const explicitCommand = typeof ctx.command === 'string' ? ctx.command : undefined;
  const command = explicitCommand ?? tool;
  const understanding = ctx.understanding as { actionVerb?: string } | undefined;

  const result: ApplicationContext = {};
  if (command) result.command = command;
  if (hypothesis.target) result.path = hypothesis.target;
  if (understanding?.actionVerb) result.verb = understanding.actionVerb;
  const ext = extractExtension(hypothesis.target);
  if (ext) result.file_extension = ext;

  return result;
}

/**
 * Select the three-axis microtheory label from an ApplicationContext.
 *
 * Each axis falls back to `universal` when its inputs are absent — this is
 * the wildcard side of the registry's `findApplicable` query, so universal
 * means "match any rule on this axis".
 */
export function selectMicrotheory(ctx: ApplicationContext): MicrotheoryLabel {
  return {
    language: inferLanguage(ctx),
    domain: inferDomain(ctx),
    action: inferAction(ctx),
  };
}

// ── Axis inference ───────────────────────────────────────────────────────

function extractExtension(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const m = target.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]!.toLowerCase() : undefined;
}

function inferLanguage(ctx: ApplicationContext): MicrotheoryLanguage {
  const ext = ctx.file_extension;
  if (!ext) return 'universal';
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript-strict';
  if (ext === 'py') return 'python-typed'; // pessimistic default — flips to python-untyped if mypy/pyright absent (M3 hook)
  if (ext === 'sh' || ext === 'bash') return 'shell-bash';
  if (ext === 'zsh') return 'shell-zsh';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (ext === 'sql') return 'sql';
  return 'universal';
}

function inferDomain(ctx: ApplicationContext): MicrotheoryDomain {
  const path = ctx.path ?? '';
  const command = ctx.command ?? '';

  // Path-based heuristics (more specific than command-based)
  if (path.includes('/.git/') || path.endsWith('/.git') || path === '.git') return 'git-workflow';
  if (path.endsWith('.tf') || path.includes('terraform')) return 'infra-terraform';
  if (path.includes('migrations/') || path.includes('migration_')) return 'data-pipeline';
  if (path.includes('/api/') || path.includes('/routes/') || path.includes('/handlers/')) {
    return 'web-rest';
  }

  // Command-based heuristics
  if (command.startsWith('git ')) return 'git-workflow';
  if (command.startsWith('terraform ') || command.startsWith('kubectl ')) return 'infra-terraform';
  if (command.startsWith('rm') || command.startsWith('mv') || command.startsWith('cp')) {
    return 'filesystem';
  }
  if (command.startsWith('bash') || command.startsWith('sh') || command === 'shell') return 'cli';

  // Path present but no domain match → filesystem (catch-all for file-oriented ops)
  if (path) return 'filesystem';

  return 'universal';
}

function inferAction(ctx: ApplicationContext): MicrotheoryAction {
  return classifyMutation(ctx.command);
}

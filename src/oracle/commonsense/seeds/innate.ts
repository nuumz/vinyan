/**
 * Innate seed rules for the Common Sense Substrate.
 *
 * Ported from hardcoded heuristics scattered across:
 *  - `src/gate/risk-router.ts`         (irreversibility table)
 *  - `src/orchestrator/tools/shell-policy.ts` (destructive git ops, dangerous flags)
 *  - `src/oracle/goal-alignment/goal-alignment-verifier.ts` (verb → expectation)
 *
 * Each rule is `source: 'innate'` and carries a rationale suitable for audit.
 * Confidence sits in the pragmatic band [0.5, 0.7]. Rules that *block* destructive
 * operations sit at the upper edge (0.7); rules expressing softer defaults sit
 * lower.
 *
 * Rule count target: ~30 (matches design doc §5 Q2 — "innate ≈ 30, rest learned").
 *
 * See `docs/design/commonsense-substrate-system-design.md` §5 / §6 / Appendix A.
 */
import type { CommonSenseRegistry } from '../registry.ts';
import type { CommonSenseRuleInput } from '../types.ts';

export const INNATE_RULES: CommonSenseRuleInput[] = [
  // ── Irreversibility (ported from risk-router.ts:32-51) ────────────────────

  {
    microtheory: { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf', case_sensitive: true },
    default_outcome: 'block',
    priority: 95,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'rm -rf is irreversible at the filesystem level. Block by default; require explicit confirmation. Ported from src/gate/risk-router.ts:32-51 (irreversibility=0.95 for db_delete-class operations).',
  },
  {
    microtheory: { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'exact-match', target_field: 'command', value: 'rm -rf /' },
    default_outcome: 'block',
    priority: 100,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'rm -rf / wipes the filesystem root. Documented Claude Code incident (2026): family-photo loss. Highest priority — never overridden.',
  },
  {
    microtheory: { language: 'shell-bash', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'rm -rf ~' },
    default_outcome: 'block',
    priority: 100,
    confidence: 0.7,
    source: 'innate',
    rationale: 'Home-directory wipe. Same incident class as rm -rf /.',
  },

  // ── Destructive git ops (ported from shell-policy.ts:62-66) ───────────────

  {
    microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git push --force' },
    default_outcome: 'block',
    abnormality_predicate: {
      kind: 'literal-substring',
      target_field: 'command',
      needle: '--force-with-lease',
      case_sensitive: true,
    },
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'git push --force overwrites upstream history. Allow only when --force-with-lease is used (the abnormality case). Ported from src/orchestrator/tools/shell-policy.ts:62-66.',
  },
  {
    microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git push -f', case_sensitive: true },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale: 'Short flag form of --force. Same risk profile.',
  },
  {
    microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git reset --hard' },
    default_outcome: 'needs-confirmation',
    priority: 85,
    confidence: 0.65,
    source: 'innate',
    rationale:
      'git reset --hard discards uncommitted work in tracked files. Reversibility depends on reflog age — confirm rather than block. Ported from shell-policy.',
  },
  {
    microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git clean -fd' },
    default_outcome: 'needs-confirmation',
    priority: 85,
    confidence: 0.65,
    source: 'innate',
    rationale: 'git clean -fd removes untracked files and directories. Often desired but irreversible — confirm.',
  },
  {
    microtheory: { language: 'universal', domain: 'git-workflow', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'git branch -D' },
    default_outcome: 'needs-confirmation',
    priority: 80,
    confidence: 0.65,
    source: 'innate',
    rationale: 'git branch -D force-deletes unmerged branches. Reflog rescues for ~30 days, but confirm.',
  },
  {
    microtheory: { language: 'universal', domain: 'git-workflow', action: 'tool-invocation' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: '--no-verify' },
    default_outcome: 'needs-confirmation',
    priority: 75,
    confidence: 0.6,
    source: 'innate',
    rationale: 'Bypasses pre-commit hooks. Hook failures usually represent real issues. Confirm intent.',
  },

  // ── Database / data destructiveness ───────────────────────────────────────

  {
    microtheory: { language: 'sql', domain: 'data-pipeline', action: 'mutation-destructive' },
    pattern: { kind: 'regex', target_field: 'command', pattern: '\\bDROP\\s+TABLE\\b', flags: 'i' },
    default_outcome: 'block',
    priority: 95,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'DROP TABLE is irreversible without a backup. Ported from risk-router irreversibility=0.95 for db_data_delete.',
  },
  {
    microtheory: { language: 'sql', domain: 'data-pipeline', action: 'mutation-destructive' },
    pattern: { kind: 'regex', target_field: 'command', pattern: '\\bTRUNCATE\\s+TABLE\\b', flags: 'i' },
    default_outcome: 'block',
    priority: 95,
    confidence: 0.7,
    source: 'innate',
    rationale: 'TRUNCATE TABLE wipes all rows; usually irreversible without point-in-time recovery.',
  },
  {
    microtheory: { language: 'sql', domain: 'data-pipeline', action: 'mutation-destructive' },
    pattern: { kind: 'regex', target_field: 'command', pattern: '\\bDELETE\\s+FROM\\b(?!.*\\bWHERE\\b)', flags: 'is' },
    default_outcome: 'block',
    priority: 95,
    confidence: 0.7,
    source: 'innate',
    rationale: 'DELETE FROM without WHERE deletes every row. Almost never intentional — block.',
  },

  // ── Infrastructure / deployment ───────────────────────────────────────────

  {
    microtheory: { language: 'universal', domain: 'infra-terraform', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'terraform destroy' },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'terraform destroy tears down infrastructure. Highly irreversible (state, data, IPs). Ported from risk-router irreversibility=0.9 for deployment.',
  },
  {
    microtheory: { language: 'universal', domain: 'infra-terraform', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'kubectl delete namespace' },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale: 'Cascade-deletes everything in namespace. Confirm or use --dry-run.',
  },

  // ── Process / system ──────────────────────────────────────────────────────

  {
    microtheory: { language: 'shell-bash', domain: 'process', action: 'tool-invocation' },
    pattern: { kind: 'regex', target_field: 'command', pattern: '\\bsudo\\b' },
    default_outcome: 'needs-confirmation',
    priority: 80,
    confidence: 0.6,
    source: 'innate',
    rationale: 'sudo escalates privileges; agents should not run privileged operations without explicit confirmation.',
  },
  {
    microtheory: { language: 'shell-bash', domain: 'process', action: 'tool-invocation' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: 'kill -9' },
    default_outcome: 'needs-confirmation',
    priority: 70,
    confidence: 0.55,
    source: 'innate',
    rationale: 'SIGKILL prevents graceful shutdown. Prefer SIGTERM unless the process is hung.',
  },

  // ── Filesystem boundaries (Chesterton's fence — files we did not read) ────

  {
    microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'path', needle: 'node_modules' },
    default_outcome: 'allow',
    priority: 30,
    confidence: 0.55,
    source: 'innate',
    rationale:
      'node_modules is reproducible from package manifests; deletion is generally safe (Chesterton inverse — the contents are not load-bearing).',
  },
  {
    microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'path', needle: '.git/' },
    default_outcome: 'block',
    priority: 95,
    confidence: 0.7,
    source: 'innate',
    rationale: '.git/ contains the entire repo history. Deletion is irreversible without remote backup.',
  },
  {
    microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'path', needle: '.env' },
    default_outcome: 'needs-confirmation',
    priority: 75,
    confidence: 0.6,
    source: 'innate',
    rationale: '.env files contain secrets that may have no other source-of-truth. Confirm before mutation.',
  },

  // ── Goal-alignment verb expectations (ported from goal-alignment-verifier.ts:77-88) ──
  //
  // These are PRAGMATIC defaults: a verb in the user's task usually implies a
  // class of mutation. They escalate (don't block) when violated — the LLM
  // may be doing something unusual but not wrong.

  {
    microtheory: { language: 'universal', domain: 'universal', action: 'mutation-destructive' },
    pattern: { kind: 'exact-match', target_field: 'verb', value: 'add' },
    default_outcome: 'escalate',
    priority: 60,
    confidence: 0.55,
    source: 'innate',
    rationale:
      'User said "add" but proposal contains destructive mutation — escalate to higher routing level for review. Pragmatic default; LLM may be doing necessary cleanup.',
  },
  {
    microtheory: { language: 'universal', domain: 'universal', action: 'mutation-destructive' },
    pattern: { kind: 'exact-match', target_field: 'verb', value: 'create' },
    default_outcome: 'escalate',
    priority: 60,
    confidence: 0.55,
    source: 'innate',
    rationale: 'User said "create" but proposal contains destructive mutation — escalate.',
  },
  {
    microtheory: { language: 'universal', domain: 'universal', action: 'mutation-destructive' },
    pattern: { kind: 'exact-match', target_field: 'verb', value: 'fix' },
    default_outcome: 'escalate',
    priority: 60,
    confidence: 0.55,
    source: 'innate',
    rationale: '"fix" usually means "modify existing"; large-scale deletion is unusual. Escalate to verify intent.',
  },
  {
    microtheory: { language: 'universal', domain: 'universal', action: 'mutation-destructive' },
    pattern: { kind: 'exact-match', target_field: 'verb', value: 'refactor' },
    default_outcome: 'escalate',
    priority: 60,
    confidence: 0.55,
    source: 'innate',
    rationale: '"refactor" preserves behavior. Heavy deletion suggests scope drift — escalate.',
  },

  // ── Tool/binary invocation hygiene ────────────────────────────────────────

  {
    microtheory: { language: 'universal', domain: 'cli', action: 'tool-invocation' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: '/proc/self/' },
    default_outcome: 'block',
    priority: 95,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'Sandbox-bypass technique observed in 2026 Ona Claude Code incident. /proc/self/ paths can leak the host filesystem. Block.',
  },
  {
    microtheory: { language: 'universal', domain: 'cli', action: 'tool-invocation' },
    pattern: { kind: 'regex', target_field: 'command', pattern: '\\bcurl\\b.*\\|\\s*(sh|bash|zsh)\\b' },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale:
      'curl | sh is a remote-code-execution pattern. Inject any source, run unverified. Block — defense in depth on top of guardrails.',
  },

  // ── TypeScript / Python defaults ──────────────────────────────────────────

  {
    microtheory: { language: 'typescript-strict', domain: 'universal', action: 'mutation-additive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: '@ts-ignore' },
    default_outcome: 'escalate',
    priority: 50,
    confidence: 0.55,
    source: 'innate',
    rationale:
      '@ts-ignore disables type checking on a line. Sometimes correct, often a hack — escalate to surface the choice.',
  },
  {
    microtheory: { language: 'python-typed', domain: 'universal', action: 'mutation-additive' },
    pattern: { kind: 'literal-substring', target_field: 'command', needle: '# type: ignore' },
    default_outcome: 'escalate',
    priority: 50,
    confidence: 0.55,
    source: 'innate',
    rationale: 'Same rationale as @ts-ignore — type-checker bypass.',
  },

  // ── File-system patterns (Chesterton's fence — read-before-delete) ────────

  {
    microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'path', needle: 'tests/' },
    default_outcome: 'escalate',
    priority: 65,
    confidence: 0.6,
    source: 'innate',
    rationale: 'Deleting tests is rarely intended when the user said "fix" or "add feature". Escalate for review.',
  },
  {
    microtheory: { language: 'universal', domain: 'filesystem', action: 'mutation-destructive' },
    pattern: { kind: 'literal-substring', target_field: 'path', needle: 'migrations/' },
    default_outcome: 'block',
    priority: 90,
    confidence: 0.7,
    source: 'innate',
    rationale: 'Migrations are append-only history. Modifying or deleting an applied migration breaks reproducibility.',
  },
];

/**
 * Load all innate rules into a registry. Idempotent: re-running has no
 * effect (rules are content-addressed; duplicates collapse).
 */
export function loadInnateSeed(registry: CommonSenseRegistry): { inserted: number } {
  let inserted = 0;
  for (const rule of INNATE_RULES) {
    registry.insertRule(rule);
    inserted += 1;
  }
  return { inserted };
}

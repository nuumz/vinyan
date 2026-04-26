/**
 * Ship Policy — pre-execution guard for git_commit, git_push, git_pr.
 *
 * Enforces hard rejections that no human-approval can override:
 *   - No `git push --force` to protected branches (default: main, master).
 *   - No commit message containing shell-metachar that would break the
 *     parent CLI invocation (newline-injection at HEREDOC boundary).
 *   - PR base branch must be in the allowed-base list.
 *
 * Soft policies (e.g. requiresApproval) live on the tool descriptor itself;
 * this module enforces invariants that the user cannot waive at the prompt.
 *
 * Axiom alignment:
 *   - A6: zero-trust at the boundary — the orchestrator never trusts the
 *         caller's args; this module gates them before subprocess spawn.
 *   - A3: rules below are pure data + pure functions; no LLM involved.
 */

export const PROTECTED_BRANCHES = new Set(['main', 'master', 'release', 'production']);

export const ALLOWED_PR_BASES = new Set(['main', 'master', 'develop', 'next']);

export type ShipPolicyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; code: ShipPolicyRejectCode };

export type ShipPolicyRejectCode =
  | 'force-push-protected'
  | 'unsupported-remote-flag'
  | 'commit-message-empty'
  | 'commit-message-newline-fence'
  | 'commit-message-too-short'
  | 'pr-base-not-allowed'
  | 'pr-title-too-long'
  | 'branch-name-invalid';

/** Allowed commit-message length range. Aligns with conventional-commit norms. */
const COMMIT_MESSAGE_MIN_LEN = 10;
const PR_TITLE_MAX_LEN = 70;
const BRANCH_NAME_REGEX = /^[a-z0-9][a-z0-9._/-]{0,99}$/i;

export function approveCommitMessage(message: string): ShipPolicyVerdict {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return { allowed: false, reason: 'commit message is empty', code: 'commit-message-empty' };
  }
  if (trimmed.length < COMMIT_MESSAGE_MIN_LEN) {
    return {
      allowed: false,
      reason: `commit message must be at least ${COMMIT_MESSAGE_MIN_LEN} chars (got ${trimmed.length})`,
      code: 'commit-message-too-short',
    };
  }
  if (/EOF\s*\n/.test(trimmed)) {
    return {
      allowed: false,
      reason: 'commit message contains a HEREDOC fence sentinel (EOF) which is unsafe',
      code: 'commit-message-newline-fence',
    };
  }
  return { allowed: true };
}

export interface PushPolicyInput {
  branch: string;
  remote: string;
  /** Caller-supplied flag intent — these may be passed through to git; the policy
   *  decides whether the combination is permitted. */
  force?: boolean;
  forceWithLease?: boolean;
}

export function approvePush(input: PushPolicyInput): ShipPolicyVerdict {
  if ((input.force ?? false) && PROTECTED_BRANCHES.has(input.branch.toLowerCase())) {
    return {
      allowed: false,
      reason: `force-push to protected branch '${input.branch}' is forbidden by ship policy`,
      code: 'force-push-protected',
    };
  }
  // We DO allow `--force-with-lease` to non-protected branches; reject it for
  // protected branches because lease-checks are not a substitute for a PR.
  if ((input.forceWithLease ?? false) && PROTECTED_BRANCHES.has(input.branch.toLowerCase())) {
    return {
      allowed: false,
      reason: `force-with-lease to protected branch '${input.branch}' is forbidden by ship policy`,
      code: 'force-push-protected',
    };
  }
  if (!BRANCH_NAME_REGEX.test(input.branch)) {
    return {
      allowed: false,
      reason: `branch name '${input.branch}' is not a valid git ref (alnum + . _ / -, max 100 chars)`,
      code: 'branch-name-invalid',
    };
  }
  if (input.remote && !/^[a-zA-Z0-9._-]+$/.test(input.remote)) {
    return {
      allowed: false,
      reason: `remote '${input.remote}' contains forbidden characters`,
      code: 'unsupported-remote-flag',
    };
  }
  return { allowed: true };
}

export interface PrPolicyInput {
  title: string;
  base: string;
}

export function approvePr(input: PrPolicyInput): ShipPolicyVerdict {
  if (!ALLOWED_PR_BASES.has(input.base.toLowerCase())) {
    return {
      allowed: false,
      reason: `PR base '${input.base}' not in allow-list (${[...ALLOWED_PR_BASES].join(', ')})`,
      code: 'pr-base-not-allowed',
    };
  }
  const titleLen = input.title.trim().length;
  if (titleLen === 0 || titleLen > PR_TITLE_MAX_LEN) {
    return {
      allowed: false,
      reason: `PR title must be 1..${PR_TITLE_MAX_LEN} chars (got ${titleLen})`,
      code: 'pr-title-too-long',
    };
  }
  return { allowed: true };
}

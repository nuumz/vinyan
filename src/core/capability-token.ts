/**
 * Capability Token — runtime-enforceable scope for delegated sub-tasks.
 *
 * R4: closes the runtime gap where `subagentType: 'plan' | 'explore'` is
 * validated at delegation time but not at tool dispatch time. A
 * misconfigured persona or a sub-task that "decides to help by writing
 * code" cannot bypass the contract once the tool dispatcher consults
 * the token.
 *
 * The token is the substrate for future A11 Capability Escalation —
 * once workers / peers earn graduated authority via Wilson-LB
 * telemetry, the token's `allowedTools` / `allowedPaths` will widen
 * under audit.
 *
 * Axioms upheld:
 *   A3 — every check is rule-based; never an LLM in the dispatch path.
 *   A6 — zero-trust by default; missing token = read-only.
 *   A8 — every issuance carries `issuedBy`, `issuedAt`, and an audit
 *        provenance object so revocation/replay is possible.
 */

import { createHash } from 'node:crypto';

export type SubagentType = 'explore' | 'plan' | 'general-purpose';

/**
 * Tools that mutate workspace state. Sub-tasks without an explicit
 * permit MUST NOT execute these. Aligned with
 * `delegation-router.MUTATION_TOOLS` so the runtime check is symmetric
 * with the delegation-time validation.
 */
export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'file_write',
  'file_edit',
  'file_patch',
  'file_delete',
  'shell_exec',
  'delegate_task',
  'git_commit',
  'git_push',
]);

export interface CapabilityToken {
  /** Stable id derived from (parentTaskId, subagentType, issuedAt). Lets the audit ledger replay revocations. */
  readonly id: string;
  /** Subagent role this token was issued under. */
  readonly subagentType: SubagentType;
  /**
   * Allowed tool names. Empty array = read-only default (no mutation).
   * `general-purpose` typically gets every non-blocked tool; `explore`
   * / `plan` get only read-only tools.
   */
  readonly allowedTools: readonly string[];
  /**
   * Tools explicitly forbidden, overrides `allowedTools`. Used when a
   * specific risky tool needs to be denied even within general-purpose
   * scope (e.g., shell_exec is always forbidden for delegated tasks).
   */
  readonly forbiddenTools: readonly string[];
  /**
   * Allowed file path prefixes. Mutation tools (file_write etc.) MUST
   * resolve the target path to be inside one of these prefixes.
   * Empty means "no path restriction" (general-purpose with full
   * parent scope) but the runtime still enforces `forbiddenTools`.
   */
  readonly allowedPaths: readonly string[];
  /** Parent task that issued this token. Records the chain for replay. */
  readonly parentTaskId: string;
  /** Epoch ms when the token expires; runtime refuses after that. */
  readonly expiresAt: number;
  /** Module / persona / actor that issued this token. */
  readonly issuedBy: string;
  /** Epoch ms when the token was minted. */
  readonly issuedAt: number;
  /**
   * Audit provenance — a free-form structured payload the issuer
   * populates with the rationale (delegation request, governance
   * decisionId, evidence). Replayed in trace events.
   */
  readonly provenance?: Readonly<Record<string, unknown>>;
}

export interface CapabilityCheckRequest {
  readonly token: CapabilityToken | undefined;
  readonly toolName: string;
  /**
   * For path-scoped tools (file_write, file_edit, etc.) — the target
   * path the call wants to mutate. Resolved against `allowedPaths`.
   * Omit for tools without a single path argument.
   */
  readonly targetPath?: string;
  /** Wall clock at the call site; defaults to `Date.now()`. */
  readonly now?: number;
}

export type CapabilityCheckResult =
  | { readonly ok: true; readonly tokenId: string | null }
  | {
      readonly ok: false;
      readonly reason:
        | 'token_missing'
        | 'token_expired'
        | 'tool_forbidden'
        | 'tool_not_allowed'
        | 'path_out_of_scope';
      readonly detail: string;
    };

/**
 * Default conservative policy when no token is wired. Mirrors the
 * pre-R4 implicit behavior for a top-level (non-delegated) task: every
 * non-mutation tool is allowed; mutation tools are allowed only when
 * the call site explicitly opts in.
 *
 * Used by code paths that have no delegation hierarchy (e.g., direct
 * CLI tool invocation, tests). New code should always pass an explicit
 * token; this helper preserves byte-identical behavior for legacy paths.
 */
export const READONLY_FALLBACK_TOKEN: CapabilityToken = {
  id: 'capability-token:readonly-fallback',
  subagentType: 'explore',
  allowedTools: [],
  forbiddenTools: [...MUTATION_TOOL_NAMES],
  allowedPaths: [],
  parentTaskId: 'system:fallback',
  expiresAt: Number.MAX_SAFE_INTEGER,
  issuedBy: 'system:capability-token-fallback',
  issuedAt: 0,
};

/**
 * Issue a token for a delegated sub-task. Pure function — no side
 * effects. The caller (delegation-router) records the issuance in
 * its audit trail.
 */
export function issueCapabilityToken(args: {
  parentTaskId: string;
  subagentType: SubagentType;
  allowedTools: readonly string[];
  forbiddenTools?: readonly string[];
  allowedPaths?: readonly string[];
  /** Time-to-live in ms; defaults to the parent task's wall-clock budget or 1h. */
  ttlMs?: number;
  issuedBy: string;
  provenance?: Readonly<Record<string, unknown>>;
  /** Test injection. */
  now?: number;
}): CapabilityToken {
  const issuedAt = args.now ?? Date.now();
  const ttlMs = args.ttlMs ?? 60 * 60 * 1000;
  const id = `capability-token:${createHash('sha256')
    .update(`${args.parentTaskId}|${args.subagentType}|${issuedAt}|${args.issuedBy}`)
    .digest('hex')
    .slice(0, 16)}`;
  const baseForbidden: readonly string[] =
    args.subagentType === 'explore' || args.subagentType === 'plan'
      ? [...MUTATION_TOOL_NAMES]
      : ['shell_exec', 'delegate_task'];
  const forbiddenTools = Array.from(
    new Set([...baseForbidden, ...(args.forbiddenTools ?? [])]),
  );
  return {
    id,
    subagentType: args.subagentType,
    allowedTools: [...args.allowedTools],
    forbiddenTools,
    allowedPaths: args.allowedPaths ? [...args.allowedPaths] : [],
    parentTaskId: args.parentTaskId,
    expiresAt: issuedAt + ttlMs,
    issuedBy: args.issuedBy,
    issuedAt,
    ...(args.provenance ? { provenance: args.provenance } : {}),
  };
}

/**
 * Pure check — does this token permit this tool call?
 *
 * Returns `ok: false` with a typed reason on:
 *   - missing token (only enforced when caller explicitly requires it;
 *     legacy paths pass `undefined` to mean "no delegation context",
 *     and the function returns ok: true with tokenId: null)
 *   - expired token
 *   - tool listed in forbiddenTools (highest priority)
 *   - tool not in allowedTools (when allowedTools is non-empty)
 *   - target path not under allowedPaths (when path-scoped + allowedPaths set)
 */
export function checkCapability(req: CapabilityCheckRequest): CapabilityCheckResult {
  const now = req.now ?? Date.now();

  if (!req.token) {
    // Legacy path: no token means top-level task or test fixture — caller
    // takes responsibility. Return ok with null tokenId so the trace
    // can still record "no capability gate active" honestly.
    return { ok: true, tokenId: null };
  }

  const t = req.token;
  if (t.expiresAt <= now) {
    return {
      ok: false,
      reason: 'token_expired',
      detail: `token ${t.id} expired at ${new Date(t.expiresAt).toISOString()}`,
    };
  }

  // Forbidden takes priority over allowed — never let an allowedTools
  // wildcard override an explicit forbid.
  if (t.forbiddenTools.includes(req.toolName)) {
    return {
      ok: false,
      reason: 'tool_forbidden',
      detail: `tool "${req.toolName}" is forbidden under subagentType="${t.subagentType}"`,
    };
  }

  // Empty allowedTools means "use defaults": every tool not in
  // forbiddenTools is allowed. This matches general-purpose's typical
  // intent. For explore/plan, the default issuance pre-populates
  // forbiddenTools with every mutation tool, so the empty list is safe.
  if (t.allowedTools.length > 0 && !t.allowedTools.includes(req.toolName)) {
    return {
      ok: false,
      reason: 'tool_not_allowed',
      detail: `tool "${req.toolName}" not in allowedTools (${t.allowedTools.join(', ')})`,
    };
  }

  // Path scoping — applies to tools with a single target path. The
  // executor passes `req.targetPath`; tools without a path argument
  // omit it.
  if (req.targetPath !== undefined && t.allowedPaths.length > 0) {
    const ok = t.allowedPaths.some((p) => req.targetPath!.startsWith(p));
    if (!ok) {
      return {
        ok: false,
        reason: 'path_out_of_scope',
        detail: `path "${req.targetPath}" not under allowedPaths (${t.allowedPaths.join(', ')})`,
      };
    }
  }

  return { ok: true, tokenId: t.id };
}

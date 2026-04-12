/**
 * Phase 7d-2: Permission DSL — Zod schema for `.vinyan/permissions.json`.
 *
 * A declarative allow/deny layer that sits between contract authorization
 * and the Phase 7d-1 hooks dispatcher. It exists so operators can restrict
 * tool usage without writing shell hooks for the common cases (block writes
 * outside src/, block `rm -rf`, etc.).
 *
 * Semantics (deny-wins):
 *   1. Deny rules are checked first. If any matches, the call is denied.
 *   2. Allow rules are checked. If any matches, the call is explicitly
 *      permitted and the permission layer returns `allow`.
 *   3. If nothing matches, the checker returns `pass` — the decision is
 *      deferred to later layers (hooks, contract). This keeps the DSL
 *      additive: an empty ruleset behaves exactly like no DSL at all.
 *
 * Matching:
 *   - `tool` is an exact tool-name match (not a regex). This keeps rules
 *     predictable; use multiple rules if you need to cover several tools.
 *   - `match` is an optional regex tested against the JSON-stringified
 *     tool input. Omit it to match any invocation of the named tool.
 *   - Invalid regex in `match` is treated as a non-match (fail-open),
 *     mirroring the hook dispatcher's treatment of bad matchers.
 */

import { z } from 'zod/v4';

/**
 * A single permission rule. `tool` is required; `match` and `reason` are
 * optional. Rules are position-insensitive — there is no ordering between
 * rules within a list.
 */
const PermissionRuleSchema = z.object({
  /** Exact tool name this rule applies to (e.g. `file_write`, `shell_exec`). */
  tool: z.string().min(1),
  /**
   * Optional regex (string form) tested against `JSON.stringify(tool_input)`.
   * When omitted, the rule matches any invocation of `tool`.
   */
  match: z.string().optional(),
  /**
   * Optional human-readable reason. Surfaced to the agent loop (and the
   * LLM) when a deny rule fires so the model can course-correct.
   */
  reason: z.string().optional(),
});

/**
 * Root permission-config schema. Both arrays default to empty so a bare
 * `{}` file is functionally equivalent to a missing file.
 */
export const PermissionConfigSchema = z.object({
  /** Rules that, when matched, hard-deny the tool call. */
  deny: z.array(PermissionRuleSchema).default([]),
  /** Rules that, when matched, explicitly allow the tool call. */
  allow: z.array(PermissionRuleSchema).default([]),
});

export type PermissionRule = z.infer<typeof PermissionRuleSchema>;
export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

/** Empty permission config used as the default when no file is present. */
export const EMPTY_PERMISSION_CONFIG: PermissionConfig = PermissionConfigSchema.parse({});

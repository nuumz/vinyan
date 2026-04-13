/**
 * Phase 7d-2: Permission DSL evaluator — decides whether a tool call is
 * denied, explicitly allowed, or unrestricted by the `.vinyan/permissions.json`
 * rules.
 *
 * Deny-wins semantics:
 *   1. Walk deny rules. If any matches, return `{decision: 'deny', reason}`.
 *   2. Walk allow rules. If any matches, return `{decision: 'allow'}`.
 *   3. Otherwise return `{decision: 'pass'}` — the DSL has no opinion and
 *      the agent loop should continue to the next authorization layer.
 *
 * Matching:
 *   - `rule.tool` is compared exactly against the call's tool name.
 *   - `rule.match`, if present, is compiled as a regex and tested against
 *     `JSON.stringify(tool_input)`. Invalid regex is treated as a non-match
 *     (fail-open) so a typo can't wedge the agent.
 */

import type { PermissionConfig, PermissionRule } from './permission-schema.ts';

/** Result of evaluating a tool call against the permission DSL. */
export interface PermissionDecision {
  decision: 'deny' | 'allow' | 'pass';
  /** Populated when `decision === 'deny'`; may be populated for `allow`. */
  reason?: string;
  /** The rule that produced the decision. `undefined` for `pass`. */
  matchedRule?: PermissionRule;
}

/**
 * Evaluate a tool invocation against the permission DSL. Pure function —
 * does no I/O, so it's safe to call per tool call in the hot path.
 */
export function evaluatePermission(config: PermissionConfig, toolName: string, toolInput: unknown): PermissionDecision {
  const serialized = serializeInput(toolInput);

  // Deny rules win. Short-circuit on the first match.
  for (const rule of config.deny) {
    if (ruleMatches(rule, toolName, serialized)) {
      return {
        decision: 'deny',
        reason: rule.reason ?? defaultDenyReason(rule),
        matchedRule: rule,
      };
    }
  }

  // Explicit allow. Short-circuit on the first match.
  for (const rule of config.allow) {
    if (ruleMatches(rule, toolName, serialized)) {
      return { decision: 'allow', matchedRule: rule };
    }
  }

  // No opinion.
  return { decision: 'pass' };
}

/**
 * Check whether a rule matches a tool call. Tool name is matched exactly;
 * `rule.match` (if present) is compiled as a regex and tested against the
 * serialized input. Bad regex patterns are silently skipped.
 */
function ruleMatches(rule: PermissionRule, toolName: string, serializedInput: string): boolean {
  if (rule.tool !== toolName) return false;
  if (rule.match === undefined || rule.match === '') return true;

  let re: RegExp;
  try {
    re = new RegExp(rule.match);
  } catch {
    // Fail-open on bad regex — the rule just doesn't apply.
    return false;
  }
  return re.test(serializedInput);
}

/**
 * Serialize tool input to a string for regex testing. `undefined` / `null`
 * become the empty string so rules with no `match` still work.
 */
function serializeInput(toolInput: unknown): string {
  if (toolInput === undefined || toolInput === null) return '';
  if (typeof toolInput === 'string') return toolInput;
  try {
    return JSON.stringify(toolInput);
  } catch {
    return String(toolInput);
  }
}

/**
 * Fallback reason string when a deny rule didn't supply one. Keeps the
 * message informative for logs and for the LLM's tool_denied event.
 */
function defaultDenyReason(rule: PermissionRule): string {
  if (rule.match) {
    return `Permission DSL denied ${rule.tool} matching /${rule.match}/`;
  }
  return `Permission DSL denied ${rule.tool}`;
}

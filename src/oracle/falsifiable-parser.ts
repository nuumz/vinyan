/**
 * Formal grammar for falsifiable_by conditions — ECP spec §4.5, Appendix D.3.
 *
 * Format: scope:target:event
 * Scopes: file, dependency, env, config, time
 * Events: content-change, version-change, deletion, expiry
 *
 * Source of truth: spec/ecp-spec.md §4.5, Appendix D.3
 */

export type FalsifiabilityScope = 'file' | 'dependency' | 'env' | 'config' | 'time';
export type FalsifiabilityEvent = 'content-change' | 'version-change' | 'deletion' | 'expiry';

export interface FalsifiabilityCondition {
  scope: FalsifiabilityScope;
  target: string;
  event: FalsifiabilityEvent;
}

export interface ParsedCondition {
  condition: FalsifiabilityCondition | null;
  raw: string;
  valid: boolean;
}

const VALID_SCOPES = new Set<string>(['file', 'dependency', 'env', 'config', 'time']);
const VALID_EVENTS = new Set<string>(['content-change', 'version-change', 'deletion', 'expiry']);

/**
 * Parse a single falsifiable_by string into a structured condition.
 * Returns { condition, raw, valid } — invalid strings are preserved as raw for logging.
 */
export function parseFalsifiableCondition(raw: string): ParsedCondition {
  // Format: scope:target:event
  // Target may contain colons (e.g. scoped npm packages @scope/pkg), so we split
  // on first colon (scope) and last colon (event), everything in between is the target.
  const firstColon = raw.indexOf(':');
  if (firstColon === -1) return { condition: null, raw, valid: false };

  const scope = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon === -1) return { condition: null, raw, valid: false };

  const target = rest.slice(0, lastColon);
  const event = rest.slice(lastColon + 1);

  if (!VALID_SCOPES.has(scope) || !VALID_EVENTS.has(event) || !target) {
    return { condition: null, raw, valid: false };
  }

  return {
    condition: {
      scope: scope as FalsifiabilityScope,
      target,
      event: event as FalsifiabilityEvent,
    },
    raw,
    valid: true,
  };
}

/** Parse all falsifiable_by conditions, returning both valid and invalid entries. */
export function parseFalsifiableConditions(conditions: string[]): ParsedCondition[] {
  return conditions.map(parseFalsifiableCondition);
}

/** Extract file paths from parsed conditions (for cascade invalidation wiring). */
export function extractFilePaths(conditions: ParsedCondition[]): string[] {
  const paths = new Set<string>();
  for (const c of conditions) {
    if (c.condition?.scope === 'file') paths.add(c.condition.target);
  }
  return [...paths];
}

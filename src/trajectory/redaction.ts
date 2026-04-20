/**
 * Trajectory Exporter — redaction policy.
 *
 * Policy file location (optional): `$VINYAN_HOME/trajectory-policy.json`.
 * When absent, built-in defaults apply with `version: 'built-in-v1'` so
 * the exporter is usable out of the box.
 *
 * Invariant: redaction is applied BEFORE the artifact is hashed. Because
 * the artifact SHA-256 is recorded in the manifest (and the `trajectory_exports`
 * row), any attempt to bypass redaction changes the hash and is visible to
 * downstream consumers. This is privacy-by-construction, not privacy-by-policy.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Supported redaction rule kinds.
 *
 * - `home-path`: replaces `/Users/<name>/` and `/home/<name>/` prefixes with
 *   the replacement token (typically `<HOME>`).
 * - `high-entropy-token`: replaces runs of alphanumeric/`+/=_-` of at least
 *   `minLength` that look like base64/hex/JWT/API keys.
 * - `env-looking`: replaces `KEY=value` assignments whose key is SCREAMING_CASE
 *   of length >= 6. The default pattern is provided but may be overridden.
 */
export interface HomePathRule {
  kind: 'home-path';
  replacement: string;
}

export interface HighEntropyTokenRule {
  kind: 'high-entropy-token';
  minLength: number;
  replacement: string;
}

export interface EnvLookingRule {
  kind: 'env-looking';
  pattern: string;
  replacement: string;
}

export type RedactionRule = HomePathRule | HighEntropyTokenRule | EnvLookingRule;

export interface RedactionPolicy {
  version: string;
  rules: RedactionRule[];
}

/**
 * Built-in defaults. Rule ordering matters: env-looking runs before
 * high-entropy-token so a `KEY=value` assignment is redacted as a whole
 * `<ENV>` rather than the RHS alone being caught by the entropy rule.
 */
export const BUILT_IN_POLICY: RedactionPolicy = {
  version: 'built-in-v1',
  rules: [
    { kind: 'home-path', replacement: '<HOME>' },
    {
      kind: 'env-looking',
      pattern: '[A-Z][A-Z0-9_]{5,}=\\S+',
      replacement: '<ENV>',
    },
    { kind: 'high-entropy-token', minLength: 24, replacement: '<REDACTED_TOKEN>' },
  ],
};

/**
 * Load a redaction policy from disk. Returns built-in defaults if the file
 * is missing. Throws on malformed policy (intentional — a typo in the
 * operator's policy file should be loud, not silent).
 */
export function loadPolicy(path: string): RedactionPolicy {
  if (!existsSync(path)) {
    return BUILT_IN_POLICY;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid redaction policy at ${path}: expected object`);
  }

  const obj = parsed as { version?: unknown; rules?: unknown };
  if (typeof obj.version !== 'string') {
    throw new Error(`Invalid redaction policy at ${path}: missing/invalid "version"`);
  }
  if (!Array.isArray(obj.rules)) {
    throw new Error(`Invalid redaction policy at ${path}: missing/invalid "rules"`);
  }

  const rules: RedactionRule[] = obj.rules.map((r, i) => validateRule(r, i, path));
  return { version: obj.version, rules };
}

function validateRule(raw: unknown, index: number, path: string): RedactionRule {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid redaction rule [${index}] in ${path}: expected object`);
  }
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const replacement = typeof r.replacement === 'string' ? r.replacement : '';

  if (kind === 'home-path') {
    return { kind: 'home-path', replacement: replacement || '<HOME>' };
  }
  if (kind === 'high-entropy-token') {
    const minLength = typeof r.minLength === 'number' ? r.minLength : 24;
    return {
      kind: 'high-entropy-token',
      minLength,
      replacement: replacement || '<REDACTED_TOKEN>',
    };
  }
  if (kind === 'env-looking') {
    const pattern = typeof r.pattern === 'string' ? r.pattern : '[A-Z][A-Z0-9_]{5,}=\\S+';
    return {
      kind: 'env-looking',
      pattern,
      replacement: replacement || '<ENV>',
    };
  }
  throw new Error(`Invalid redaction rule [${index}] in ${path}: unknown kind ${String(kind)}`);
}

/**
 * Apply all rules in a policy to `text`. Rules are applied in declaration
 * order; later rules see the output of earlier rules. This lets the
 * env-looking rule redact the RHS of `KEY=value` before the high-entropy
 * pass tries to match an already-redacted token.
 */
export function applyPolicy(text: string, policy: RedactionPolicy): string {
  let out = text;
  for (const rule of policy.rules) {
    out = applyRule(out, rule);
  }
  return out;
}

function applyRule(text: string, rule: RedactionRule): string {
  switch (rule.kind) {
    case 'home-path':
      // /Users/<name>/ and /home/<name>/ — capture just the prefix.
      return text.replace(/\/(?:Users|home)\/[^/\s"']+/g, rule.replacement);

    case 'high-entropy-token': {
      // Character class: base64 alphabet + hex + JWT/API key common chars.
      const re = new RegExp(`[A-Za-z0-9+/=_\\-]{${rule.minLength},}`, 'g');
      return text.replace(re, (match) => (looksHighEntropy(match) ? rule.replacement : match));
    }

    case 'env-looking': {
      // env-looking rules may carry user-supplied regex — if invalid, skip
      // rather than throw, matching the "fail-open for bad matchers"
      // pattern used elsewhere in the codebase.
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'g');
      } catch {
        return text;
      }
      return text.replace(re, rule.replacement);
    }
  }
}

/**
 * Heuristic: does the string look high-entropy enough to be a secret?
 * We don't want to redact all long alphanumeric words (file paths, variable
 * names). A loose entropy floor filters out plain English / camelCase tokens.
 */
function looksHighEntropy(s: string): boolean {
  if (s.length < 24) return false;
  // Count distinct character classes present.
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  const hasSym = /[+/=_-]/.test(s);
  const classes = [hasLower, hasUpper, hasDigit, hasSym].filter(Boolean).length;
  if (classes >= 3) return true;
  // Fallback: a long mixed-case string with digits passes.
  if (hasDigit && (hasLower || hasUpper) && s.length >= 32) return true;
  return false;
}

/**
 * Hash a policy into a stable SHA-256 of its canonical JSON form. Canonical
 * means keys are sorted so object-key reordering does not perturb the hash.
 * This hash is recorded in both the on-disk manifest and the DB pointer row
 * so the policy in effect at export time is auditable after the fact.
 */
export function hashPolicy(policy: RedactionPolicy): string {
  const canonical = canonicalStringify({
    version: policy.version,
    rules: policy.rules.map(canonicalizeRule),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalizeRule(rule: RedactionRule): Record<string, unknown> {
  // Re-emit with a fixed key order so inputs that differ only in key order
  // hash identically.
  switch (rule.kind) {
    case 'home-path':
      return { kind: rule.kind, replacement: rule.replacement };
    case 'high-entropy-token':
      return {
        kind: rule.kind,
        minLength: rule.minLength,
        replacement: rule.replacement,
      };
    case 'env-looking':
      return {
        kind: rule.kind,
        pattern: rule.pattern,
        replacement: rule.replacement,
      };
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

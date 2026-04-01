/**
 * Simple glob matching — supports * wildcard only.
 * Properly escapes ALL regex metacharacters before converting * to .*
 */
export function simpleGlobMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

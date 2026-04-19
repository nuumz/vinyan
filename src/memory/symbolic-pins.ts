/**
 * Symbolic pin resolver — surfaces exact turns that a user explicitly
 * references in their message via `@file:`, `#task-id`, or `@turn:<id>`.
 *
 * Plan commit E.
 */

export interface SymbolicPin {
  kind: 'file' | 'task' | 'turn';
  value: string;
  start: number;
  end: number;
}

const PIN_PATTERNS: Array<{ kind: SymbolicPin['kind']; regex: RegExp }> = [
  { kind: 'file', regex: /@file:([A-Za-z0-9_./\-]+)/g },
  { kind: 'turn', regex: /@turn:([A-Za-z0-9_\-]+)/g },
  { kind: 'task', regex: /#([A-Za-z0-9][A-Za-z0-9_\-]{2,})/g },
  { kind: 'file', regex: /@([A-Za-z0-9_\-][A-Za-z0-9_./\-]*(?:\/[A-Za-z0-9_./\-]+|\.[A-Za-z0-9]+))/g },
];

export function extractPins(message: string): SymbolicPin[] {
  const pins: SymbolicPin[] = [];
  const seen = new Set<string>();

  for (const { kind, regex } of PIN_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(message)) !== null) {
      const value = match[1]!;
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pins.push({
        kind,
        value,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  pins.sort((a, b) => a.start - b.start);
  return pins;
}

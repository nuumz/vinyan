/**
 * MemorySnapshot contract — Hermes-style frozen capture.
 *
 * Verifies:
 *   - snapshot is deeply frozen (entries array is immutable)
 *   - contentHash is stable for identical input, distinct for changed input
 *   - empty / null inputs collapse to a single hash bucket
 *   - duplicate detection on normalised text
 *   - safety verdict flags hidden unicode + credential patterns + destructive shell
 *   - capture without filesystem returns the preloaded snapshot intact
 */
import { describe, expect, test } from 'bun:test';
import {
  captureMemorySnapshot,
  isDuplicateMemoryEntry,
  isMemorySnapshotEquivalent,
  memorySafetyVerdict,
} from '../../src/memory/snapshot.ts';
import type { AutoMemory, AutoMemoryEntry } from '../../src/memory/auto-memory-loader.ts';

function entry(overrides: Partial<AutoMemoryEntry> = {}): AutoMemoryEntry {
  return {
    type: 'user',
    ref: 'user_role.md',
    absolutePath: '/tmp/MEMORY.d/user_role.md',
    description: 'role',
    content: 'user is a senior engineer',
    sanitized: false,
    originalBytes: 25,
    truncated: false,
    linterWarnings: [],
    hasStrongWarning: false,
    ...overrides,
  };
}

function autoMemory(entries: AutoMemoryEntry[], indexContent = '# index'): AutoMemory {
  return {
    entrypoint: '/tmp/MEMORY.md',
    indexContent,
    entries,
    indexTruncated: false,
    totalBytes: indexContent.length + entries.reduce((acc, e) => acc + e.content.length, 0),
    trustTier: 'probabilistic',
    loadedAt: 1_700_000_000_000,
  };
}

describe('captureMemorySnapshot', () => {
  test('preloaded snapshot is frozen at the wrapper and entries level', () => {
    const am = autoMemory([entry()]);
    const snap = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: am });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap.autoMemory).not.toBeNull();
    expect(Object.isFrozen(snap.autoMemory)).toBe(true);
    expect(Object.isFrozen(snap.autoMemory!.entries)).toBe(true);

    // A push into the frozen array must throw in strict mode (test files
    // run with strict TS modules). Wrap in a function so jest sees the
    // throw cleanly.
    expect(() => {
      (snap.autoMemory!.entries as unknown as AutoMemoryEntry[]).push(entry({ ref: 'x' }));
    }).toThrow();
  });

  test('contentHash is stable for byte-equal preloaded snapshots', () => {
    const am1 = autoMemory([entry({ content: 'A' })]);
    const am2 = autoMemory([entry({ content: 'A' })]);
    const snap1 = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: am1 });
    const snap2 = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: am2 });
    expect(snap1.contentHash).toBe(snap2.contentHash);
    expect(isMemorySnapshotEquivalent(snap1, snap2)).toBe(true);
  });

  test('contentHash differs when an entry mutates after the original capture', () => {
    const am = autoMemory([entry({ content: 'A' })]);
    const before = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: am });
    // Simulate "later in the same session, the user wrote new memory" —
    // a fresh capture returns a new hash, but the original snapshot
    // is unaffected (it keeps the old hash + frozen entries).
    const am2 = autoMemory([entry({ content: 'A and a new fact' })]);
    const after = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: am2 });
    expect(after.contentHash).not.toBe(before.contentHash);
    // The original snapshot is untouched.
    expect(before.autoMemory!.entries[0]?.content).toBe('A');
    expect(before.entryCount).toBe(1);
    expect(before.characterCount).toBeGreaterThan(0);
  });

  test('null preloaded → empty-bucket hash matches across calls', () => {
    const a = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: null });
    const b = captureMemorySnapshot({ workspace: '/tmp/y', preloaded: null });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.entryCount).toBe(0);
    expect(a.characterCount).toBe(0);
  });

  test('profile is recorded on the snapshot', () => {
    const am = autoMemory([entry()]);
    const snap = captureMemorySnapshot({ workspace: '/tmp/x', profile: 'team-alpha', preloaded: am });
    expect(snap.profile).toBe('team-alpha');
  });

  test('default profile is "default" when none provided', () => {
    const snap = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: null });
    expect(snap.profile).toBe('default');
  });

  test('snapshot capturedAt is monotonic relative to wall clock', () => {
    const before = Date.now();
    const snap = captureMemorySnapshot({ workspace: '/tmp/x', preloaded: null });
    const after = Date.now();
    expect(snap.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snap.capturedAt).toBeLessThanOrEqual(after);
  });
});

describe('isDuplicateMemoryEntry', () => {
  test('case-insensitive normalised match returns true', () => {
    expect(isDuplicateMemoryEntry(['User is a senior engineer'], 'user is a SENIOR  engineer')).toBe(true);
    expect(isDuplicateMemoryEntry(['lorem ipsum'], 'LOREM\tIPSUM')).toBe(true);
  });

  test('distinct content returns false', () => {
    expect(isDuplicateMemoryEntry(['user prefers Thai'], 'user prefers Japanese')).toBe(false);
  });

  test('empty candidate is treated as duplicate (no-op write)', () => {
    expect(isDuplicateMemoryEntry(['anything'], '   \n')).toBe(true);
  });
});

describe('memorySafetyVerdict', () => {
  test('flags hidden unicode bidi controls', () => {
    const verdict = memorySafetyVerdict('user note ‮ reversed');
    expect(verdict.safe).toBe(false);
    expect(verdict.flags).toContain('hidden-unicode');
  });

  test('flags zero-width tokens', () => {
    const verdict = memorySafetyVerdict('plain​text');
    expect(verdict.flags).toContain('hidden-unicode');
  });

  test('flags credential-shaped tokens', () => {
    expect(memorySafetyVerdict('key sk-AAAAAAAAAAAAAAAAAAAA').flags).toContain('credential:openai');
    expect(memorySafetyVerdict('use ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').flags).toContain('credential:github');
    expect(memorySafetyVerdict('AKIAEXAMPLEACCESSKEY').flags).toContain('credential:aws');
    expect(memorySafetyVerdict('Authorization: Bearer eyJabc1234567890').flags).toContain('credential:jwt');
    expect(memorySafetyVerdict('password=hunter2').flags).toContain('credential:keyvalue');
  });

  test('flags destructive shell pattern but does NOT block (informational)', () => {
    const verdict = memorySafetyVerdict('lesson: never run rm -rf /');
    expect(verdict.flags).toContain('destructive-shell-pattern');
    expect(verdict.safe).toBe(true);
  });

  test('clean text yields safe=true and zero flags', () => {
    const verdict = memorySafetyVerdict('user prefers Thai language for chat');
    expect(verdict.safe).toBe(true);
    expect(verdict.flags.length).toBe(0);
  });
});

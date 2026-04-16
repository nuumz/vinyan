/**
 * Room isolation invariant — R0 guard test.
 *
 * Asserts that no source file OUTSIDE `src/orchestrator/room/` imports from
 * `src/orchestrator/room/*`. R0 is a pure library; R1 is the first phase
 * permitted to wire it into the rest of the orchestrator. Once R1 lands,
 * the allowlist below will expand to include exactly the wiring points
 * (`phase-generate.ts`, `factory.ts`, `task-decomposer.ts`, etc).
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC = join(REPO_ROOT, 'src');
const ROOM_DIR = join(SRC, 'orchestrator', 'room');

/** Files outside src/orchestrator/room/ that ARE allowed to import from it.
 *  R0 expects this to be empty. R1 will add phase-generate.ts, factory.ts, etc. */
const ALLOWLIST: string[] = [];

function walkTs(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTs(full, files);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

function fileImportsRoom(path: string): boolean {
  const content = readFileSync(path, 'utf-8');
  // Accept any import specifier containing /room/ or /room.ts; scoped to
  // the orchestrator subtree so unrelated paths elsewhere don't match.
  return /from\s+['"][^'"]*orchestrator\/room\/[^'"]+['"]/.test(content);
}

describe('Room isolation invariant', () => {
  it('no source file outside src/orchestrator/room/ imports from it (R0 gate)', () => {
    const allTsFiles = walkTs(SRC);
    const violators: string[] = [];
    for (const file of allTsFiles) {
      const rel = relative(REPO_ROOT, file);
      if (file.startsWith(ROOM_DIR)) continue; // inside the room module — allowed
      if (ALLOWLIST.includes(rel)) continue;
      if (fileImportsRoom(file)) violators.push(rel);
    }
    if (violators.length > 0) {
      // Surface the violators in the assertion message for debuggability.
      throw new Error(
        `R0 isolation violated — ${violators.length} file(s) outside src/orchestrator/room/ import from it:\n  ${violators.join('\n  ')}`,
      );
    }
    expect(violators).toHaveLength(0);
  });

  it('room/ module exists and contains the expected files', () => {
    const expected = [
      'types.ts',
      'room-ledger.ts',
      'room-blackboard.ts',
      'room-selector.ts',
      'room-supervisor.ts',
      'room-dispatcher.ts',
    ];
    const actual = readdirSync(ROOM_DIR);
    for (const name of expected) {
      expect(actual).toContain(name);
    }
  });
});

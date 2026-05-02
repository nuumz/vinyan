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
 *  R1 wiring: factory.ts + task-decomposer.ts import room-dispatcher + room-selector.
 *  R2 persistence: room-store.ts imports room/types for LedgerEntry.
 *  Multi-agent collaboration (workflow-native): workflow-planner.ts imports
 *  the debate-room preset to build a deterministic plan from a
 *  CollaborationDirective — collaboration is now expressed as a
 *  WorkflowPlan.collaborationBlock, executed by the main workflow
 *  executor. The legacy collaboration-runner fork has been removed. */
const ALLOWLIST: string[] = [
  'src/orchestrator/factory.ts',
  'src/orchestrator/task-decomposer.ts',
  'src/orchestrator/workflow/workflow-planner.ts',
  'src/db/room-store.ts',
];

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
  // Match BOTH absolute-style (`orchestrator/room/`) and relative (`./room/`,
  // `../room/`) import specifiers. R1/R2 wiring files are in ALLOWLIST.
  return (
    /from\s+['"][^'"]*orchestrator\/room\/[^'"]+['"]/.test(content) ||
    /from\s+['"][^'"]*\/room\/room-[^'"]+['"]/.test(content) ||
    /from\s+['"][^'"]*\/room\/types[^'"]*['"]/.test(content)
  );
}

describe('Room isolation invariant', () => {
  it('only allowlisted files outside src/orchestrator/room/ may import from it', () => {
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

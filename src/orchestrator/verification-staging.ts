/**
 * Verification staging — materialize proposed mutations into an ephemeral
 * copy of the workspace so deterministic oracles (tsc/ast/lint/test) verify
 * the PROPOSED tree, not the pre-mutation disk state.
 *
 * Without this, online verification is epistemically hollow: the mutation
 * lives in memory while every blocking oracle reads the unchanged workspace,
 * so type errors, hallucinated symbols, and broken callers in the proposal
 * are invisible until after commit (A1 violation in effect).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';

/** Directories never copied into the staged tree. `node_modules` is symlinked
 *  back to the real workspace so tsc/test runners still resolve packages. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.vinyan']);

export interface StagedWorkspace {
  /** Absolute path of the staged tree — pass this as the gate workspace. */
  path: string;
  /** Remove the staged tree. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Copy `workspace` into a temp dir (excluding node_modules/.git/.vinyan),
 * symlink node_modules back, and apply all `mutations` on top.
 */
export function createStagedWorkspace(
  workspace: string,
  mutations: Array<{ file: string; content: string }>,
): StagedWorkspace {
  const stagingDir = mkdtempSync(join(tmpdir(), 'vinyan-verify-'));

  cpSync(workspace, stagingDir, {
    recursive: true,
    filter: (src) => !EXCLUDED_DIRS.has(basename(src)),
  });

  const nodeModules = join(workspace, 'node_modules');
  if (existsSync(nodeModules)) {
    symlinkSync(nodeModules, join(stagingDir, 'node_modules'), 'dir');
  }

  for (const mutation of mutations) {
    const target = resolve(stagingDir, mutation.file);
    // Refuse path escapes — a mutation must land inside the staged tree.
    if (!target.startsWith(stagingDir)) {
      throw new Error(`Mutation path escapes staged workspace: ${mutation.file}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mutation.content);
  }

  return {
    path: stagingDir,
    cleanup: () => {
      rmSync(stagingDir, { recursive: true, force: true });
    },
  };
}

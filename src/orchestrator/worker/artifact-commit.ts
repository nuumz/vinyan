/**
 * Artifact Commit Protocol — safely apply container worker outputs to workspace.
 *
 * 4-step safety check before applying each artifact:
 * 1. Path must be relative (reject absolute paths)
 * 2. Path must not contain '..' segments (reject traversal)
 * 3. realpath(resolve(workspace, path)) must start with workspace
 * 4. Target must not be a symlink (reject symlink attacks)
 *
 * Reuses containment logic from tool-validator.ts:42-46.
 *
 * Source of truth: spec/tdd.md §11, design/implementation-plan.md §2.1
 *
 * ── Agent vocabulary + axiom hooks ────────────────────────────────────
 * This module is the canonical commit gate. Two RFC hooks are wired here:
 *   - A11 (Capability Escalation) stub — emits
 *     `commit:capability_escalation_evaluated` post-preflight, pre-write.
 *     Today the decision is always 'allow'; future enforcement attaches
 *     here without a code change.
 *   - Gap 4 (Dormant Pending Reload) — emits
 *     `commit:dormant_pending_reload` after Pass 2 succeeds when a
 *     written path lands under `src/orchestrator/` or `src/core/` (the
 *     running orchestrator's own code). UI surfaces "this change
 *     requires reload".
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import type { VinyanBus } from '../../core/bus.ts';

export interface ArtifactFile {
  /** Relative path within workspace */
  path: string;
  /** File content */
  content: string;
}

export interface CommitResult {
  applied: string[];
  rejected: Array<{ path: string; reason: string }>;
}

/**
 * Optional per-call dependencies. Existing callers that pass only
 * (workspace, artifacts) preserve byte-identical behavior — the bus +
 * taskId surface is opt-in for A11/Gap-4 wiring.
 */
export interface CommitArtifactsOptions {
  /** Bus for emitting A11 stub + Gap 4 dormant-pending-reload events. */
  bus?: VinyanBus;
  /** Task id, threaded into events for traceability. */
  taskId?: string;
  /** Actor performing the commit (worker id, persona id, 'system', 'user:<id>'). */
  actor?: string;
  /**
   * Gap 7 — when true, the writer takes a snapshot of pre-existing file
   * contents and restores them on partial Pass 2 failure. Default false
   * preserves the MVP contract (no rollback) for existing callers.
   */
  rollbackOnPartialFailure?: boolean;
}

/** Path prefixes that, when written, render the running orchestrator stale. */
const RELOAD_REQUIRED_PREFIXES = ['src/orchestrator/', 'src/core/', 'src/api/', 'src/cli/'];

function pathRequiresReload(p: string): boolean {
  return RELOAD_REQUIRED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Validate and apply artifact files to the workspace.
 *
 * Two-pass fail-closed contract (T3.b):
 * 1. Preflight — validate every artifact path. If ANY path is rejected, write nothing
 *    and return all invalid paths in `rejected` with `applied` empty.
 * 2. Apply — only when preflight is fully clean, write all files. Per-file write errors
 *    are still reported in `rejected`; previously-written files in the same batch
 *    remain on disk (rollback is explicitly out of scope for the MVP).
 */
export function commitArtifacts(
  workspace: string,
  artifacts: ArtifactFile[],
  opts: CommitArtifactsOptions = {},
): CommitResult {
  // Pass 1: preflight all paths before any write.
  const preflightRejected: CommitResult['rejected'] = [];
  for (const artifact of artifacts) {
    const validation = validateArtifactPath(workspace, artifact.path);
    if (!validation.valid) {
      preflightRejected.push({ path: artifact.path, reason: validation.reason! });
    }
  }

  if (preflightRejected.length > 0) {
    return { applied: [], rejected: preflightRejected };
  }

  // A11 RFC stub (proposed, not yet load-bearing) — emit the capability
  // escalation evaluation event. Future enforcement attaches here without
  // a code change. Today the decision is always 'allow'; the gate fires
  // post-preflight, pre-write so a 'deny' verdict would block writes.
  if (opts.bus && opts.taskId && opts.actor) {
    opts.bus.emit('commit:capability_escalation_evaluated', {
      taskId: opts.taskId,
      actor: opts.actor,
      targets: artifacts.map((a) => a.path),
      decision: 'allow',
      reason: 'A11 RFC stub — no enforcement yet',
    });
  }

  // Gap 7 — optional rollback snapshot. Pre-write capture of existing
  // file content so partial-failure restoration is possible.
  const snapshots: Array<{ absPath: string; existed: boolean; content?: Buffer }> = [];
  if (opts.rollbackOnPartialFailure) {
    for (const artifact of artifacts) {
      const absPath = resolve(workspace, artifact.path);
      if (existsSync(absPath)) {
        try {
          snapshots.push({ absPath, existed: true, content: readFileSync(absPath) });
        } catch {
          snapshots.push({ absPath, existed: true });
        }
      } else {
        snapshots.push({ absPath, existed: false });
      }
    }
  }

  // Pass 2: write all artifacts now that preflight is clean.
  const applied: string[] = [];
  const rejected: CommitResult['rejected'] = [];
  for (const artifact of artifacts) {
    try {
      const absPath = resolve(workspace, artifact.path);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, artifact.content);
      applied.push(artifact.path);
    } catch (err) {
      rejected.push({
        path: artifact.path,
        reason: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Gap 7 — on partial failure, restore snapshots.
  if (opts.rollbackOnPartialFailure && rejected.length > 0 && applied.length > 0) {
    for (const snap of snapshots) {
      try {
        if (snap.existed && snap.content) {
          writeFileSync(snap.absPath, snap.content);
        } else if (!snap.existed && existsSync(snap.absPath)) {
          unlinkSync(snap.absPath);
        }
      } catch {
        // Best-effort: a rollback that itself fails is recorded as a
        // rejected entry so callers can surface the inconsistent state.
        rejected.push({
          path: snap.absPath,
          reason: 'rollback failed — workspace may be in inconsistent state',
        });
      }
    }
    // After rollback, no artifacts are considered "applied" — the user
    // sees an all-or-nothing outcome, which is the contract we promised.
    return { applied: [], rejected };
  }

  // Gap 4 — emit dormant-pending-reload event when committed paths affect
  // the running orchestrator's code. Fires only on partial-or-full success;
  // callers / UI surface a "reload required" indicator.
  if (opts.bus && opts.taskId && applied.length > 0) {
    const reloadPaths = applied.filter(pathRequiresReload);
    if (reloadPaths.length > 0) {
      opts.bus.emit('commit:dormant_pending_reload', {
        taskId: opts.taskId,
        affectedPaths: reloadPaths,
      });
    }
  }

  return { applied, rejected };
}

/**
 * Validate a single artifact path against the 4-step safety protocol.
 */
export function validateArtifactPath(workspace: string, artifactPath: string): { valid: boolean; reason?: string } {
  // Step 1: Reject absolute paths
  if (isAbsolute(artifactPath)) {
    return { valid: false, reason: `Absolute path '${artifactPath}' is not allowed` };
  }

  // Step 2: Reject '..' segments (before resolution)
  const segments = artifactPath.split('/');
  if (segments.includes('..')) {
    return { valid: false, reason: `Path '${artifactPath}' contains '..' traversal` };
  }

  // Step 3: Workspace containment (after resolution)
  // Resolve workspace through realpath to handle macOS /var → /private/var
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    realWorkspace = workspace;
  }
  const absPath = resolve(realWorkspace, artifactPath);
  const normalizedWorkspace = realWorkspace.endsWith('/') ? realWorkspace : `${realWorkspace}/`;
  if (!absPath.startsWith(normalizedWorkspace) && absPath !== realWorkspace) {
    return { valid: false, reason: `Path '${artifactPath}' escapes workspace` };
  }

  // Step 4: Reject symlinks at target (if file exists)
  try {
    const stat = lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      return { valid: false, reason: `Path '${artifactPath}' is a symlink` };
    }
  } catch {
    // File doesn't exist yet — that's fine for new files
  }

  // Step 5: Verify parent directory resolves within workspace (symlink-in-parent escape)
  try {
    const parentDir = dirname(absPath);
    const realParent = realpathSync(parentDir);
    const normalizedParent = realParent.endsWith('/') ? realParent : `${realParent}/`;
    if (!normalizedParent.startsWith(normalizedWorkspace) && realParent !== realWorkspace) {
      return { valid: false, reason: `Parent directory of '${artifactPath}' resolves outside workspace` };
    }
  } catch {
    // Parent doesn't exist yet — mkdirSync will create it within workspace (Step 3 already validated lexical containment)
  }

  return { valid: true };
}

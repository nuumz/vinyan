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
 */
import { resolve, isAbsolute } from "path";
import { writeFileSync, lstatSync, mkdirSync, realpathSync } from "fs";
import { dirname } from "path";

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
 * Validate and apply artifact files to the workspace.
 * Returns which files were applied and which were rejected with reasons.
 */
export function commitArtifacts(
  workspace: string,
  artifacts: ArtifactFile[],
): CommitResult {
  const applied: string[] = [];
  const rejected: CommitResult["rejected"] = [];

  for (const artifact of artifacts) {
    const validation = validateArtifactPath(workspace, artifact.path);
    if (!validation.valid) {
      rejected.push({ path: artifact.path, reason: validation.reason! });
      continue;
    }

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

  return { applied, rejected };
}

/**
 * Validate a single artifact path against the 4-step safety protocol.
 */
export function validateArtifactPath(
  workspace: string,
  artifactPath: string,
): { valid: boolean; reason?: string } {
  // Step 1: Reject absolute paths
  if (isAbsolute(artifactPath)) {
    return { valid: false, reason: `Absolute path '${artifactPath}' is not allowed` };
  }

  // Step 2: Reject '..' segments (before resolution)
  const segments = artifactPath.split("/");
  if (segments.includes("..")) {
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
  const normalizedWorkspace = realWorkspace.endsWith("/") ? realWorkspace : realWorkspace + "/";
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
    const normalizedParent = realParent.endsWith("/") ? realParent : realParent + "/";
    if (!normalizedParent.startsWith(normalizedWorkspace) && realParent !== realWorkspace) {
      return { valid: false, reason: `Parent directory of '${artifactPath}' resolves outside workspace` };
    }
  } catch {
    // Parent doesn't exist yet — mkdirSync will create it within workspace (Step 3 already validated lexical containment)
  }

  return { valid: true };
}

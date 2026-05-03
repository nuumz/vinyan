/**
 * Content Hash Verifier — Wave C3. Pre-aggregation step that verifies
 * oracle verdict fileHashes against actual file content on disk.
 *
 * A4: Content-addressed truth is now VERIFIED, not just computed.
 * A3: Pure function (deterministic SHA-256 comparison). No LLM.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VinyanBus } from '../core/bus.ts';
import type { OracleVerdict } from '../core/types.ts';

export interface HashMismatch {
  oracleName: string;
  file: string;
  expected: string;
  actual: string;
}

export interface ContentHashVerification {
  passed: boolean;
  mismatches: HashMismatch[];
}

export interface VerifyFileHashResult {
  match: boolean;
  /** SHA-256 of the file's current content (or `<read-error>` on read failure). */
  actual: string;
  /** True when the file was missing on disk; `actual` then equals sha256(''). */
  missing: boolean;
}

/**
 * Hash one file under a workspace and compare to an expected sha256.
 * Pure (no bus, no event), reusable across the oracle verifier and the
 * `/api/v1/files/check-hash` HTTP endpoint that the audit-view evidence
 * chip calls on click. Workspace-relative paths only — callers are
 * responsible for the workspace boundary check upstream.
 */
export function verifyFileHash(workspace: string, relativePath: string, expected: string): VerifyFileHashResult {
  const absPath = resolve(workspace, relativePath);
  let actual: string;
  let missing = false;
  try {
    if (!existsSync(absPath)) {
      missing = true;
      actual = createHash('sha256').update('').digest('hex');
    } else {
      const content = readFileSync(absPath, 'utf-8');
      actual = createHash('sha256').update(content).digest('hex');
    }
  } catch {
    actual = '<read-error>';
  }
  return { match: actual === expected, actual, missing };
}

/**
 * Verify oracle verdict fileHashes against actual file content.
 *
 * For each oracle verdict that has `fileHashes` entries:
 * - Read the file from disk and compute SHA-256
 * - Compare against the hash in the verdict
 * - Mismatch → collect into mismatches, mark as failed
 *
 * Missing files are treated as mismatches (file may have been deleted
 * between oracle execution and verification).
 *
 * @param oracleResults - Oracle verdicts keyed by oracle name
 * @param workspace - Absolute path to workspace root
 * @returns Verification result with pass/fail and mismatch details
 */
export function verifyContentHashes(
  oracleResults: Record<string, OracleVerdict>,
  workspace: string,
): ContentHashVerification {
  const mismatches: HashMismatch[] = [];

  for (const [oracleName, verdict] of Object.entries(oracleResults)) {
    if (!verdict.fileHashes) continue;

    for (const [filePath, expectedHash] of Object.entries(verdict.fileHashes)) {
      if (!expectedHash) continue;
      const { match, actual } = verifyFileHash(workspace, filePath, expectedHash);
      if (!match) {
        mismatches.push({ oracleName, file: filePath, expected: expectedHash, actual });
      }
    }
  }

  return {
    passed: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Apply content hash verification results to oracle verdicts.
 * Mismatched verdicts are marked as `verified: false`.
 * Emits `gate:content_hash_mismatch` for each mismatch.
 */
export function applyContentHashVerification(
  oracleResults: Record<string, OracleVerdict>,
  verification: ContentHashVerification,
  bus?: VinyanBus,
): void {
  if (verification.passed) return;

  const affectedOracles = new Set(verification.mismatches.map((m) => m.oracleName));

  for (const oracleName of affectedOracles) {
    const verdict = oracleResults[oracleName];
    if (verdict && verdict.verified) {
      oracleResults[oracleName] = {
        ...verdict,
        verified: false,
        reason: `Content hash mismatch: file changed after oracle execution`,
      };
    }
  }

  for (const mismatch of verification.mismatches) {
    bus?.emit('gate:content_hash_mismatch', {
      file: mismatch.file,
      oracleName: mismatch.oracleName,
      expected: mismatch.expected,
      actual: mismatch.actual,
    });
  }
}

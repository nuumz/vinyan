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
import type { OracleVerdict } from '../core/types.ts';
import type { VinyanBus } from '../core/bus.ts';

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

      const absPath = resolve(workspace, filePath);
      let actualHash: string;

      try {
        if (!existsSync(absPath)) {
          // File missing — hash of empty string as sentinel
          actualHash = createHash('sha256').update('').digest('hex');
        } else {
          const content = readFileSync(absPath, 'utf-8');
          actualHash = createHash('sha256').update(content).digest('hex');
        }
      } catch {
        // Read failure — treat as mismatch
        actualHash = '<read-error>';
      }

      if (actualHash !== expectedHash) {
        mismatches.push({ oracleName, file: filePath, expected: expectedHash, actual: actualHash });
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

/**
 * Go compiler/vet output → OracleVerdict mapper.
 *
 * Parses `go build -json` and `go vet -json` output.
 * Go's JSON build output emits one JSON object per line (NDJSON).
 * Each object has: {ImportPath, Action, Output?, Elapsed?}
 *
 * For type errors, we parse the plain-text output from `go build` stderr,
 * which follows the pattern: `file.go:line:col: message`.
 */

import { z } from 'zod/v4';
import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import type { Evidence, OracleVerdict } from '../../core/types.ts';

const BASE_RATE = 0.5;
const TTL_MS = 600_000;

/** Go compiler error line pattern: file.go:line:col: message */
const GO_ERROR_PATTERN = /^(.+\.go):(\d+):(\d+):\s*(.+)$/;

/** Go vet JSON output entry. */
export const GoVetEntrySchema = z.object({
  posn: z.string().optional(), // "file.go:line:col"
  message: z.string().optional(),
});

export type GoVetEntry = z.infer<typeof GoVetEntrySchema>;

/**
 * Parse Go compiler stderr (plain text error lines) → OracleVerdict.
 */
export function parseGoBuildOutput(stderr: string, exitCode: number, durationMs: number): OracleVerdict {
  if (exitCode === 0) {
    return buildVerdict({
      verified: true,
      type: 'known',
      confidence: 1.0,
      opinion: fromScalar(1.0, BASE_RATE),
      temporalContext: {
        validFrom: Date.now(),
        validUntil: Date.now() + TTL_MS,
        decayModel: 'exponential' as const,
        halfLife: 300_000,
      },
      evidence: [],
      fileHashes: {},
      durationMs,
    });
  }

  const lines = stderr.split('\n').filter((l) => l.trim());
  const evidence: Evidence[] = [];

  for (const line of lines) {
    const match = GO_ERROR_PATTERN.exec(line);
    if (match) {
      evidence.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        snippet: match[4]!,
      });
    }
  }

  // If we found structured errors, report them
  if (evidence.length > 0) {
    return buildVerdict({
      verified: false,
      type: 'known',
      confidence: 1.0,
      opinion: fromScalar(1.0, BASE_RATE),
      temporalContext: {
        validFrom: Date.now(),
        validUntil: Date.now() + TTL_MS,
        decayModel: 'exponential' as const,
        halfLife: 300_000,
      },
      evidence,
      fileHashes: {},
      reason: `${evidence.length} compilation error(s) found`,
      errorCode: 'TYPE_MISMATCH',
      durationMs,
    });
  }

  // Non-zero exit but no parseable errors — report raw stderr
  return buildVerdict({
    verified: false,
    type: 'known',
    confidence: 0.9,
    opinion: fromScalar(0.9, BASE_RATE),
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential' as const,
      halfLife: 300_000,
    },
    evidence: [],
    fileHashes: {},
    reason: stderr.slice(0, 500) || 'go build failed with no parseable output',
    errorCode: 'BUILD_FAILED',
    durationMs,
  });
}

/**
 * Parse `go vet` stderr output → OracleVerdict.
 * go vet outputs diagnostics in the format: file.go:line:col: message
 */
export function parseGoVetOutput(stderr: string, exitCode: number, durationMs: number): OracleVerdict {
  if (exitCode === 0) {
    return buildVerdict({
      verified: true,
      type: 'known',
      confidence: 1.0,
      opinion: fromScalar(1.0, BASE_RATE),
      temporalContext: {
        validFrom: Date.now(),
        validUntil: Date.now() + TTL_MS,
        decayModel: 'exponential' as const,
        halfLife: 300_000,
      },
      evidence: [],
      fileHashes: {},
      durationMs,
    });
  }

  const lines = stderr.split('\n').filter((l) => l.trim());
  const evidence: Evidence[] = [];

  for (const line of lines) {
    const match = GO_ERROR_PATTERN.exec(line);
    if (match) {
      evidence.push({
        file: match[1]!,
        line: parseInt(match[2]!, 10),
        snippet: `[vet] ${match[4]!}`,
      });
    }
  }

  return buildVerdict({
    verified: evidence.length === 0,
    type: 'known',
    confidence: evidence.length > 0 ? 1.0 : 0.9,
    opinion: fromScalar(evidence.length > 0 ? 1.0 : 0.9, BASE_RATE),
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential' as const,
      halfLife: 300_000,
    },
    evidence,
    fileHashes: {},
    reason: evidence.length > 0 ? `${evidence.length} vet issue(s) found` : undefined,
    errorCode: evidence.length > 0 ? 'VET_VIOLATION' : undefined,
    durationMs,
  });
}

/**
 * Check if go.mod is tidy by running `go mod tidy -diff` (Go 1.22+)
 * or comparing go.sum before/after. Returns verdict based on exit code.
 */
export function parseGoModTidyOutput(stdout: string, exitCode: number, durationMs: number): OracleVerdict {
  // `go mod tidy -diff` exits non-zero and prints diff if go.mod needs changes
  if (exitCode === 0 && !stdout.trim()) {
    return buildVerdict({
      verified: true,
      type: 'known',
      confidence: 1.0,
      opinion: fromScalar(1.0, BASE_RATE),
      temporalContext: {
        validFrom: Date.now(),
        validUntil: Date.now() + TTL_MS,
        decayModel: 'exponential' as const,
        halfLife: 300_000,
      },
      evidence: [],
      fileHashes: {},
      durationMs,
    });
  }

  const evidence: Evidence[] = [];
  if (stdout.trim()) {
    evidence.push({
      file: 'go.mod',
      line: 1,
      snippet: stdout.slice(0, 300),
    });
  }

  return buildVerdict({
    verified: false,
    type: 'known',
    confidence: 1.0,
    opinion: fromScalar(1.0, BASE_RATE),
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential' as const,
      halfLife: 300_000,
    },
    evidence,
    fileHashes: {},
    reason: 'go.mod is not tidy — run `go mod tidy`',
    errorCode: 'MODULE_UNTIDY',
    durationMs,
  });
}

/**
 * Cargo JSON diagnostic output → OracleVerdict mapper.
 *
 * Parses `cargo check --message-format=json` output.
 * Cargo emits one JSON object per line (NDJSON). Relevant messages have
 * `reason: "compiler-message"` with a `message` field containing the diagnostic.
 *
 * Diagnostic severity levels: "error", "warning", "note", "help", "failure-note"
 */

import { z } from 'zod/v4';
import { buildVerdict } from '../../core/index.ts';
import type { Evidence, OracleErrorCode, OracleVerdict } from '../../core/types.ts';

/** Cargo diagnostic span — where in source the issue occurs. */
const CargoSpanSchema = z.object({
  file_name: z.string(),
  line_start: z.number(),
  line_end: z.number(),
  column_start: z.number(),
  column_end: z.number(),
  is_primary: z.boolean(),
  text: z
    .array(
      z.object({
        text: z.string(),
      }),
    )
    .optional(),
});

/** Single Cargo compiler diagnostic. */
const CargoDiagnosticSchema = z.object({
  message: z.string(),
  code: z
    .object({
      code: z.string(),
      explanation: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
  level: z.enum(['error', 'warning', 'note', 'help', 'failure-note']),
  spans: z.array(CargoSpanSchema),
  children: z.array(z.any()).optional(),
});

/** Cargo JSON message envelope. */
const CargoMessageSchema = z.object({
  reason: z.string(),
  message: CargoDiagnosticSchema.optional(),
});

export type CargoDiagnostic = z.infer<typeof CargoDiagnosticSchema>;
export type CargoMessage = z.infer<typeof CargoMessageSchema>;
export type CargoSpan = z.infer<typeof CargoSpanSchema>;

/**
 * Classify a Rust error code into an OracleErrorCode.
 */
function classifyRustError(diagnostic: CargoDiagnostic): OracleErrorCode {
  const msg = diagnostic.message.toLowerCase();
  const code = diagnostic.code?.code ?? '';

  // Borrow checker errors: E0382, E0505, E0499, E0502, E0597
  if (code.match(/^E0(382|505|499|502|597|503|515|716)$/)) return 'BORROW_CHECK';

  // Lifetime errors: E0106, E0495, E0621, E0623, E0759
  if (code.match(/^E0(106|495|621|623|759|700)$/)) return 'LIFETIME_ERROR';

  // Trait not satisfied: E0277, E0599
  if (code.match(/^E0(277|599)$/)) return 'TRAIT_NOT_SATISFIED';

  // Unsafe violations: E0133
  if (code === 'E0133') return 'UNSAFE_VIOLATION';

  // Heuristic fallbacks based on message content (order matters: more specific first)
  if (msg.includes('lifetime') || msg.includes("doesn't live long enough") || msg.includes("does not live long enough"))
    return 'LIFETIME_ERROR';
  if (msg.includes('borrow') || msg.includes('move') || msg.includes('moved')) return 'BORROW_CHECK';
  if (msg.includes('trait') && (msg.includes('not satisfied') || msg.includes('not implemented')))
    return 'TRAIT_NOT_SATISFIED';
  if (msg.includes('unsafe')) return 'UNSAFE_VIOLATION';

  return 'TYPE_MISMATCH';
}

/**
 * Parse Cargo JSON output (NDJSON) → OracleVerdict.
 */
export function parseCargoOutput(stdout: string, exitCode: number, durationMs: number): OracleVerdict {
  const lines = stdout.split('\n').filter((l) => l.trim());

  const errors: Array<{ diagnostic: CargoDiagnostic; span?: CargoSpan }> = [];
  const warnings: Array<{ diagnostic: CargoDiagnostic; span?: CargoSpan }> = [];

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = CargoMessageSchema.safeParse(parsed);
    if (!msg.success || msg.data.reason !== 'compiler-message' || !msg.data.message) continue;

    const diagnostic = msg.data.message;
    const primarySpan = diagnostic.spans.find((s) => s.is_primary);

    if (diagnostic.level === 'error') {
      errors.push({ diagnostic, span: primarySpan });
    } else if (diagnostic.level === 'warning') {
      warnings.push({ diagnostic, span: primarySpan });
    }
  }

  if (errors.length === 0 && exitCode === 0) {
    return buildVerdict({
      verified: true,
      type: 'known',
      confidence: 1.0,
      evidence: [],
      fileHashes: {},
      durationMs,
    });
  }

  const evidence: Evidence[] = errors.map(({ diagnostic, span }) => ({
    file: span?.file_name ?? '<unknown>',
    line: span?.line_start ?? 0,
    snippet: diagnostic.code?.code
      ? `[${diagnostic.code.code}] ${diagnostic.message}`
      : diagnostic.message,
  }));

  // Use the most specific error code from the first error
  const primaryErrorCode = errors.length > 0 ? classifyRustError(errors[0]!.diagnostic) : 'BUILD_FAILED';

  return buildVerdict({
    verified: false,
    type: 'known',
    confidence: 1.0,
    evidence,
    fileHashes: {},
    reason: `${errors.length} error(s) found by cargo check`,
    errorCode: primaryErrorCode,
    durationMs,
  });
}

/**
 * Parse raw cargo output string. Handles both JSON and fallback plain-text output.
 */
export function parseCargoCheckOutput(stdout: string, stderr: string, exitCode: number, durationMs: number): OracleVerdict {
  // Try JSON parse first (from --message-format=json on stdout)
  if (stdout.trim() && stdout.includes('"reason"')) {
    return parseCargoOutput(stdout, exitCode, durationMs);
  }

  // Fallback: parse stderr for plain-text errors
  if (exitCode !== 0 && stderr.trim()) {
    const evidence: Evidence[] = [];
    const errorPattern = /^error(\[E\d+\])?: (.+)$/gm;
    let match;
    while ((match = errorPattern.exec(stderr)) !== null) {
      evidence.push({
        file: '<cargo>',
        line: 0,
        snippet: match[0]!,
      });
    }

    return buildVerdict({
      verified: false,
      type: evidence.length > 0 ? 'known' : 'uncertain',
      confidence: evidence.length > 0 ? 1.0 : 0.7,
      evidence,
      fileHashes: {},
      reason: stderr.slice(0, 500),
      errorCode: 'BUILD_FAILED',
      durationMs,
    });
  }

  // Clean exit with no JSON output
  return buildVerdict({
    verified: exitCode === 0,
    type: exitCode === 0 ? 'known' : 'unknown',
    confidence: exitCode === 0 ? 1.0 : 0.5,
    evidence: [],
    fileHashes: {},
    durationMs,
  });
}

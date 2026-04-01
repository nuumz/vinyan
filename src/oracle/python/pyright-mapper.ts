import { z } from 'zod/v4';
import { buildVerdict } from '../../core/index.ts';
import type { Evidence, OracleVerdict } from '../../core/types.ts';

/** Single Pyright diagnostic entry. */
const PyrightDiagnosticSchema = z.object({
  file: z.string(),
  severity: z.enum(['error', 'warning', 'information']),
  message: z.string(),
  range: z.object({
    start: z.object({ line: z.number(), character: z.number() }),
    end: z.object({ line: z.number(), character: z.number() }),
  }),
  rule: z.string().optional(),
});

/** Top-level Pyright JSON output. */
export const PyrightOutputSchema = z.object({
  version: z.string(),
  generalDiagnostics: z.array(PyrightDiagnosticSchema),
  summary: z.object({
    errorCount: z.number(),
    warningCount: z.number(),
    informationCount: z.number(),
    filesAnalyzed: z.number(),
  }),
});

export type PyrightDiagnostic = z.infer<typeof PyrightDiagnosticSchema>;
export type PyrightOutput = z.infer<typeof PyrightOutputSchema>;

/**
 * Map Pyright JSON output to an OracleVerdict.
 *
 * - errorCount === 0 -> verified=true, type="known", confidence=1.0
 * - errorCount > 0 -> verified=false, type="known", confidence=1.0
 * - Only errors cause verification failure; warnings/info do not.
 * - Each error becomes an Evidence entry.
 */
export function mapPyrightToVerdict(output: PyrightOutput, durationMs: number): OracleVerdict {
  const errors = output.generalDiagnostics.filter((d) => d.severity === 'error');

  const evidence: Evidence[] = errors.map((d) => ({
    file: d.file,
    line: d.range.start.line + 1, // Pyright uses 0-based lines
    snippet: d.rule ? `[${d.rule}] ${d.message}` : d.message,
  }));

  return buildVerdict({
    verified: errors.length === 0,
    type: 'known',
    confidence: 1.0,
    evidence,
    fileHashes: {},
    reason:
      errors.length > 0
        ? `${errors.length} type error(s) found (pyright ${output.version}, ${output.summary.filesAnalyzed} files analyzed)`
        : undefined,
    errorCode: errors.length > 0 ? 'TYPE_MISMATCH' : undefined,
    durationMs,
  });
}

/**
 * Parse raw Pyright JSON string and map to OracleVerdict.
 * Returns an error verdict on malformed input.
 */
export function parsePyrightOutput(raw: string, durationMs: number): OracleVerdict {
  const parsed = PyrightOutputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Failed to parse pyright output: ${parsed.error.message}`,
      errorCode: 'PARSE_ERROR',
      durationMs,
    });
  }
  return mapPyrightToVerdict(parsed.data, durationMs);
}

/**
 * Result-contract parser — extracts <CODING_CLI_RESULT>{...}</CODING_CLI_RESULT>
 * from arbitrary CLI output.
 *
 * Rules:
 *   - Markers are matched literally; everything outside is discarded.
 *   - Multiple result blocks → take the LAST valid one (a CLI may emit a
 *     draft block then revise).
 *   - JSON parse failures or schema-validation failures return null. The
 *     caller treats null as "result not yet emitted" and may keep waiting.
 *   - Provider id mismatch is rejected — the CLI must self-declare honestly.
 */
import {
  CodingCliResultSchema,
  type CodingCliProviderId,
  type CodingCliResult,
  RESULT_CLOSE_TAG,
  RESULT_OPEN_TAG,
} from './types.ts';

export interface ParseFinalResultOptions {
  expectedProviderId?: CodingCliProviderId;
  /** When true, parser logs a structured note for diagnostics. Default false. */
  diagnose?: boolean;
}

export interface ParseFinalResultDiagnosis {
  blocksFound: number;
  lastError?: string;
}

export function findResultBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(RESULT_OPEN_TAG, cursor);
    if (open === -1) break;
    const close = text.indexOf(RESULT_CLOSE_TAG, open + RESULT_OPEN_TAG.length);
    if (close === -1) break;
    blocks.push(text.slice(open + RESULT_OPEN_TAG.length, close).trim());
    cursor = close + RESULT_CLOSE_TAG.length;
  }
  return blocks;
}

export function parseFinalResult(
  text: string,
  options: ParseFinalResultOptions = {},
): CodingCliResult | null {
  const blocks = findResultBlocks(text);
  if (blocks.length === 0) return null;

  // Take blocks in reverse — last valid block wins.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const raw = blocks[i];
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const validation = CodingCliResultSchema.safeParse(parsed);
    if (!validation.success) continue;
    const result = validation.data;
    if (options.expectedProviderId && result.providerId !== options.expectedProviderId) {
      // Provider lying about its own id is an A6 violation — reject the
      // claim entirely so verification gets no chance to "trust" it.
      continue;
    }
    return result;
  }
  return null;
}

/** Diagnostic variant — always returns null when no valid block found. */
export function parseFinalResultWithDiagnosis(
  text: string,
  options: ParseFinalResultOptions = {},
): { result: CodingCliResult | null; diagnosis: ParseFinalResultDiagnosis } {
  const blocks = findResultBlocks(text);
  let lastError: string | undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const raw = blocks[i];
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw);
      const validation = CodingCliResultSchema.safeParse(parsed);
      if (validation.success) {
        const result = validation.data;
        if (options.expectedProviderId && result.providerId !== options.expectedProviderId) {
          lastError = `provider id mismatch: expected ${options.expectedProviderId}, got ${result.providerId}`;
          continue;
        }
        return { result, diagnosis: { blocksFound: blocks.length } };
      }
      lastError = `schema validation failed: ${validation.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`;
    } catch (err) {
      lastError = `JSON parse failed: ${(err as Error).message}`;
    }
  }
  return { result: null, diagnosis: { blocksFound: blocks.length, lastError } };
}

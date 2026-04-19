/**
 * Deterministic perception compressor.
 * Target: compressed result renders to ≤ contextWindow * 0.30 tokens.
 * Token estimate: chars / 3.5 (conservative — code is token-dense).
 *
 * Priority-based truncation (highest priority = last to discard):
 *  1. taskTarget + directImportees       — never truncated
 *  2. diagnostics.typeErrors (target)     — keep top 10 by target proximity
 *  3. dependencyCone.directImporters      — keep top 20
 *  4. verifiedFacts (target file)         — never truncated
 *  5. verifiedFacts (non-target)          — keep top 10 by verified_at desc
 *  6. transitiveImporters + affectedTests — replace with empty array
 *  7. diagnostics.lintWarnings            — replace with empty array
 */

import type { PerceptualHierarchy } from '../types.ts';

const BUDGET_RATIO = 0.3;
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / CHARS_PER_TOKEN);
}

function isTargetFile(file: string, target: string): boolean {
  return file === target || file.endsWith('/' + target);
}

export function compressPerception(perception: PerceptualHierarchy, contextWindow: number): PerceptualHierarchy {
  const budgetTokens = Math.floor(contextWindow * BUDGET_RATIO);

  // Under budget — return as-is (no copy needed)
  if (estimateTokens(perception) <= budgetTokens) {
    return perception;
  }

  // Deep clone to avoid mutating input
  const result: PerceptualHierarchy = JSON.parse(JSON.stringify(perception));
  const targetFile = result.taskTarget.file;
  const notes: string[] = [];
  const finalize = () => {
    if (notes.length) result.compressionNotes = notes;
    return result;
  };

  // Step A (priority 7): Drop lintWarnings
  const lintDropped = result.diagnostics.lintWarnings.length;
  if (lintDropped > 0) notes.push(`lintWarnings: dropped ${lintDropped} entries (budget)`);
  result.diagnostics.lintWarnings = [];
  if (estimateTokens(result) <= budgetTokens) return finalize();

  // Step B (priority 6): Drop transitiveImporters + affectedTestFiles
  const transitiveDropped = result.dependencyCone.transitiveImporters?.length ?? 0;
  const affectedDropped = result.dependencyCone.affectedTestFiles?.length ?? 0;
  if (transitiveDropped > 0)
    notes.push(`dependencyCone.transitiveImporters: dropped ${transitiveDropped} entries (budget)`);
  if (affectedDropped > 0) notes.push(`dependencyCone.affectedTestFiles: dropped ${affectedDropped} entries (budget)`);
  result.dependencyCone.transitiveImporters = [];
  result.dependencyCone.affectedTestFiles = [];
  if (estimateTokens(result) <= budgetTokens) return finalize();

  // Step C (priority 5): Truncate non-target verifiedFacts to top 10 by verified_at desc
  const originalFacts = result.verifiedFacts.length;
  const targetFacts = result.verifiedFacts.filter((f) => isTargetFile(f.target, targetFile));
  const nonTargetFacts = result.verifiedFacts
    .filter((f) => !isTargetFile(f.target, targetFile))
    .sort((a, b) => b.verified_at - a.verified_at)
    .slice(0, 10);
  result.verifiedFacts = [...targetFacts, ...nonTargetFacts];
  const factsDropped = originalFacts - result.verifiedFacts.length;
  if (factsDropped > 0) notes.push(`verifiedFacts: dropped ${factsDropped} non-target entries (kept 10 most recent)`);
  if (estimateTokens(result) <= budgetTokens) return finalize();

  // Step D (priority 3): Truncate directImporters to top 20
  const originalImporters = result.dependencyCone.directImporters.length;
  result.dependencyCone.directImporters = result.dependencyCone.directImporters.slice(0, 20);
  const importersDropped = originalImporters - result.dependencyCone.directImporters.length;
  if (importersDropped > 0)
    notes.push(`dependencyCone.directImporters: dropped ${importersDropped} entries (kept first 20)`);
  if (estimateTokens(result) <= budgetTokens) return finalize();

  // Step E (priority 2): Truncate typeErrors — keep target-file errors first, then top 10 total
  const originalErrors = result.diagnostics.typeErrors.length;
  const targetErrors = result.diagnostics.typeErrors.filter((e) => isTargetFile(e.file, targetFile));
  const otherErrors = result.diagnostics.typeErrors.filter((e) => !isTargetFile(e.file, targetFile));
  result.diagnostics.typeErrors = [...targetErrors, ...otherErrors].slice(0, 10);
  const errorsDropped = originalErrors - result.diagnostics.typeErrors.length;
  if (errorsDropped > 0)
    notes.push(`diagnostics.typeErrors: dropped ${errorsDropped} entries (kept 10 total, target-first)`);

  return finalize();
}

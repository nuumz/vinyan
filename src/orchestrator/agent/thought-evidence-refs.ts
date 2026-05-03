/**
 * Thought-emit evidenceRefs builder (A4 backfill).
 *
 * `kind:'thought'` audit entries previously shipped without
 * `evidenceRefs`, which forced the cot-injection freshness gate to
 * fall back to time-based A10 staleness alone. With this helper, every
 * thought at emit time carries the file hashes already known to the
 * task via `PerceptualHierarchy.verifiedFacts`, so a downstream
 * consumer (cot-injection, verifier, replay) can check
 * `currentHash(file) === thought.evidenceRef.sha256` to decide whether
 * the thought's reasoning is still grounded in the present file state.
 *
 * Axioms upheld:
 *   - A4 — Bind every thought to the file hashes that were verified at
 *     observation time. Thought-content references that cite "file F
 *     says X" gain a verifiable link to F's hash; if F changes, the
 *     thought becomes invalidatable.
 *   - A3 — Pure function over `verifiedFacts`. Same input → same
 *     output. No clock, no I/O, no LLM in the path.
 *   - A9 — Empty input yields an empty array (NOT undefined). The
 *     emit site MUST pass the array unconditionally so consumers can
 *     distinguish "no evidence captured for this thought" from
 *     "field absent for legacy / drifted shape".
 *
 * Caller contract: at the thought emit site in `agent-loop.ts`, always
 * pass `evidenceRefs: buildThoughtEvidenceRefs(perception)`. Do NOT
 * conditionalize on the array's length — the empty-array signal is
 * load-bearing for honest readers.
 */
import type { EvidenceRef } from '../../core/audit.ts';
import type { PerceptualHierarchy } from '../types.ts';

/**
 * Cap on file evidence refs per thought. Higher than this risks
 * bloating the audit row for tasks that observed many files;
 * verifiedFacts is typically O(handful) so this rarely engages but
 * keeps tail behavior bounded.
 */
export const MAX_THOUGHT_FILE_EVIDENCE = 10;

/**
 * Tools whose result is "I just read file at args.path". The
 * agent-loop hashes the file content after each successful call to
 * one of these and stores the (path, sha256) in `liveFileHashes`,
 * which `buildThoughtEvidenceRefs` merges with perception.
 *
 * Mirrors the read classification in `tool-authorization.ts` —
 * keep these in sync so a Read-classified tool's hash is captured.
 */
export const READ_FILE_TOOL_IDS: ReadonlySet<string> = new Set([
  'read_file',
  'search_file',
  'list_dir',
  'grep_search',
  // Common Claude-Code-style aliases that may appear in worker traces.
  'Read',
  'Grep',
  'Glob',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Build the evidenceRefs array for a thought emit. Merges TWO sources:
 *
 *   1. `perception.verifiedFacts` — files the perception phase saw
 *      BEFORE the agent loop started. Stable across the whole loop.
 *   2. `liveFileHashes` (optional) — files the worker has Read via
 *      tool calls during the loop. Captured after each successful
 *      Read-classified tool result with hash-of-file-on-disk-at-read-
 *      time. Live entries override perception on the same path
 *      (last-observation-wins) so a thought emitted AFTER the worker
 *      modified-and-reread a file references the new hash.
 *
 * Filtering invariants apply to both sources:
 *   - `target` / path must be a non-empty string.
 *   - `hash` / sha256 must match `^[0-9a-f]{64}$`.
 *   - First-occurrence-of-path wins after the live merge (live
 *     entries are inserted before perception so they shadow).
 *   - Cap at `MAX_THOUGHT_FILE_EVIDENCE` after dedup.
 */
export function buildThoughtEvidenceRefs(
  perception: PerceptualHierarchy | undefined,
  liveFileHashes?: ReadonlyMap<string, string>,
): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];

  // Live observations first — same-path entries from perception are
  // shadowed (the live read is the more recent observation).
  if (liveFileHashes) {
    for (const [path, sha256] of liveFileHashes) {
      if (out.length >= MAX_THOUGHT_FILE_EVIDENCE) break;
      if (typeof path !== 'string' || path.length === 0) continue;
      if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ type: 'file', path, sha256 });
    }
  }

  if (perception?.verifiedFacts) {
    for (const fact of perception.verifiedFacts) {
      if (out.length >= MAX_THOUGHT_FILE_EVIDENCE) break;
      if (typeof fact.target !== 'string' || fact.target.length === 0) continue;
      if (typeof fact.hash !== 'string' || !SHA256_RE.test(fact.hash)) continue;
      if (seen.has(fact.target)) continue;
      seen.add(fact.target);
      out.push({ type: 'file', path: fact.target, sha256: fact.hash });
    }
  }

  return out;
}

/**
 * External Coding CLI continuation pre-classifier.
 *
 * Failure mode this fixes: the user types a short routing directive
 * ("full-pipeline", "retry", "ลองใหม่", "อีกครั้ง", "do it again", "force",
 * "force agentic-workflow") right after a prior turn that was a CLI
 * delegation request (matched the {@link classifyExternalCodingCliIntent}
 * positive criteria). Because the bare directive contains neither a
 * provider mention nor a delegation verb, the deterministic classifier
 * misses it and the LLM workflow planner takes over — which then
 * generates a plan made of \`llm-reasoning\` steps that *describe*
 * "Generate and execute claude-code CLI commands to ..." but never
 * actually invoke the CLI. The plan times out or hallucinates.
 *
 * The fix mirrors {@link detectShortAffirmativeContinuation} /
 * {@link detectRetryContinuation}: when the bare directive matches AND
 * a recent USER turn (≤ 8 most recent) was structurally a CLI delegation,
 * re-issue that delegation through the {@link CodingCliIntent}
 * shape so the [A.0] dispatch in {@link resolveIntent} fires again.
 *
 * Pure: no I/O, no module state. Deterministic — A3 governance preserved.
 */
import type { Turn } from '../types.ts';
import {
  classifyExternalCodingCliIntent,
  type CodingCliIntentClassification,
} from './external-coding-cli-classifier.ts';

/**
 * Routing-directive sentinels: tight regex matching ONLY these literal forms.
 * Anything richer ("full-pipeline please add tests" / "retry but use copilot")
 * falls through so the LLM tier can interpret the new context.
 */
const ROUTING_DIRECTIVE_REGEX =
  /^\s*(?:full[\s-]*pipeline|agentic[\s-]*workflow|external[\s-]*coding[\s-]*cli|coding[\s-]*cli|claude[\s-]*code(?:[\s-]*cli)?|copilot[\s-]*cli|retry|try\s*again|do\s*it\s*again|once\s*more|run\s*again|รัน\s*อีก|ลอง\s*ใหม่(?:\s*อีก\s*ครั้ง)?|ลอง\s*อีก\s*(?:ที|ครั้ง)|อีก\s*ครั้ง|ทำ\s*ใหม่|รอบ\s*ใหม่|รัน\s*ใหม่|continue|ทำต่อ|ต่อเลย|do\s*it|go|force)\s*[.!?]?\s*$/i;

export interface CodingCliContinuationMatch {
  matched: boolean;
  /** Reconstructed CLI delegation when matched. */
  reconstructed?: CodingCliIntentClassification;
  /** seq of the user turn whose delegation we're re-issuing. */
  reconstructedFromTurnSeq?: number;
  /** Human-readable reason for trace + bus event. */
  reason?: string;
}

function turnText(turn: Turn): string {
  return turn.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Detect short routing-directive continuation that should re-issue a prior
 * CLI delegation. Conservative match: requires both a tight directive regex
 * AND a recent USER turn that was a structural CLI delegation. Returns
 * `matched: false` whenever either side is missing so the normal LLM flow
 * takes over.
 *
 * Walks newest-to-oldest within the last 8 turns. The first user turn whose
 * text matches {@link classifyExternalCodingCliIntent} (with the original
 * confidence threshold) wins.
 */
export function detectCodingCliContinuation(args: {
  goal: string;
  turns: Turn[] | undefined;
}): CodingCliContinuationMatch {
  const { goal, turns } = args;
  if (!ROUTING_DIRECTIVE_REGEX.test(goal)) return { matched: false };
  if (!turns || turns.length === 0) return { matched: false };

  const window = turns.slice(-8);
  for (let i = window.length - 1; i >= 0; i--) {
    const turn = window[i];
    if (!turn || turn.role !== 'user') continue;
    const text = turnText(turn);
    if (!text) continue;
    // Skip user turns that are themselves bare routing directives — we want
    // the original delegation, not a chain of retries.
    if (ROUTING_DIRECTIVE_REGEX.test(text)) continue;
    const cliIntent = classifyExternalCodingCliIntent(text);
    if (!cliIntent.matched || cliIntent.confidence < 0.85) continue;
    return {
      matched: true,
      reconstructed: cliIntent,
      reconstructedFromTurnSeq: turn.seq,
      reason: `bare routing directive "${goal.trim()}" re-issues prior CLI delegation at turn seq=${turn.seq}`,
    };
  }
  return { matched: false };
}

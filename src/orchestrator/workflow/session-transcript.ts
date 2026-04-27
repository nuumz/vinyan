/**
 * Session transcript formatter — compact prior-turn context for the workflow
 * planner and synthesizer.
 *
 * Why this exists: the workflow path bypasses the agent loop, so when a
 * conversation spans multiple turns ("เขียนต่อบทที่ 2" after a prior bedtime
 * story), the planner and synthesizer have no idea what was already
 * produced. They re-plan from scratch and the second-turn output drifts
 * from the first. Plumbing the recent turns into both stages closes that
 * loop without a full agent-loop integration.
 *
 * Design constraints:
 *   - Token budget — recent turns can be many KB each; cap aggressively.
 *   - Determinism — pure string formatting, no LLM, no side effects.
 *   - Anonymity of internals — strip role-internal markers (e.g. JSON
 *     escape sentinel payloads) so the LLM doesn't echo orchestrator wire
 *     format back at the user.
 */
import type { Turn } from '../types.ts';

interface FormatOptions {
  /** Max number of turns from the tail to include. Default 6 (last ~3 round trips). */
  maxTurns?: number;
  /** Per-turn character cap. Default 800. */
  maxCharsPerTurn?: number;
  /** Total transcript character cap (hard ceiling regardless of per-turn). Default 4000. */
  maxTotalChars?: number;
}

const DEFAULTS: Required<FormatOptions> = {
  maxTurns: 6,
  maxCharsPerTurn: 800,
  maxTotalChars: 4000,
};

function plainText(turn: Turn): string {
  return turn.blocks
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Render the tail of a turn list as a labelled transcript, capped to fit the
 * planner / synthesizer's context budget. Returns an empty string when the
 * turn list is empty or no turn carries inspectable text — callers should
 * test the return value before appending to a prompt so a no-history case
 * doesn't leave a dangling header.
 */
export function formatSessionTranscript(
  turns: Turn[] | undefined,
  options: FormatOptions = {},
): string {
  if (!turns || turns.length === 0) return '';
  const opts = { ...DEFAULTS, ...options };
  const tail = turns.slice(-opts.maxTurns);

  const sections: string[] = [];
  let totalChars = 0;
  for (const turn of tail) {
    const text = plainText(turn);
    if (!text) continue;
    const truncated =
      text.length > opts.maxCharsPerTurn
        ? `${text.slice(0, opts.maxCharsPerTurn)}\n…[truncated]`
        : text;
    const role = turn.role === 'user' ? 'User' : 'Assistant';
    const section = `[${role} · turn ${turn.seq}]\n${truncated}`;
    if (totalChars + section.length > opts.maxTotalChars) {
      // Once we'd blow the total cap, drop earlier sections from the head
      // so the most recent turns survive — they carry the most relevant
      // continuation context.
      while (sections.length > 0 && totalChars + section.length > opts.maxTotalChars) {
        const dropped = sections.shift();
        if (dropped) totalChars -= dropped.length;
      }
    }
    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) return '';
  return sections.join('\n\n');
}

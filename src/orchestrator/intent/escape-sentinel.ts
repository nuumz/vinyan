/**
 * Persona escape sentinel — protocol for the conversational shortcircuit to
 * abort and re-enter the agentic-workflow path.
 *
 * Failure mode this fixes: the secretary persona, told via prompt that other
 * specialist agents exist, generates text saying "I'll forward this to
 * novelist" — but the conversational path has no dispatch mechanism, so the
 * user receives a fake acknowledgment and no work happens.
 *
 * Solution: the persona prompt teaches an explicit sentinel token. When the
 * persona realizes mid-generation that the request needs proper workflow
 * dispatch, it emits the sentinel as its entire response. The orchestrator
 * detects the sentinel, discards the conversational result, and re-routes the
 * task into the agentic-workflow branch (bounded at one re-route per task —
 * see `TaskInput.intentEscapeAttempts`).
 *
 * Axiom alignment: A1 (separation — persona generates, deterministic regex
 * verifies), A2 (sentinel IS the persona's first-class "I cannot answer here"
 * state), A3 (re-routing decision is a regex match + counter check, no LLM),
 * A6 (persona proposes via the sentinel; orchestrator disposes via re-route).
 *
 * Pure: no I/O, no module state.
 */

export const ESCAPE_SENTINEL_OPEN = '<<NEEDS_AGENTIC_WORKFLOW:';
export const ESCAPE_SENTINEL_CLOSE = '>>';

/**
 * Match the sentinel anywhere in the answer. Capture group 1 = reason text,
 * up to 500 chars, no `>` chars (so the close marker is unambiguous).
 *
 * Non-greedy + char-class exclusion of `>` means a payload containing a `>`
 * does NOT match — protects against the LLM accidentally emitting something
 * sentinel-shaped inside an HTML/markdown answer.
 */
export const ESCAPE_SENTINEL_REGEX = /<<NEEDS_AGENTIC_WORKFLOW:\s*([^>]{1,500})>>/;

export interface EscapeSignal {
  matched: boolean;
  /** Trimmed reason text from the sentinel payload, when matched. */
  reason?: string;
  /** Original answer with the sentinel removed (for logging / fallback rendering). */
  strippedAnswer?: string;
}

/**
 * Detect the escape sentinel in a persona response. First match wins
 * (deterministic when a malformed response contains the sentinel twice).
 *
 * Returns `{ matched: false }` when the sentinel is absent — callers should
 * proceed with the conversational answer as the final result.
 */
export function parseEscapeSentinel(answer: string): EscapeSignal {
  const match = ESCAPE_SENTINEL_REGEX.exec(answer);
  if (!match) return { matched: false };
  const reason = match[1]?.trim();
  if (!reason) return { matched: false };
  const strippedAnswer = answer.replace(match[0], '').trim();
  return { matched: true, reason, strippedAnswer };
}

/**
 * The protocol stanza injected into a persona system prompt so the persona
 * knows when and how to emit the sentinel. Centralized so changes to the
 * sentinel format propagate without grep'ing string literals across personas.
 */
export function formatEscapeProtocolBlock(): string {
  return [
    '[ESCAPE PROTOCOL]',
    'You are answering INSIDE a conversational shortcircuit and have NO tools and NO ability to dispatch work to other agents from this turn.',
    '',
    'Two cases require you to ESCAPE rather than answer inline:',
    '',
    '1) DELIVERABLE TOO BIG — the user wants a multi-paragraph artifact (story chapter, full article, report, code module, slide deck) that is outside your role or larger than a short reply. Do NOT promise to "forward" or "delegate" — the system cannot fulfill that promise from here.',
    '',
    '2) NEEDS TOOLS — the user is asking you to inspect, list, read, modify, run, or otherwise interact with their machine, filesystem, repo, network, or any external system. Examples: "list files in ~/Desktop", "read package.json", "run `npm test`", "check what processes are running", "look at the bug in src/foo.ts". You have NO file read, shell, network, or filesystem tools in THIS conversational turn. Do NOT apologize that you "cannot access local files" — Vinyan as a system CAN; only THIS turn lacks tools. Your job is to escape so the orchestrator routes the task to the workflow path that has the tools.',
    '',
    'In BOTH cases, emit EXACTLY this token (no apology, no preamble, no inline answer) as your entire response and stop:',
    '',
    `  ${ESCAPE_SENTINEL_OPEN} <one-sentence reason naming the deliverable or the required tools> ${ESCAPE_SENTINEL_CLOSE}`,
    '',
    'Examples:',
    `  ${ESCAPE_SENTINEL_OPEN} user requested a 2-chapter bedtime story ${ESCAPE_SENTINEL_CLOSE}`,
    `  ${ESCAPE_SENTINEL_OPEN} user wants a full feature spec for the auth flow ${ESCAPE_SENTINEL_CLOSE}`,
    `  ${ESCAPE_SENTINEL_OPEN} user asked to list files in ~/Desktop — needs filesystem tools ${ESCAPE_SENTINEL_CLOSE}`,
    `  ${ESCAPE_SENTINEL_OPEN} user asked to run npm test — needs shell tools ${ESCAPE_SENTINEL_CLOSE}`,
    '',
    'Reason payload must be ≤500 chars and must NOT contain `>` characters.',
    'The system will catch the token and re-route the task into the proper agentic-workflow path with tools. Do not include the sentinel in addition to a normal answer — it is mutually exclusive with answering inline.',
    'NEVER tell the user you cannot access their files, run commands, or reach external systems — that misrepresents Vinyan as a whole. Only THIS turn lacks tools; escape and the next turn will have them.',
  ].join('\n');
}

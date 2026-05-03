/**
 * CoT continuity injection (L1 — debate within-agent thought reuse).
 *
 * Pure rule-based module that decides whether and how to inject a
 * collaboration-block primary's prior-round thoughts into its next-round
 * prompt. The full design rationale, axiom audit, and per-gate proof
 * lives in `docs/foundation/concept.md` §CoT-continuity (TBD); this
 * module is the deterministic implementation of those rules.
 *
 * Axiom alignment (per audit before implementation):
 *   A1 — Pure read of generation-side state; verifiers never receive it.
 *        Caller (`collaboration-block`) MUST keep the injected prompt
 *        out of any `HypothesisTuple`/oracle stdin path. Asserted by
 *        `cot-injection-verifier-isolation.test.ts`.
 *   A2 — `trigger:'reflect'` thoughts are surfaced as a separate
 *        "must address" section so honest uncertainty cannot be papered
 *        over by subsequent rounds.
 *   A3 — Every gate is rule-based: tool-mutation flag, ts staleness,
 *        jailbreak-pattern regex, length cap, count cap, deterministic
 *        chronological sort. No LLM in the gate path.
 *   A4 — `evaluateInjection` drops the entire batch when the prior-round
 *        sub-task emitted a mutation tool call. Today's thought schema
 *        does not carry per-thought `evidenceRefs`; until that backfill
 *        lands, this gate is the only honest answer to "have files
 *        changed since the thought was written?".
 *   A5 — Output prompt block labels itself "heuristic — refine, don't
 *        repeat". Confidence-dependency tracking on the consuming round
 *        is a known soft violation (deferred follow-up — see comment in
 *        `evaluateInjection`).
 *   A6 — Re-applies `redactAuditPayload` defense-in-depth to every
 *        thought string before it crosses back into a worker prompt.
 *        Jailbreak-pattern filter drops thoughts whose content carries
 *        prompt-injection signatures so a malicious round-N worker
 *        cannot attack round-(N+1) via the orchestrator-mediated channel.
 *   A8 — `evaluateInjection` returns a `decision` record the caller
 *        emits as a `kind:'decision'` audit entry per (step, round)
 *        decision (inject or skip) so the trail is replayable.
 *   A9 — Returns a structured decision instead of throwing; empty input
 *        yields an `'empty'` decision; load failures upstream surface
 *        as the same `'empty'` shape so the caller's prompt build still
 *        succeeds.
 *  A10 — Drops thoughts older than `maxStalenessMs` so a long sub-task
 *        pause (approval / human-input / coding-cli gate between
 *        rounds) cannot silently re-inject stale reasoning.
 */

import { redactAuditPayload } from '../../core/audit-redact.ts';
import { BUILT_IN_POLICY, type RedactionPolicy } from '../../trajectory/redaction.ts';

/**
 * Minimal projection of a `kind:'thought'` audit entry that the
 * injection module needs. Captured by the caller from the bus during
 * the prior round's execution.
 *
 * `id` is the original audit entry's wrapper.id — preserved through
 * the gate pipeline so the caller's decision audit row can reference
 * each surviving thought via `evidenceRefs:[{type:'event', eventId}]`.
 * That structural link is what operationalizes A5 ("memory-as-evidence")
 * — a downstream verifier reading the inject decision can walk back to
 * the exact thought entries that informed round N+1's generation.
 */
export interface ThoughtView {
  /** Wrapper id of the source `audit:entry` event — for evidenceRefs. */
  id: string;
  /** Already source-side redacted; we re-redact below. */
  content: string;
  trigger?: 'pre-tool' | 'post-tool' | 'plan' | 'reflect' | 'compaction';
  ts: number;
}

/**
 * Captured tool-call signal needed for the A4 mutation gate. Caller
 * records `lifecycle === 'executed'` tool calls keyed by sub-task id;
 * this module checks the toolId against the mutation set.
 */
export interface CapturedToolCall {
  toolId: string;
  lifecycle: 'executed' | 'failed' | string;
}

/** Hard caps — chosen to bound prompt growth per (step, round). */
export const MAX_INJECTED_THOUGHTS = 10;
export const MAX_THOUGHT_CHARS = 1000;
export const DEFAULT_COT_REUSE_MAX_STALENESS_MS = 300_000;

/**
 * Tool ids that mutate file or system state. Conservative — over-flags
 * rather than risks A4 violation. Sourced from `tool-authorization.ts`
 * canonical names.
 */
const FILE_WRITE_TOOL_IDS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'replace_string_in_file',
  // Allow common Claude-Code-style aliases that may appear in worker traces.
  'Edit',
  'Write',
  'MultiEdit',
]);
const SHELL_TOOL_IDS: ReadonlySet<string> = new Set(['run_command', 'shell', 'run_in_terminal', 'shell_exec', 'Bash']);

export function isFileOrSystemMutating(toolId: string): boolean {
  if (FILE_WRITE_TOOL_IDS.has(toolId)) return true;
  // Treat any shell call as mutating — `isReadOnlyCommand` exists but
  // requires args inspection; conservative default is safer for A4.
  if (SHELL_TOOL_IDS.has(toolId)) return true;
  return false;
}

/**
 * Prompt-injection signatures. Conservative: a single match drops the
 * thought (not the whole batch). Patterns kept short and explicit so
 * the false-positive rate stays bounded — domain text rarely contains
 * `ignore prior instructions` verbatim.
 */
const JAILBREAK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bignore\s+(prior|previous|above|preceding|all)\s+(instructions?|prompts?|rules?|directives?)/i,
  /\bdisregard\s+(the\s+)?(previous|prior|above|preceding)\s+(instructions?|prompts?|context)/i,
  /\byou\s+are\s+now\s+(a|an)\b/i,
  /\bact\s+as\s+(a|an)\s+\w+\s+(without|with\s+no|free\s+from)\b/i,
  /\bsystem\s*:\s*(forget|ignore|reset)\b/i,
  /<\s*\/?(system|user|assistant)\s*>/i,
  /<\|im_(start|end)\|>/i,
];

export function looksLikeJailbreak(content: string): boolean {
  return JAILBREAK_PATTERNS.some((re) => re.test(content));
}

export type InjectionDecision =
  | {
      kind: 'inject';
      thoughts: ThoughtView[];
      reasoning: ThoughtView[];
      reflective: ThoughtView[];
      drops: { stale: number; jailbreak: number; truncated: number };
    }
  | {
      kind: 'skip';
      reason: 'no-thoughts' | 'mutation-detected' | 'all-stale' | 'all-filtered' | 'prior-round-failed';
      drops: { stale: number; jailbreak: number; truncated: number };
    };

export interface EvaluateInjectionOpts {
  thoughts: readonly ThoughtView[];
  toolCalls: readonly CapturedToolCall[];
  /** Was the prior round's sub-task itself completed successfully?
   *  Failed/cancelled rounds carry corrupt or partial reasoning — drop
   *  the whole batch (caller's peer-transcript path remains as before). */
  priorRoundCompleted: boolean;
  /** Wall-clock now (ms) for the staleness gate. */
  now: number;
  /** Adaptive — see `cot.reuse_max_staleness_ms` in parameter-registry. */
  maxStalenessMs?: number;
  /** Defense-in-depth redactor. Defaults to BUILT_IN_POLICY. */
  redactionPolicy?: RedactionPolicy;
}

/**
 * Decide what to inject. Pure function — same inputs → same output.
 *
 * The caller is responsible for emitting the `kind:'decision'` audit
 * row carrying this verdict for A8 replay AND for populating
 * `evidenceRefs:[{type:'event', eventId: t.id}]` from the returned
 * `decision.thoughts[].id` so the inject decision is replayable AND
 * has structured back-links to the exact source thoughts (A5
 * memory-as-evidence operationalization).
 *
 * Verifier-side confidence discount (round N's `kind:'verdict'` row
 * downgrading because of a prior-round dependency) remains a separate
 * follow-up — that's a verifier change, not an inject-site change.
 */
export function evaluateInjection(opts: EvaluateInjectionOpts): InjectionDecision {
  const drops = { stale: 0, jailbreak: 0, truncated: 0 };

  if (!opts.priorRoundCompleted) {
    return { kind: 'skip', reason: 'prior-round-failed', drops };
  }
  if (opts.thoughts.length === 0) {
    return { kind: 'skip', reason: 'no-thoughts', drops };
  }
  // A4 mutation gate — file/system mutation in the prior round means
  // any thought from that round may reference now-stale state.
  for (const tc of opts.toolCalls) {
    if (tc.lifecycle === 'executed' && isFileOrSystemMutating(tc.toolId)) {
      return { kind: 'skip', reason: 'mutation-detected', drops };
    }
  }

  const policy = opts.redactionPolicy ?? BUILT_IN_POLICY;
  const maxStalenessMs = opts.maxStalenessMs ?? DEFAULT_COT_REUSE_MAX_STALENESS_MS;

  // Filter pass — staleness, jailbreak, length cap, redact.
  const cleaned: ThoughtView[] = [];
  for (const t of opts.thoughts) {
    if (opts.now - t.ts > maxStalenessMs) {
      drops.stale++;
      continue;
    }
    if (looksLikeJailbreak(t.content)) {
      drops.jailbreak++;
      continue;
    }
    let content = t.content;
    if (content.length > MAX_THOUGHT_CHARS) {
      content = `${content.slice(0, MAX_THOUGHT_CHARS - 1)}…`;
      drops.truncated++;
    }
    // Defense-in-depth re-redaction.
    content = redactAuditPayload(content, policy);
    cleaned.push({
      id: t.id,
      content,
      ...(t.trigger ? { trigger: t.trigger } : {}),
      ts: t.ts,
    });
  }

  if (cleaned.length === 0) {
    // Distinguish "all stale" from "all filtered" so the audit row
    // lets operators tell A10 freshness vs A6 hostile content apart.
    if (drops.stale > 0 && drops.jailbreak === 0) {
      return { kind: 'skip', reason: 'all-stale', drops };
    }
    return { kind: 'skip', reason: 'all-filtered', drops };
  }

  // Deterministic order: by ts ascending, take last MAX_INJECTED_THOUGHTS.
  cleaned.sort((a, b) => a.ts - b.ts);
  const sliced = cleaned.slice(-MAX_INJECTED_THOUGHTS);

  // Group by trigger — `reflect` becomes a "must address" section per A2.
  const reflective: ThoughtView[] = [];
  const reasoning: ThoughtView[] = [];
  for (const t of sliced) {
    if (t.trigger === 'reflect') reflective.push(t);
    else reasoning.push(t);
  }
  return { kind: 'inject', thoughts: sliced, reasoning, reflective, drops };
}

/**
 * Format an inject decision into a prompt section. Empty input → empty
 * string (caller appends conditionally). Does NOT emit the trailing
 * newline — caller controls separator.
 */
export function formatInjectionForPrompt(decision: InjectionDecision, priorRound: number): string {
  if (decision.kind !== 'inject') return '';
  const lines: string[] = [];
  lines.push(
    `## Your reasoning trail from round ${priorRound + 1} (heuristic — refine or correct, do NOT simply repeat)`,
  );
  if (decision.reasoning.length > 0) {
    lines.push('Pre/post-tool reasoning:');
    decision.reasoning.forEach((t, i) => {
      const trig = t.trigger ?? 'thought';
      lines.push(`${i + 1}. [${trig}] ${t.content}`);
    });
  }
  if (decision.reflective.length > 0) {
    if (decision.reasoning.length > 0) lines.push('');
    lines.push('Reflective uncertainty (must address explicitly — do NOT bypass):');
    decision.reflective.forEach((t, i) => {
      lines.push(`${i + 1}. [reflect] ${t.content}`);
    });
  }
  return lines.join('\n');
}

/**
 * ECP-enriched trajectory projector (Decision 23).
 *
 * Takes the `JoinedTraceRow` already produced by the ShareGPT exporter and
 * projects it into the `EcpEnrichedRow` shape — preserving the chat
 * structure but adding the epistemic metadata that makes this Vinyan's data
 * moat:
 *
 *   - per-turn OracleVerdict + evidence_chain
 *   - per-turn Brier / CRPS prediction error
 *   - routing explanation payload (from `explainRouting`)
 *   - confidence_source (A2: surface 'unknown' explicitly)
 *
 * Redaction is expected to run AROUND this projector — the enriched row is
 * serialized via `JSON.stringify`, then (if you pipe through the exporter)
 * the JSONL body is hashed. The projector itself does not mutate content.
 *
 * The projector is pure: same inputs → identical output. The exporter side
 * handles redaction + gzip + hash, so the invariant "redaction BEFORE hash"
 * is preserved at the exporter, not the projector layer.
 */

import type { z } from 'zod';
import type { OracleVerdict } from '../core/types.ts';
import type { RoutingExplanation } from '../gate/routing-explainer.ts';
import { mapVerdictStatus } from '../gate/routing-explainer.ts';
import type { EcpEnrichedRow, EcpEnrichedTurn, EcpPredictionErrorSchema } from './ecp-schemas.ts';
import type { JoinedTraceRow } from './exporter.ts';

type EcpPredictionError = z.infer<typeof EcpPredictionErrorSchema>;

/**
 * Prediction signal for a trace — brought in from `prediction_ledger` +
 * `prediction_outcomes` by the exporter caller. The projector doesn't open
 * a DB itself so it stays trivially testable with fake fixtures.
 */
export interface TracePredictionSignal {
  readonly brier?: number;
  readonly crps_blast?: number;
  readonly crps_quality?: number;
  readonly surprise_bits?: number;
  readonly basis: 'calibrated' | 'uncalibrated';
}

/**
 * Per-turn verdict bag — keyed by turn id if the caller can attribute a
 * verdict to a specific turn, otherwise attached to the final assistant
 * turn. We leave the attribution choice to the caller.
 */
export interface EcpEnrichmentContext {
  /** Verdicts to attach to individual turns, keyed by turn id. */
  readonly verdictsByTurnId?: ReadonlyMap<string, OracleVerdict>;
  /** Fallback verdicts (attached to the last assistant turn if present). */
  readonly tailVerdicts?: readonly OracleVerdict[];
  /** Trace-level prediction error (attached to the last assistant turn). */
  readonly tracePrediction?: TracePredictionSignal;
  /** Which redaction rules were applied, for the privacy block. */
  readonly redactionApplied: readonly string[];
  /** Effective redaction policy version. */
  readonly redactionPolicyVersion: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function parseBlocks(json: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ContentBlock[]) : [];
  } catch {
    return [];
  }
}

/**
 * Flatten content blocks into a single string. Matches the ShareGPT
 * exporter's behavior so consumers comparing the two formats see the
 * same text content.
 */
function flattenBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'thinking') {
      parts.push(`<thinking>${block.thinking}</thinking>`);
    } else if (block.type === 'tool_result') {
      const errTag = block.is_error ? ' is_error="true"' : '';
      parts.push(`<tool_result id="${block.tool_use_id}"${errTag}>${block.content}</tool_result>`);
    }
    // tool_use surfaced in tool_calls array, not in content.
  }
  return parts.join('\n\n');
}

function extractToolCalls(
  blocks: ContentBlock[],
  allToolCalls: JoinedTraceRow['toolCalls'],
  turnId: string,
): { name: string; args_hash: string }[] {
  const outputs: { name: string; args_hash: string }[] = [];
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue;
    // Look up the canonicalized hash from the JoinedTraceRow's tool call
    // list rather than re-hashing, to stay consistent with ShareGPT's
    // args_hash output on the same row.
    const matched = allToolCalls.find((tc) => tc.turnId === turnId && tc.toolUseId === block.id);
    outputs.push({
      name: block.name,
      args_hash: matched?.argsHash ?? '',
    });
  }
  return outputs;
}

function verdictToSummary(v: OracleVerdict): EcpEnrichedTurn['oracle_verdict'] {
  return {
    oracle: v.oracleName ?? 'anonymous',
    status: mapVerdictStatus(v),
    confidence: v.confidence,
    evidence_chain: v.evidence.map((e) => ({
      kind: 'source-evidence',
      hash: e.contentHash ?? '',
    })),
  };
}

function tierFromConfidence(c: number): 'deterministic' | 'heuristic' | 'probabilistic' | 'speculative' {
  if (c >= 0.95) return 'deterministic';
  if (c >= 0.8) return 'heuristic';
  if (c >= 0.5) return 'probabilistic';
  return 'speculative';
}

function confidenceSourceForVerdict(v: OracleVerdict): EcpEnrichedTurn['confidence_source'] {
  if (v.type === 'unknown') return 'unknown';
  return tierFromConfidence(v.confidence);
}

// ── Public projector ─────────────────────────────────────────────────

export function toECPEnriched(
  joined: JoinedTraceRow,
  routing: RoutingExplanation,
  ctx: EcpEnrichmentContext = {
    redactionApplied: [],
    redactionPolicyVersion: 'built-in-v1',
  },
): EcpEnrichedRow {
  const { trace, turns, toolCalls } = joined;

  // System turn from trace framing — mirrors the ShareGPT exporter so
  // downstream learners see the same goal framing.
  const systemValue = buildSystemValue(joined);
  const systemTurn: EcpEnrichedTurn = {
    turn_idx: 0,
    role: 'system',
    content: systemValue,
  };

  const builtTurns: EcpEnrichedTurn[] = [systemTurn];
  let idx = 1;

  if (turns.length === 0) {
    builtTurns.push({
      turn_idx: idx++,
      role: 'human',
      content: trace.approach_description ?? trace.approach,
    });
  } else {
    for (const turn of turns) {
      const blocks = parseBlocks(turn.blocks_json);
      const content = flattenBlocks(blocks);

      // Every turn with tool_use blocks should carry tool_calls; if there
      // is no text/thinking/tool_result payload AND no tool_use, skip the
      // turn entirely to stay compact.
      const toolCallsForTurn = extractToolCalls(blocks, toolCalls, turn.id);
      if (content.length === 0 && toolCallsForTurn.length === 0) {
        continue;
      }

      const turnVerdict = ctx.verdictsByTurnId?.get(turn.id);

      const enrichedTurn: EcpEnrichedTurn = {
        turn_idx: idx++,
        role: turn.role === 'user' ? 'human' : 'gpt',
        content,
        ...(toolCallsForTurn.length > 0 ? { tool_calls: toolCallsForTurn } : {}),
        ...(turnVerdict
          ? {
              oracle_verdict: verdictToSummary(turnVerdict),
              confidence_source: confidenceSourceForVerdict(turnVerdict),
              ...(turnVerdict.tierReliability != null ? { tier_reliability: turnVerdict.tierReliability } : {}),
            }
          : {}),
      };
      builtTurns.push(enrichedTurn);
    }
  }

  // Attach tail verdicts + prediction signal to the final assistant turn
  // (or the last turn produced) if not already attached turn-wise.
  const lastAssistantIdx = findLastAssistantIdx(builtTurns);
  if (lastAssistantIdx >= 0) {
    const tail = builtTurns[lastAssistantIdx];
    if (!tail) {
      // Unreachable given findLastAssistantIdx contract, but keep the
      // guard so the compiler narrows properly.
    } else {
      const patched: EcpEnrichedTurn = { ...tail };

      if (!patched.oracle_verdict && ctx.tailVerdicts && ctx.tailVerdicts.length > 0) {
        const first = ctx.tailVerdicts[0];
        if (first) {
          patched.oracle_verdict = verdictToSummary(first);
          patched.confidence_source = confidenceSourceForVerdict(first);
          if (first.tierReliability != null) {
            patched.tier_reliability = first.tierReliability;
          }
        }
      }

      if (ctx.tracePrediction) {
        const pe: EcpPredictionError = {
          basis: ctx.tracePrediction.basis,
          ...(ctx.tracePrediction.brier !== undefined ? { brier: ctx.tracePrediction.brier } : {}),
          ...(ctx.tracePrediction.crps_blast !== undefined ? { crps_blast: ctx.tracePrediction.crps_blast } : {}),
          ...(ctx.tracePrediction.crps_quality !== undefined ? { crps_quality: ctx.tracePrediction.crps_quality } : {}),
          ...(ctx.tracePrediction.surprise_bits !== undefined
            ? { surprise_bits: ctx.tracePrediction.surprise_bits }
            : {}),
        };
        patched.prediction_error = pe;
      }

      builtTurns[lastAssistantIdx] = patched;
    }
  }

  // Deep-copy routing into a mutable shape so the Zod-inferred
  // EcpEnrichedRow type accepts it (the RoutingExplanation interface uses
  // `readonly` for consumer immutability; Zod arrays are mutable).
  const routingCopy = {
    taskId: routing.taskId,
    level: routing.level,
    summary: routing.summary,
    factors: routing.factors.map((f) => ({
      label: f.label,
      rawValue: f.rawValue,
      weightedContribution: f.weightedContribution,
    })),
    oraclesPlanned: [...routing.oraclesPlanned],
    ...(routing.oraclesActual
      ? {
          oraclesActual: routing.oraclesActual.map((o) => ({
            name: o.name,
            verdict: o.verdict,
            confidence: o.confidence,
          })),
        }
      : {}),
    confidenceSource: routing.confidenceSource,
    ...(routing.escalationReason ? { escalationReason: routing.escalationReason } : {}),
    ...(routing.deescalationReason ? { deescalationReason: routing.deescalationReason } : {}),
    ...(routing.mappingLossWarnings ? { mappingLossWarnings: [...routing.mappingLossWarnings] } : {}),
  };

  return {
    schema: 'vinyan.ecp.trajectory/v1',
    trace_id: trace.id,
    task_type_signature: trace.task_type_signature,
    routing: routingCopy,
    turns: builtTurns,
    terminal: {
      outcome: trace.outcome,
      quality_composite: trace.quality_composite,
    },
    privacy: {
      redaction_applied: [...ctx.redactionApplied],
      policy_version: ctx.redactionPolicyVersion,
    },
  };
}

function buildSystemValue(joined: JoinedTraceRow): string {
  const { trace } = joined;
  const parts = [
    `trace=${trace.id}`,
    `task=${trace.task_id}`,
    `approach=${trace.approach}`,
    `model=${trace.model_used}`,
    `routing_level=${trace.routing_level}`,
    `outcome=${trace.outcome}`,
  ];
  if (trace.task_type_signature) parts.push(`task_type=${trace.task_type_signature}`);
  return parts.join(' ');
}

function findLastAssistantIdx(turns: EcpEnrichedTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.role === 'gpt') return i;
  }
  // Fall back to last non-system turn.
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.role !== 'system') return i;
  }
  return -1;
}

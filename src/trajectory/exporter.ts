/**
 * Trajectory Exporter — ShareGPT baseline (MVP).
 *
 * One-shot export of `execution_traces` + `session_turns` to gzipped JSONL
 * in ShareGPT format. Each trace becomes one row.
 *
 * Flow:
 *   1. Resolve filter → query `execution_traces`.
 *   2. For each trace, pull `session_turns` by `session_id` ordered by `seq`.
 *   3. Build the intermediate `JoinedTraceRow` (rich; retains all fields).
 *   4. Project to ShareGPT via `toShareGPT(joined)`.
 *   5. Apply redaction to every `value` string.
 *   6. Gzip-serialize, SHA-256 the bytes, write artifact + manifest.
 *   7. Insert a row into `trajectory_exports` (manifest pointer).
 *
 * The `buildJoinedRow` / `toShareGPT` split is the A7 flagship path
 * foundation: W4 will add `toECPEnriched(joined)` with the same input and
 * additional joins (`prediction_ledger`, `prediction_outcomes`,
 * `oracle_accuracy_store`) — the exporter shape does not change.
 */

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { explainRouting, type RoutingExplanation } from '../gate/routing-explainer.ts';
import type { RiskFactors, RoutingDecision } from '../orchestrator/types.ts';
import { toECPEnriched } from './ecp-enriched.ts';
import {
  type EcpEnrichedRow,
  EcpEnrichedRowSchema,
  type EcpExportManifest,
  EcpExportManifestSchema,
} from './ecp-schemas.ts';
import { applyPolicy, BUILT_IN_POLICY, hashPolicy, loadPolicy, type RedactionPolicy } from './redaction.ts';
import {
  DATASET_VERSION,
  type ExportManifest,
  ExportManifestSchema,
  type ShareGPTMessage,
  type ShareGPTRow,
  ShareGPTRowSchema,
} from './schemas.ts';

// ─────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────

export type Outcome = 'success' | 'failure' | 'timeout' | 'escalated';

export interface ExportOptions {
  readonly profile: string;
  readonly sinceMs?: number;
  readonly outcome?: readonly Outcome[];
  readonly minQualityComposite?: number;
  readonly outDir?: string;
  readonly format?: 'sharegpt' | 'ecp';
  readonly dryRun?: boolean;
  /** Explicit policy path; if omitted we try `<vinyanHome>/trajectory-policy.json`. */
  readonly policyPath?: string;
  /** Override `$VINYAN_HOME`; defaults to CWD + `.vinyan`. */
  readonly vinyanHome?: string;
  /** Optional git SHA to stamp into the manifest. */
  readonly vinyanGitSha?: string;
}

export interface ExportResult {
  readonly manifestPath: string;
  readonly artifactPath: string;
  readonly rowCount: number;
  readonly bytes: number;
  readonly durationMs: number;
  readonly datasetId: string;
  readonly sha256: string;
  /** When `true`, no files were written (dry-run). */
  readonly dryRun: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Trace + turn row shapes (DB-facing, narrow)
// ─────────────────────────────────────────────────────────────────────────

interface TraceRow {
  id: string;
  task_id: string;
  session_id: string | null;
  timestamp: number;
  routing_level: number;
  task_type_signature: string | null;
  approach: string;
  approach_description: string | null;
  risk_score: number | null;
  quality_composite: number | null;
  model_used: string;
  tokens_consumed: number;
  duration_ms: number;
  outcome: Outcome;
  failure_reason: string | null;
  oracle_verdicts: string;
  affected_files: string;
}

interface TurnRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant';
  blocks_json: string;
  cancelled_at: number | null;
  created_at: number;
}

/** Anthropic-shaped content block. Kept local; structural, not nominal. */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

// ─────────────────────────────────────────────────────────────────────────
// Intermediate rich row — foundation for W4 ECP-enriched format
// ─────────────────────────────────────────────────────────────────────────

export interface JoinedToolCall {
  /** Tool name — safe to export. */
  readonly name: string;
  /** SHA-256 of canonical JSON of raw input. */
  readonly argsHash: string;
  /** Turn id that generated this tool call — for cross-joining with predictions later. */
  readonly turnId: string;
  readonly toolUseId: string;
}

export interface JoinedTraceRow {
  readonly trace: TraceRow;
  readonly turns: readonly TurnRow[];
  readonly toolCalls: readonly JoinedToolCall[];
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────

export async function exportTrajectories(db: Database, opts: ExportOptions): Promise<ExportResult> {
  const started = Date.now();
  const format = opts.format ?? 'sharegpt';
  if (format !== 'sharegpt' && format !== 'ecp') {
    throw new Error(`Unsupported format: ${format} (supported: 'sharegpt', 'ecp')`);
  }

  const vinyanHome = opts.vinyanHome ?? join(process.cwd(), '.vinyan');
  const policyPath = opts.policyPath ?? join(vinyanHome, 'trajectory-policy.json');
  const policy: RedactionPolicy = existsSync(policyPath) ? loadPolicy(policyPath) : BUILT_IN_POLICY;
  const policyHash = hashPolicy(policy);

  const sinceMs = opts.sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;

  const traces = queryTraces(db, {
    profile: opts.profile,
    sinceMs,
    outcome: opts.outcome,
    minQualityComposite: opts.minQualityComposite,
  });

  const joinedRows: JoinedTraceRow[] = traces.map((t) => {
    const turns = t.session_id ? queryTurns(db, t.session_id) : [];
    return buildJoinedRow(t, turns);
  });

  let rowCount: number;
  let jsonl: string;
  let manifestFormat: 'sharegpt-baseline' | 'ecp-enriched';

  if (format === 'ecp') {
    // ECP-enriched projector path. Redaction is applied to the serialized
    // JSONL body BEFORE the gzip/hash step below, which preserves the A4
    // "bypass = visible manifest diff" invariant without refactoring
    // redaction.ts (we reuse applyPolicy as the string-level filter).
    const ecpRows: EcpEnrichedRow[] = joinedRows.map((j) => {
      const routing = buildRoutingExplanationFor(j);
      return toECPEnriched(j, routing, {
        redactionApplied: policy.rules.map((r) => r.kind),
        redactionPolicyVersion: policy.version,
      });
    });

    for (const row of ecpRows) {
      EcpEnrichedRowSchema.parse(row);
    }

    // Redact the JSONL text BEFORE hashing (A4). Object traversal isn't
    // needed — applyPolicy runs on the serialized string.
    const rawJsonl = ecpRows.map((r) => JSON.stringify(r)).join('\n');
    jsonl = applyPolicy(rawJsonl, policy);
    rowCount = ecpRows.length;
    manifestFormat = 'ecp-enriched';
  } else {
    const shareRows: ShareGPTRow[] = joinedRows.map((j) => toShareGPT(j, { profile: opts.profile, policy }));
    // Validate every row — fail fast if we produced something the schema
    // rejects, rather than writing a corrupt artifact.
    for (const row of shareRows) {
      ShareGPTRowSchema.parse(row);
    }
    jsonl = shareRows.map((r) => JSON.stringify(r)).join('\n');
    rowCount = shareRows.length;
    manifestFormat = 'sharegpt-baseline';
  }

  const gzipped = gzipSync(Buffer.from(jsonl, 'utf-8'));
  const sha256 = createHash('sha256').update(gzipped).digest('hex');

  const filter = {
    profile: opts.profile,
    sinceMs: sinceMs,
    outcome: opts.outcome ? [...opts.outcome] : undefined,
    minQualityComposite: opts.minQualityComposite ?? null,
  };

  const datasetId = computeDatasetId({
    format: manifestFormat,
    filter,
    rowCount,
    redactionPolicyHash: policyHash,
  });

  const outDir = opts.outDir ?? join(vinyanHome, 'trajectories', datasetId);
  const artifactPath = join(outDir, 'trajectory.jsonl.gz');
  const manifestPath = join(outDir, 'manifest.json');
  const policySnapshotPath = join(outDir, 'redaction-policy.json');

  const manifestBody = {
    schema_version: 'v1' as const,
    dataset_id: datasetId,
    filter: {
      profile: opts.profile,
      sinceMs: sinceMs,
      outcome: opts.outcome ? [...opts.outcome] : undefined,
      minQualityComposite: opts.minQualityComposite ?? null,
    },
    rowCount,
    sha256,
    redactionPolicyVersion: policy.version,
    redactionPolicyHash: policyHash,
    createdAt: Date.now(),
    sourceTables:
      format === 'ecp'
        ? ['execution_traces', 'session_turns', 'prediction_ledger', 'prediction_outcomes', 'oracle_accuracy']
        : ['execution_traces', 'session_turns'],
    ...(opts.vinyanGitSha ? { vinyanGitSha: opts.vinyanGitSha } : {}),
  };

  let manifest: ExportManifest | EcpExportManifest;
  if (format === 'ecp') {
    manifest = EcpExportManifestSchema.parse({ format: 'ecp-enriched', ...manifestBody });
  } else {
    manifest = ExportManifestSchema.parse({ format: 'sharegpt-baseline', ...manifestBody });
  }

  const dryRun = opts.dryRun ?? false;

  if (!dryRun) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(artifactPath, gzipped);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    writeFileSync(policySnapshotPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');

    // Manifest pointer row. Best-effort insert — if the table is absent
    // (e.g. caller bypassed migrations), we still return the on-disk result.
    try {
      db.run(
        `INSERT OR REPLACE INTO trajectory_exports (
          dataset_id, profile, format, schema_version, manifest_path,
          artifact_path, artifact_sha256, redaction_policy_hash, row_count,
          created_at, filter_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          datasetId,
          opts.profile,
          manifestFormat,
          'v1',
          manifestPath,
          artifactPath,
          sha256,
          policyHash,
          rowCount,
          manifest.createdAt,
          JSON.stringify(manifest.filter),
        ],
      );
    } catch {
      // Table may not exist yet — not fatal. The artifact + manifest on
      // disk are the source of truth; the DB row is a lookup optimization.
    }
  }

  return {
    manifestPath,
    artifactPath,
    rowCount,
    bytes: gzipped.byteLength,
    durationMs: Date.now() - started,
    datasetId,
    sha256,
    dryRun,
  };
}

/**
 * Build a RoutingExplanation for a JoinedTraceRow from what we have in the
 * trace row. We have `routing_level` and `risk_score` persisted — we
 * reconstruct a minimal `RoutingDecision` + neutral `RiskFactors` so the
 * explainer produces a stable, deterministic payload. If more routing
 * detail gets persisted on execution_traces in a future migration, replace
 * this shim with a direct DB read.
 */
function buildRoutingExplanationFor(joined: JoinedTraceRow): RoutingExplanation {
  const { trace } = joined;
  const level = clampRoutingLevel(trace.routing_level);
  const decision: RoutingDecision = {
    level,
    model: trace.model_used,
    budgetTokens: 0,
    latencyBudgetMs: 0,
    riskScore: trace.risk_score ?? undefined,
  };
  // Neutral factors — we do not have per-trace factor persistence yet.
  // The explainer handles zero-factor input gracefully (summary falls back
  // to "no significant risk factors detected").
  const factors: RiskFactors = {
    blastRadius: 0,
    dependencyDepth: 0,
    testCoverage: 1.0,
    fileVolatility: 0,
    irreversibility: 0,
    hasSecurityImplication: false,
    environmentType: 'development',
  };
  return explainRouting({
    taskId: trace.task_id,
    decision,
    factors,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Join graph
// ─────────────────────────────────────────────────────────────────────────

function queryTraces(
  db: Database,
  filter: {
    profile: string;
    sinceMs: number;
    outcome?: readonly Outcome[];
    minQualityComposite?: number;
  },
): TraceRow[] {
  const clauses: string[] = ['timestamp >= ?'];
  const params: unknown[] = [filter.sinceMs];

  // `execution_traces` does not currently carry a `profile` column (see
  // amendment note in the report). Until migration 005-profile retrofit
  // lands, profile scoping is applied at the `trajectory_exports` pointer
  // layer only; we filter traces by time + outcome + quality here.
  // Flag: if/when a `profile` column is added, uncomment:
  //   clauses.push('profile = ?');
  //   params.push(filter.profile);

  if (filter.outcome && filter.outcome.length > 0) {
    const placeholders = filter.outcome.map(() => '?').join(',');
    clauses.push(`outcome IN (${placeholders})`);
    params.push(...filter.outcome);
  }

  if (typeof filter.minQualityComposite === 'number') {
    clauses.push('(quality_composite IS NULL OR quality_composite >= ?)');
    params.push(filter.minQualityComposite);
  }

  const sql = `
    SELECT id, task_id, session_id, timestamp, routing_level,
           task_type_signature, approach, approach_description, risk_score,
           quality_composite, model_used, tokens_consumed, duration_ms,
           outcome, failure_reason, oracle_verdicts, affected_files
      FROM execution_traces
     WHERE ${clauses.join(' AND ')}
     ORDER BY timestamp ASC
  `;
  return db.query(sql).all(...(params as [])) as TraceRow[];
}

function queryTurns(db: Database, sessionId: string): TurnRow[] {
  return db
    .query(
      `SELECT id, session_id, seq, role, blocks_json, cancelled_at, created_at
         FROM session_turns
        WHERE session_id = ?
        ORDER BY seq ASC`,
    )
    .all(sessionId) as TurnRow[];
}

/**
 * Join a trace with its ordered turns into the rich intermediate. Tool calls
 * are extracted from `blocks_json` since `session_turns.role` is
 * ('user'|'assistant') only — tool use lives inside the assistant turn's
 * content blocks (Anthropic-native shape).
 */
export function buildJoinedRow(trace: TraceRow, turns: readonly TurnRow[]): JoinedTraceRow {
  const toolCalls: JoinedToolCall[] = [];
  for (const turn of turns) {
    const blocks = parseBlocks(turn.blocks_json);
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          argsHash: hashToolArgs(block.input),
          turnId: turn.id,
          toolUseId: block.id,
        });
      }
    }
  }
  return { trace, turns, toolCalls };
}

function parseBlocks(json: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ContentBlock[]) : [];
  } catch {
    return [];
  }
}

function hashToolArgs(input: unknown): string {
  const canonical = canonicalStringify(input);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Projectors — ShareGPT for MVP; ECPEnriched arrives in W4
// ─────────────────────────────────────────────────────────────────────────

export interface ShareGPTProjectionOptions {
  readonly profile: string;
  readonly policy: RedactionPolicy;
}

export function toShareGPT(joined: JoinedTraceRow, opts: ShareGPTProjectionOptions): ShareGPTRow {
  const { trace, turns, toolCalls } = joined;
  const conversations: ShareGPTMessage[] = [];

  // Always emit a system turn carrying the task framing. This is the
  // "goal under which the trajectory was produced", analogous to the
  // system prompt in Anthropic-native Turn[].
  const systemValue = buildSystemValue(trace);
  conversations.push({ from: 'system', value: applyPolicy(systemValue, opts.policy) });

  if (turns.length === 0) {
    // No session turns — synthesize a minimal human turn from trace metadata
    // so the row satisfies `conversations: [_min 1_]` and remains useful.
    conversations.push({
      from: 'human',
      value: applyPolicy(trace.approach_description ?? trace.approach, opts.policy),
    });
  } else {
    for (const turn of turns) {
      const blocks = parseBlocks(turn.blocks_json);
      const msg = blockListToMessage(turn.role, blocks, opts.policy);
      if (msg) conversations.push(msg);

      // Emit tool_use blocks as separate `tool` role entries so ShareGPT
      // consumers that care about tool structure can find them without
      // parsing the assistant prose.
      for (const block of blocks) {
        if (block.type === 'tool_use') {
          conversations.push({
            from: 'tool',
            value: `<tool_call name="${block.name}" id="${block.id}"/>`,
          });
        }
      }
    }
  }

  const row: ShareGPTRow = {
    id: trace.id,
    conversations,
    metadata: {
      source: 'vinyan',
      dataset_version: DATASET_VERSION,
      profile: opts.profile,
      task_type_signature: trace.task_type_signature,
      routing_level: clampRoutingLevel(trace.routing_level),
      outcome: trace.outcome,
      redaction_policy_version: opts.policy.version,
    },
  };

  if (toolCalls.length > 0) {
    return {
      ...row,
      tools: toolCalls.map((t) => ({ name: t.name, args_hash: t.argsHash })),
    };
  }
  return row;
}

function buildSystemValue(trace: TraceRow): string {
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

function blockListToMessage(
  role: 'user' | 'assistant',
  blocks: ContentBlock[],
  policy: RedactionPolicy,
): ShareGPTMessage | null {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'thinking') {
      // Keep thinking blocks as a separate annotation so they survive the
      // round-trip — but do not inline raw reasoning into the main value.
      texts.push(`<thinking>${block.thinking}</thinking>`);
    } else if (block.type === 'tool_result') {
      const errTag = block.is_error ? ' is_error="true"' : '';
      texts.push(`<tool_result id="${block.tool_use_id}"${errTag}>${block.content}</tool_result>`);
    }
    // tool_use handled separately above — surfaced as its own `tool` entry.
  }

  if (texts.length === 0) return null;

  const value = applyPolicy(texts.join('\n\n'), policy);
  return { from: role === 'user' ? 'human' : 'gpt', value };
}

function clampRoutingLevel(n: number): 0 | 1 | 2 | 3 {
  if (n <= 0) return 0;
  if (n >= 3) return 3;
  return n as 0 | 1 | 2 | 3;
}

// ─────────────────────────────────────────────────────────────────────────
// Dataset id
// ─────────────────────────────────────────────────────────────────────────

interface DatasetIdInput {
  format: 'sharegpt-baseline' | 'ecp-enriched';
  filter: {
    profile?: string;
    sinceMs: number | null;
    outcome?: string[];
    minQualityComposite: number | null;
  };
  rowCount: number;
  redactionPolicyHash: string;
}

function computeDatasetId(input: DatasetIdInput): string {
  const canonical = canonicalStringify(input);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

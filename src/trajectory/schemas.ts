/**
 * Trajectory Exporter — Zod schemas for ShareGPT baseline format.
 *
 * Scope of this PR (MVP): ShareGPT-baseline only. The W4 follow-up will
 * add `ECP-enriched` rows joining `prediction_ledger` + `prediction_outcomes`
 * + `oracle_accuracy_store`; those joiners are a one-line extension on the
 * intermediate `JoinedTraceRow` produced by the exporter — see
 * `buildJoinedRow` / `toShareGPT` in `exporter.ts`.
 *
 * Privacy invariant (A4-style content-addressing): redaction runs BEFORE
 * the artifact is hashed. Any bypass mutates the artifact SHA-256 recorded
 * in `ExportManifestSchema.sha256`, which is how we detect tampering.
 */

import { z } from 'zod';

/**
 * One message in a ShareGPT conversation. `from` is the speaker role;
 * `value` is the text content. We include a `tool` role so tool invocations
 * surface separately from assistant prose (raw args never included here —
 * they go in `ShareGPTRow.tools[].args_hash`).
 */
export const ShareGPTMessageSchema = z.object({
  from: z.enum(['system', 'human', 'gpt', 'tool']),
  value: z.string(),
});

export type ShareGPTMessage = z.infer<typeof ShareGPTMessageSchema>;

/**
 * A single ShareGPT row — one per `execution_traces.id`.
 *
 * `tools[].args_hash` holds a SHA-256 of the tool input JSON; raw args are
 * never serialized. This is A4-style content-binding: a consumer can verify
 * a claim about a tool call without the exporter exposing the underlying
 * parameters.
 */
export const ShareGPTRowSchema = z.object({
  id: z.string(),
  conversations: z.array(ShareGPTMessageSchema).min(1),
  tools: z
    .array(
      z.object({
        name: z.string(),
        args_hash: z.string(),
      }),
    )
    .optional(),
  metadata: z.object({
    source: z.literal('vinyan'),
    dataset_version: z.string(),
    profile: z.string(),
    task_type_signature: z.string().nullable(),
    routing_level: z.number().int().min(0).max(3),
    outcome: z.enum(['success', 'failure', 'timeout', 'escalated']),
    redaction_policy_version: z.string(),
  }),
});

export type ShareGPTRow = z.infer<typeof ShareGPTRowSchema>;

/**
 * Export manifest — one per `<dataset_id>/` directory. Stored both on disk
 * (`manifest.json`) and indexed in the `trajectory_exports` table.
 *
 * `sha256` is computed over the gzipped JSONL artifact after redaction.
 * `dataset_id` is a deterministic first-16-hex of SHA-256 over
 * `{format, filter, rowCount, redactionPolicyHash}` so repeatable exports
 * with identical inputs produce identical dataset ids.
 */
export const ExportManifestSchema = z.object({
  format: z.literal('sharegpt-baseline'),
  schema_version: z.literal('v1'),
  dataset_id: z.string(),
  filter: z.object({
    profile: z.string().optional(),
    sinceMs: z.number().int().nullable(),
    outcome: z.array(z.string()).optional(),
    minQualityComposite: z.number().nullable(),
  }),
  rowCount: z.number().int().min(0),
  sha256: z.string(),
  redactionPolicyVersion: z.string(),
  redactionPolicyHash: z.string(),
  createdAt: z.number().int(),
  sourceTables: z.array(z.string()),
  vinyanGitSha: z.string().optional(),
});

export type ExportManifest = z.infer<typeof ExportManifestSchema>;

/** Dataset schema version string embedded in each row's metadata. */
export const DATASET_VERSION = 'sharegpt-baseline/v1';

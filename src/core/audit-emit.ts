/**
 * Audit publish boundary — wraps every `bus.emit('audit:entry', ...)` so
 * cross-cutting wrapper fields (id, ts, redactionPolicyHash, schemaVersion)
 * are filled identically at every emit site, payloads are redacted before
 * persistence (defense-in-depth on top of source-side redaction), and the
 * entry is zod-validated before it reaches the bus.
 *
 * Validation is `safeParse` here so a malformed entry drops + warns rather
 * than crashing the orchestrator. The drop is observable via the
 * `auditEntriesDropped` counter exposed by `getAuditEmitMetrics()`.
 *
 * Hashing helpers (sha256OfJson, stableRuleId) are exported so emit sites
 * can compute argsHash / resultHash / contract-rule fingerprints without
 * duplicating the canonical-JSON walk.
 */

import { createHash, randomUUID } from 'node:crypto';
import { BUILT_IN_POLICY, hashPolicy, type RedactionPolicy } from '../trajectory/redaction.ts';
import {
  type ActorRef,
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
  AuditEntrySchema,
  type AuditEntryVariant,
  type EvidenceRef,
} from './audit.ts';
import { redactAuditPayload } from './audit-redact.ts';
import type { VinyanBus } from './bus.ts';

/** Default policy version label until a factory-injected value lands. */
export const DEFAULT_AUDIT_POLICY_VERSION = 'audit-v1';

export interface EmitAuditEntryOptions {
  /** Bus instance. Absent → no-op so call sites stay one-liners under bus-undefined orchestrators. */
  bus?: VinyanBus;
  /** Required: every audit entry is task-scoped (recorder needs taskId). */
  taskId: string;
  /** Defaults to `Date.now()`. Tests pin this for determinism. */
  ts?: number;
  /** Per-turn correlation id for grouping a turn's worth of entries. Codebase uses string turn ids. */
  turn?: string;
  /** Who produced this entry. Use canonical actor names — never bare 'agent'. */
  actor: ActorRef;
  /** Governance policy version label. Use `DEFAULT_AUDIT_POLICY_VERSION` until factory wires it. */
  policyVersion?: string;
  /** Defense-in-depth payload redaction. Source-side redaction is primary; this is the safety net. */
  redactionPolicy?: RedactionPolicy;
  /** Optional links to backing evidence (file hashes, prior entries, fact ids). */
  evidenceRefs?: EvidenceRef[];
  /** Causal parent in the audit DAG (e.g., a tool_call entry whose denial spawned a decision entry). */
  parentEntryId?: string;
  /** The kind-specific payload. Already source-redacted; this helper redacts again as a safety net. */
  variant: AuditEntryVariant;
}

let droppedCount = 0;

/**
 * Reset internal counters. Test-only — tests that assert drop counts call
 * this between cases.
 */
export function resetAuditEmitMetrics(): void {
  droppedCount = 0;
}

export function getAuditEmitMetrics(): { droppedCount: number } {
  return { droppedCount };
}

/**
 * Field names that carry user-content strings or structured payload trees
 * the emit boundary will tree-walk through `redactAuditPayload`. Other
 * fields (hashes, ids, enum literals, latencies) MUST stay structural —
 * the entropy heuristic in `BUILT_IN_POLICY` would otherwise flag a 64-char
 * sha256 as a token and rewrite it to `<REDACTED_TOKEN>`, which then fails
 * the schema's `argsHash`/`contentHash` regex.
 */
const REDACTABLE_FIELDS = new Set([
  'content',
  'rationale',
  'argsRedacted',
  'resultRedacted',
  'payloadRedacted',
  'contentRedactedPreview',
]);

/**
 * Emit one AuditEntry. Returns the parsed entry on success, undefined
 * when the bus is absent or the entry failed schema validation. Schema
 * failures bump `auditEntriesDropped` so an emit-site bug is observable
 * without crashing the loop.
 *
 * Defense-in-depth: only fields named in `REDACTABLE_FIELDS` are tree-walked
 * through the redaction policy. Structural fields (hashes, ids, enum
 * literals) are passed through untouched. Source-side redaction remains
 * primary — emitters MUST redact `argsRedacted` / `resultRedacted` before
 * calling.
 */
export function emitAuditEntry(opts: EmitAuditEntryOptions): AuditEntry | undefined {
  if (!opts.bus) return undefined;
  const policy = opts.redactionPolicy ?? BUILT_IN_POLICY;
  const safeVariant = redactSelectedFields(opts.variant, policy);
  const candidate: AuditEntry = {
    id: randomUUID(),
    taskId: opts.taskId,
    ts: opts.ts ?? Date.now(),
    schemaVersion: AUDIT_SCHEMA_VERSION,
    policyVersion: opts.policyVersion ?? DEFAULT_AUDIT_POLICY_VERSION,
    actor: opts.actor,
    redactionPolicyHash: hashPolicy(policy),
    ...(opts.parentEntryId ? { parentEntryId: opts.parentEntryId } : {}),
    ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
    ...(opts.evidenceRefs ? { evidenceRefs: opts.evidenceRefs } : {}),
    ...safeVariant,
  } as AuditEntry;

  const parsed = AuditEntrySchema.safeParse(candidate);
  if (!parsed.success) {
    droppedCount += 1;
    return undefined;
  }
  opts.bus.emit('audit:entry', parsed.data);
  return parsed.data;
}

/**
 * SHA-256 of a value's canonical JSON form. Object keys are sorted
 * recursively so semantically-equal payloads produce identical hashes
 * regardless of key insertion order. Used for argsHash, resultHash, and
 * contract-rule fingerprints. Pure; no I/O.
 */
export function sha256OfJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Truncate a string for the redacted preview field. Keeps the first
 * `maxChars` and appends `…` when truncation occurs. Source-side
 * redaction is expected to have already run; this helper does not
 * redact, only truncate.
 */
export function previewString(value: unknown, maxChars: number = 240): string {
  const s = typeof value === 'string' ? value : safeJson(value);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

function redactSelectedFields(variant: AuditEntryVariant, policy: RedactionPolicy): AuditEntryVariant {
  const out: Record<string, unknown> = { ...(variant as unknown as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (!REDACTABLE_FIELDS.has(key)) continue;
    out[key] = redactAuditPayload(out[key], policy);
  }
  return out as AuditEntryVariant;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

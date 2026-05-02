/**
 * JSONL line schema for per-session event streams.
 *
 * Source-of-truth for the on-disk format. Every line in
 * `<sessionsDir>/<sessionId>/events.jsonl` parses as a `JsonlLine` —
 * a discriminated union over `kind`.
 *
 * Phase 1 keeps the envelope strict (lineId, parentLineId, sessionId,
 * seq, ts, actor, kind, v are all required) and leaves rich payload
 * shapes (TaskInput, TaskResult, ContentBlock, WorkingMemoryState,
 * CompactionResult) intentionally untyped — `z.unknown()` — so Phase 2
 * write paths can land without lockstep schema authoring. Phase 2 will
 * tighten payloads as each call site is wired.
 *
 * Spec / axioms touched:
 *   - I16 (audit never deleted): no `kind` here mutates prior lines.
 *   - A4 (content-addressed): `(sessionId, seq, lineId)` triple.
 *   - A8 (traceable accountability): `actor` field is mandatory.
 */
import { z } from 'zod';

/** Schema version of the JSONL line envelope. Bump on breaking change. */
export const JSONL_SCHEMA_VERSION = 1 as const;

export const ActorKindZ = z.enum(['user', 'agent', 'system', 'orchestrator', 'sleep-cycle', 'cli', 'api']);

export const ActorZ = z.object({
  kind: ActorKindZ,
  id: z.string().optional(),
});

/** All kinds the appender accepts. Mirrors the migration plan §Architecture. */
export const KindZ = z.enum([
  'session.created',
  'session.metadata.updated',
  'session.status.changed',
  'session.archived',
  'session.unarchived',
  'session.deleted',
  'session.restored',
  'session.purged',
  'session.compacted',
  'task.created',
  'task.status.changed',
  'task.archived',
  'turn.appended',
  'turn.token-count.updated',
  'turn.cancelled',
  'working-memory.snapshot',
]);

export type Kind = z.infer<typeof KindZ>;
export type Actor = z.infer<typeof ActorZ>;

/**
 * Common envelope shared by every line. Discriminator is `kind`.
 *
 * `seq` is per-session monotonic and allocated under the appender's
 * mutex (`mutex.ts`). `parentLineId` lets the rebuild path validate
 * topology defensively even if `seq` ever desyncs.
 */
const EnvelopeShape = {
  v: z.literal(JSONL_SCHEMA_VERSION),
  lineId: z.string().min(1),
  parentLineId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  actor: ActorZ,
} as const;

/**
 * Line schema — strict envelope, opaque payload.
 *
 * We deliberately do NOT use `z.discriminatedUnion` over fully-typed
 * payloads in Phase 1: the payload shapes (TaskInput, TaskResult,
 * WorkingMemoryState, CompactionResult, ContentBlock[]) are large and
 * would force premature schema duplication. Phase 2 narrows per-kind
 * payloads at the call sites that actually write them.
 */
export const JsonlLineZ = z.object({
  ...EnvelopeShape,
  kind: KindZ,
  payload: z.unknown(),
});

export type JsonlLine = z.infer<typeof JsonlLineZ>;

/** Input shape for `JsonlAppender.append` — the appender fills the rest. */
export interface AppendInput {
  kind: Kind;
  payload: unknown;
  actor: Actor;
  /** Caller-supplied parent link. When omitted, the appender chains to the prior line. */
  parentLineId?: string | null;
}

/**
 * Read-side error. Emitted by `JsonlReader` when a line fails Zod
 * validation; caller decides whether to throw or skip per A9
 * (resilient degradation).
 */
export interface JsonlLineError {
  sessionId: string;
  /** 0-based byte offset of the start of this line in the segment file. */
  byteOffset: number;
  /** Length of the offending line in bytes (excluding the trailing newline). */
  byteLength: number;
  /** Raw line bytes decoded as utf-8 — useful for forensics. */
  raw: string;
  /** Zod or parse error message. */
  reason: string;
}

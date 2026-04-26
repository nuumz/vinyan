/**
 * Gateway envelopes — Zod schemas for inbound and outbound messages.
 *
 * The structural minimums (`GatewayInboundEnvelopeMinimal`,
 * `GatewayOutboundEnvelope`) live in `src/gateway/types.ts` so the factory
 * track can reference them without importing Zod. This file owns the full,
 * runtime-validated shapes used by the dispatcher and adapters.
 *
 * A2 compliance: inbound envelopes enter the pipeline as a hypothesis at
 * `confidence: 'unknown'`. Tier promotion is strictly downstream — nothing
 * in the gateway layer promotes an envelope to a higher tier.
 *
 * Decision reference: [D21](../../docs/architecture/decisions.md#decision-21)
 * — adapters publish envelopes; the dispatcher is the only code path into
 * `executeTask`.
 */
import { z } from 'zod';
import type {
  GatewayPlatform,
  GatewayInboundEnvelopeMinimal,
  GatewayOutboundEnvelope as GatewayOutboundEnvelopeMinimal,
} from './types.ts';

// ── Constants ─────────────────────────────────────────────────────────

/** Max user-message text length at the Gateway boundary. */
export const MAX_ENVELOPE_TEXT_LEN = 16_000;
/** Max attachments per inbound envelope. */
export const MAX_ENVELOPE_ATTACHMENTS = 10;

/** Mirrors `src/orchestrator/types.ts#PROFILE_REGEX`. */
const PROFILE_REGEX = /^[a-z][a-z0-9-]*$/;
const isValidProfile = (s: string): boolean => s === 'default' || PROFILE_REGEX.test(s);
const ProfileSchema = z.string().refine(isValidProfile, { message: 'invalid profile name' });

const PlatformSchema = z.enum(['telegram', 'slack', 'discord', 'whatsapp', 'signal', 'email']);
const TrustTierSchema = z.enum(['unknown', 'pairing', 'paired', 'admin']);
const ChatKindSchema = z.enum(['dm', 'group', 'channel']);
const ParseModeSchema = z.enum(['MarkdownV2', 'HTML', 'plain']);

// ── Schemas ───────────────────────────────────────────────────────────

export const AttachmentSchema = z.object({
  kind: z.enum(['photo', 'document', 'audio', 'video', 'voice']),
  platformFileId: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});

export type Attachment = z.infer<typeof AttachmentSchema>;

const EvidenceSchema = z.object({
  kind: z.literal('user-message'),
  hash: z.string(),
});

const HypothesisSchema = z.object({
  claim: z.string(),
  confidence: z.literal('unknown'),
  evidence: z.array(EvidenceSchema),
});

export const InboundEnvelopeSchema = z.object({
  envelopeId: z.string().uuid(),
  platform: PlatformSchema,
  profile: ProfileSchema,
  receivedAt: z.number().int(),
  chat: z.object({ id: z.string(), kind: ChatKindSchema }),
  sender: z.object({
    platformUserId: z.string(),
    displayName: z.string().optional(),
    gatewayUserId: z.string().uuid().nullable(),
    trustTier: TrustTierSchema,
  }),
  message: z.object({
    text: z.string().max(MAX_ENVELOPE_TEXT_LEN),
    attachments: z.array(AttachmentSchema).max(MAX_ENVELOPE_ATTACHMENTS).default([]),
    replyToEnvelopeId: z.string().uuid().optional(),
    threadKey: z.string().optional(),
  }),
  hypothesis: HypothesisSchema,
});

export type InboundEnvelope = z.infer<typeof InboundEnvelopeSchema>;

export const OutboundEnvelopeSchema = z.object({
  envelopeId: z.string().uuid(),
  platform: PlatformSchema,
  chatId: z.string(),
  text: z.string().max(MAX_ENVELOPE_TEXT_LEN),
  parseMode: ParseModeSchema.default('plain'),
  replyTo: z.string().optional(),
});

export type OutboundEnvelope = z.infer<typeof OutboundEnvelopeSchema>;

// ── Builders ──────────────────────────────────────────────────────────

/** Web-Crypto-powered SHA-256 over the raw message text. */
async function sha256Hex(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Build a fully-populated, schema-valid inbound envelope.
 *
 * The evidence hash is deterministic: SHA-256 over the raw user text — so
 * two identical messages from the same sender produce the same hash,
 * supporting the World Graph content-addressing invariant (A4).
 */
export async function buildInboundEnvelope(opts: {
  platform: GatewayPlatform;
  profile: string;
  chat: { id: string; kind: 'dm' | 'group' | 'channel' };
  sender: {
    platformUserId: string;
    displayName?: string;
    gatewayUserId?: string | null;
    trustTier: 'unknown' | 'pairing' | 'paired' | 'admin';
  };
  text: string;
  attachments?: Attachment[];
  replyToEnvelopeId?: string;
  threadKey?: string;
  envelopeId?: string;
  now?: number;
}): Promise<InboundEnvelope> {
  const receivedAt = opts.now ?? Date.now();
  const envelopeId = opts.envelopeId ?? crypto.randomUUID();
  const hash = await sha256Hex(opts.text);

  const envelope: InboundEnvelope = {
    envelopeId,
    platform: opts.platform,
    profile: opts.profile,
    receivedAt,
    chat: { id: opts.chat.id, kind: opts.chat.kind },
    sender: {
      platformUserId: opts.sender.platformUserId,
      displayName: opts.sender.displayName,
      gatewayUserId: opts.sender.gatewayUserId ?? null,
      trustTier: opts.sender.trustTier,
    },
    message: {
      text: opts.text,
      attachments: opts.attachments ?? [],
      replyToEnvelopeId: opts.replyToEnvelopeId,
      threadKey: opts.threadKey,
    },
    hypothesis: {
      claim: opts.text,
      confidence: 'unknown',
      evidence: [{ kind: 'user-message', hash }],
    },
  };

  // Defense-in-depth: parse through the schema so the caller never ships a
  // structurally wrong envelope even if an upstream bug slips through TS.
  return InboundEnvelopeSchema.parse(envelope);
}

/**
 * Trivially align the full `InboundEnvelope` with the structural minimum so
 * factory/lifecycle code can hand back a handle typed against either shape.
 */
export function toMinimalInbound(env: InboundEnvelope): GatewayInboundEnvelopeMinimal {
  return {
    envelopeId: env.envelopeId,
    platform: env.platform,
    profile: env.profile,
    receivedAt: env.receivedAt,
    text: env.message.text,
  };
}

/** Project the richer outbound shape onto the structural minimum. */
export function toMinimalOutbound(env: OutboundEnvelope): GatewayOutboundEnvelopeMinimal {
  return {
    envelopeId: env.envelopeId,
    platform: env.platform,
    chatId: env.chatId,
    text: env.text,
    replyTo: env.replyTo,
  };
}

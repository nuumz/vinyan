/**
 * Tests for Gateway envelope schemas + builder.
 *
 * The envelope is the epistemic boundary: everything entering the gateway
 * lands at `confidence: 'unknown'` (A2). Tier promotion is strictly
 * downstream. These tests verify the shape, the refusal of malformed
 * inputs, and the determinism of the evidence hash.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildInboundEnvelope,
  InboundEnvelopeSchema,
  OutboundEnvelopeSchema,
  MAX_ENVELOPE_ATTACHMENTS,
  MAX_ENVELOPE_TEXT_LEN,
  type Attachment,
} from '../../src/gateway/envelope.ts';

describe('buildInboundEnvelope', () => {
  test('produces a schema-valid envelope with default fields', async () => {
    const env = await buildInboundEnvelope({
      platform: 'telegram',
      profile: 'default',
      chat: { id: '42', kind: 'dm' },
      sender: { platformUserId: '7', trustTier: 'unknown' },
      text: 'hello there',
      now: 1_700_000_000_000,
    });

    expect(env.platform).toBe('telegram');
    expect(env.profile).toBe('default');
    expect(env.receivedAt).toBe(1_700_000_000_000);
    expect(env.hypothesis.confidence).toBe('unknown');
    expect(env.hypothesis.claim).toBe('hello there');
    expect(env.hypothesis.evidence).toHaveLength(1);
    expect(env.sender.gatewayUserId).toBeNull();
    expect(env.message.attachments).toEqual([]);
    expect(InboundEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  test('evidence hash is deterministic for identical input text', async () => {
    const a = await buildInboundEnvelope({
      platform: 'telegram',
      profile: 'default',
      chat: { id: '1', kind: 'dm' },
      sender: { platformUserId: '1', trustTier: 'unknown' },
      text: 'same text',
    });
    const b = await buildInboundEnvelope({
      platform: 'telegram',
      profile: 'default',
      chat: { id: '99', kind: 'group' },
      sender: { platformUserId: '2', trustTier: 'paired' },
      text: 'same text',
    });
    expect(a.hypothesis.evidence[0]!.hash).toBe(b.hypothesis.evidence[0]!.hash);
    expect(a.hypothesis.evidence[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different text yields a different evidence hash', async () => {
    const a = await buildInboundEnvelope({
      platform: 'telegram',
      profile: 'default',
      chat: { id: '1', kind: 'dm' },
      sender: { platformUserId: '1', trustTier: 'unknown' },
      text: 'alpha',
    });
    const b = await buildInboundEnvelope({
      platform: 'telegram',
      profile: 'default',
      chat: { id: '1', kind: 'dm' },
      sender: { platformUserId: '1', trustTier: 'unknown' },
      text: 'beta',
    });
    expect(a.hypothesis.evidence[0]!.hash).not.toBe(b.hypothesis.evidence[0]!.hash);
  });

  test('propagates attachments and reply metadata', async () => {
    const att: Attachment = { kind: 'photo', platformFileId: 'F1', sizeBytes: 10, mimeType: 'image/png' };
    const replyTo = crypto.randomUUID();
    const env = await buildInboundEnvelope({
      platform: 'telegram',
      profile: 'work-alpha',
      chat: { id: '1', kind: 'dm' },
      sender: { platformUserId: '1', trustTier: 'paired', displayName: 'alice' },
      text: 'hi',
      attachments: [att],
      replyToEnvelopeId: replyTo,
      threadKey: 'thread-9',
    });
    expect(env.message.attachments).toEqual([att]);
    expect(env.message.replyToEnvelopeId).toBe(replyTo);
    expect(env.message.threadKey).toBe('thread-9');
    expect(env.sender.displayName).toBe('alice');
  });
});

describe('InboundEnvelopeSchema', () => {
  async function baseEnvelope() {
    return buildInboundEnvelope({
      platform: 'telegram',
      profile: 'default',
      chat: { id: '1', kind: 'dm' },
      sender: { platformUserId: '1', trustTier: 'unknown' },
      text: 'hi',
    });
  }

  test('rejects an invalid platform', async () => {
    const env = await baseEnvelope();
    const bad = { ...env, platform: 'zoom' };
    expect(InboundEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  test('rejects an invalid profile name', async () => {
    const env = await baseEnvelope();
    const bad = { ...env, profile: 'Has_Caps' };
    expect(InboundEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  test('accepts a kebab-case profile name', async () => {
    const env = await baseEnvelope();
    const ok = { ...env, profile: 'work-alpha' };
    expect(InboundEnvelopeSchema.safeParse(ok).success).toBe(true);
  });

  test('rejects message text over the cap', async () => {
    const env = await baseEnvelope();
    const bad = {
      ...env,
      message: { ...env.message, text: 'x'.repeat(MAX_ENVELOPE_TEXT_LEN + 1) },
    };
    expect(InboundEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  test('rejects more than 10 attachments', async () => {
    const env = await baseEnvelope();
    const att: Attachment = { kind: 'photo', platformFileId: 'F' };
    const bad = {
      ...env,
      message: {
        ...env.message,
        attachments: Array.from({ length: MAX_ENVELOPE_ATTACHMENTS + 1 }, () => att),
      },
    };
    expect(InboundEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  test('hypothesis confidence must be the literal "unknown"', async () => {
    const env = await baseEnvelope();
    const bad = { ...env, hypothesis: { ...env.hypothesis, confidence: 'heuristic' } };
    expect(InboundEnvelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('OutboundEnvelopeSchema', () => {
  test('defaults parseMode to plain when omitted', () => {
    const parsed = OutboundEnvelopeSchema.parse({
      envelopeId: crypto.randomUUID(),
      platform: 'telegram',
      chatId: 'chat-1',
      text: 'ok',
    });
    expect(parsed.parseMode).toBe('plain');
  });

  test('accepts MarkdownV2 and HTML parse modes', () => {
    for (const parseMode of ['MarkdownV2', 'HTML', 'plain'] as const) {
      const parsed = OutboundEnvelopeSchema.parse({
        envelopeId: crypto.randomUUID(),
        platform: 'telegram',
        chatId: 'chat-1',
        text: 'ok',
        parseMode,
      });
      expect(parsed.parseMode).toBe(parseMode);
    }
  });

  test('rejects text over the cap', () => {
    const result = OutboundEnvelopeSchema.safeParse({
      envelopeId: crypto.randomUUID(),
      platform: 'telegram',
      chatId: 'chat-1',
      text: 'x'.repeat(MAX_ENVELOPE_TEXT_LEN + 1),
    });
    expect(result.success).toBe(false);
  });
});

/**
 * Anthropic provider — tier-aware cache marker placement (plan commit B).
 *
 * Exercises the internal helpers that split prompts at frozen/session/turn
 * boundaries and attach `cache_control` markers without spinning up the
 * real Anthropic SDK.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildSystemBlocks,
  buildUserMessages,
  splitAtTiers,
} from '../../../src/orchestrator/llm/anthropic-provider.ts';
import type { LLMRequest } from '../../../src/orchestrator/types.ts';

describe('splitAtTiers — tier-aware block splitting', () => {
  it('returns empty array for empty text', () => {
    expect(splitAtTiers('', { frozenEnd: 0, sessionEnd: 0, totalEnd: 0 })).toEqual([]);
  });

  it('returns a single block without cache marker when offsets are undefined', () => {
    const blocks = splitAtTiers('hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('emits three blocks with two cache markers for frozen + session + turn', () => {
    const frozen = 'FROZEN_TEXT';
    const session = 'SESSION_TEXT';
    const turn = 'TURN_TEXT';
    const sep = '\n\n';
    const text = `${frozen}${sep}${session}${sep}${turn}`;
    const offsets = {
      frozenEnd: frozen.length + sep.length,
      sessionEnd: frozen.length + sep.length + session.length + sep.length,
      totalEnd: text.length,
    };

    const blocks = splitAtTiers(text, offsets);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      type: 'text',
      text: `${frozen}${sep}`,
      cache_control: { type: 'ephemeral' },
    });
    expect(blocks[1]).toEqual({
      type: 'text',
      text: `${session}${sep}`,
      cache_control: { type: 'ephemeral' },
    });
    expect(blocks[2]).toEqual({ type: 'text', text: turn });

    // Joined text reproduces the original
    expect(blocks.map((b) => b.text).join('')).toBe(text);

    // Exactly 2 cache markers — within Anthropic's 4-breakpoint limit.
    const markers = blocks.filter((b) => b.cache_control).length;
    expect(markers).toBe(2);
  });

  it('emits two blocks (frozen + session) when turn is empty', () => {
    const frozen = 'FROZEN';
    const session = 'SESSION';
    const sep = '\n\n';
    const text = `${frozen}${sep}${session}`;
    const offsets = {
      frozenEnd: frozen.length + sep.length,
      sessionEnd: text.length,
      totalEnd: text.length,
    };
    const blocks = splitAtTiers(text, offsets);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.cache_control).toBeDefined();
    expect(blocks[1]?.cache_control).toBeDefined();
  });

  it('emits a single block with cache marker when only frozen content exists', () => {
    const text = 'ROLE_ONLY';
    const offsets = { frozenEnd: text.length, sessionEnd: text.length, totalEnd: text.length };
    const blocks = splitAtTiers(text, offsets);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[0]?.text).toBe(text);
  });

  it('emits a single turn block without cache marker when only turn content exists', () => {
    const text = 'TASK_ONLY';
    const offsets = { frozenEnd: 0, sessionEnd: 0, totalEnd: text.length };
    const blocks = splitAtTiers(text, offsets);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(text);
    expect(blocks[0]?.cache_control).toBeUndefined();
  });
});

describe('buildSystemBlocks — request → Anthropic system[] content', () => {
  function baseRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
    return {
      systemPrompt: 'SYS_PROMPT',
      userPrompt: 'USR_PROMPT',
      maxTokens: 1000,
      ...overrides,
    };
  }

  it('uses tiers when request.tiers.system is set', () => {
    const systemPrompt = 'FROZEN\n\nSESSION\n\nTURN';
    const blocks = buildSystemBlocks(
      baseRequest({
        systemPrompt,
        tiers: {
          system: { frozenEnd: 8, sessionEnd: 17, totalEnd: systemPrompt.length },
          user: { frozenEnd: 0, sessionEnd: 0, totalEnd: 0 },
        },
      }),
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.cache_control).toBeDefined();
    expect(blocks[1]?.cache_control).toBeDefined();
    expect(blocks[2]?.cache_control).toBeUndefined();
  });

  it('emits a single block with no cache marker when tiers are absent', () => {
    // Post-B5: without tiers, the provider emits a plain unsplit system block.
    const blocks = buildSystemBlocks(baseRequest());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache_control).toBeUndefined();
  });
});

describe('buildUserMessages — user prompt → Anthropic messages[]', () => {
  function baseRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
    return {
      systemPrompt: 'SYS',
      userPrompt: 'USR',
      maxTokens: 1000,
      ...overrides,
    };
  }

  it('splits at tier boundaries when request.tiers.user is set', () => {
    const userPrompt = 'INSTRUCTIONS\n\nTASK';
    const messages = buildUserMessages(
      baseRequest({
        userPrompt,
        tiers: {
          system: { frozenEnd: 0, sessionEnd: 0, totalEnd: 0 },
          user: { frozenEnd: 0, sessionEnd: 14, totalEnd: userPrompt.length },
        },
      }),
    );
    expect(messages).toHaveLength(1);
    const content = messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string; cache_control?: unknown }>;
    // 1 session block (with marker) + 1 turn block (no marker)
    const withMarker = blocks.filter((b) => b.cache_control);
    expect(withMarker).toHaveLength(1);
  });

  it('no tiers → single plain user message (no cache marker)', () => {
    // Post-B5: the legacy [PROJECT INSTRUCTIONS] heuristic path is gone.
    // Without tiers the user prompt is shipped as a single plain message.
    const userPrompt = '[PROJECT INSTRUCTIONS]\nsome rules\n[TASK]\ndo a thing';
    const messages = buildUserMessages(baseRequest({ userPrompt }));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe(userPrompt);
  });

  it('single string content when tiers are not set', () => {
    const messages = buildUserMessages(baseRequest({ userPrompt: 'just a task' }));
    expect(messages[0]?.content).toBe('just a task');
  });
});

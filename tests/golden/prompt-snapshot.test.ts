/**
 * Golden snapshot — system prompt shape per (routingLevel, taskType).
 *
 * Pinned output of `buildSystemPrompt` so that Phase 0 workstreams that
 * restructure the prompt (W1/W2/W3/W4) produce reviewable diffs in the
 * __snapshots__ dir rather than silently mutating agent behaviour.
 *
 * Snapshots are deterministic because this test omits `environment`,
 * `instructions`, `agentProfile`, `soulContent`, and `agentContext` — those
 * fields gather OS/git/date state at runtime.
 */
import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from '../../src/orchestrator/agent/agent-worker-entry.ts';

describe('Golden: system prompt shape', () => {
  test('L0 code', () => {
    expect(buildSystemPrompt(0, 'code', {})).toMatchSnapshot();
  });

  test('L1 code', () => {
    expect(buildSystemPrompt(1, 'code', {})).toMatchSnapshot();
  });

  test('L2 code', () => {
    expect(buildSystemPrompt(2, 'code', {})).toMatchSnapshot();
  });

  test('L2 reasoning', () => {
    expect(buildSystemPrompt(2, 'reasoning', {})).toMatchSnapshot();
  });
});

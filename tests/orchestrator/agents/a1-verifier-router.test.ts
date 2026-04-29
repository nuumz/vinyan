/**
 * Item 4 — A1 verifier router (shared helper).
 *
 * The function powers both Phase-13's workflow-executor delegate-sub-agent
 * path AND Phase-14's agent-loop delegation path. Routing logic must be
 * unit-tested in one place; integration tests for each call site live in
 * the respective surface's test file.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectVerifierForDelegation,
  VERIFY_DESCRIPTION_PATTERN,
} from '../../../src/orchestrator/agents/a1-verifier-router.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';

function makeRegistry() {
  const ws = mkdtempSync(join(tmpdir(), 'vinyan-a1-router-'));
  return { reg: loadAgentRegistry(ws, undefined), cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

describe('VERIFY_DESCRIPTION_PATTERN', () => {
  test('matches verification verbs as whole words', () => {
    expect(VERIFY_DESCRIPTION_PATTERN.test('verify the implementation')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('REVIEW the patch')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('audit code paths')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('critique the design')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('validate inputs')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('evaluate trade-offs')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('assess the risk')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('sanity-check the math')).toBe(true);
    expect(VERIFY_DESCRIPTION_PATTERN.test('sanity check the math')).toBe(true);
  });

  test('does NOT match false positives (whole-word boundary)', () => {
    expect(VERIFY_DESCRIPTION_PATTERN.test('checkout the branch')).toBe(false);
    // `evaluation` has no word boundary after `evaluate` (next char is 'i'),
    // so \b makes the match correctly fail. Same for `auditor`, `reviewer`.
    expect(VERIFY_DESCRIPTION_PATTERN.test('run the evaluation script')).toBe(false);
    expect(VERIFY_DESCRIPTION_PATTERN.test('the auditor speaks')).toBe(false);
    expect(VERIFY_DESCRIPTION_PATTERN.test('refactor the helper')).toBe(false);
  });
});

describe('selectVerifierForDelegation', () => {
  test('code parent + verify description → returns canonical verifier', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        { description: 'review the implementation', parentTaskType: 'code', parentAgentId: 'developer' },
        reg,
      );
      expect(result).toBe('reviewer');
    } finally {
      cleanup();
    }
  });

  test('non-code parent → returns null', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        { description: 'review the essay', parentTaskType: 'reasoning', parentAgentId: 'author' },
        reg,
      );
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('non-verify description → returns null', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        { description: 'extract a helper function', parentTaskType: 'code', parentAgentId: 'developer' },
        reg,
      );
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('parent already running as verifier → returns null (no self-route)', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        { description: 'audit the patch', parentTaskType: 'code', parentAgentId: 'reviewer' },
        reg,
      );
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('undefined parentTaskType → returns null (legacy parents)', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        { description: 'verify changes', parentTaskType: undefined, parentAgentId: undefined },
        reg,
      );
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('parent without agentId + code + verify → still returns verifier', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        { description: 'audit code', parentTaskType: 'code', parentAgentId: undefined },
        reg,
      );
      expect(result).toBe('reviewer');
    } finally {
      cleanup();
    }
  });

  test('Phase-15 Item 3: code-reasoning parentTaskDomain suppresses override', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      // verify verb + code parentTaskType would normally route to reviewer,
      // but read-only code-reasoning produces no artifact → skip override.
      const result = selectVerifierForDelegation(
        {
          description: 'review the implementation',
          parentTaskType: 'code',
          parentAgentId: 'developer',
          parentTaskDomain: 'code-reasoning',
        },
        reg,
      );
      expect(result).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('Phase-15 Item 3: code-mutation parentTaskDomain keeps override firing', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        {
          description: 'review the patch',
          parentTaskType: 'code',
          parentAgentId: 'developer',
          parentTaskDomain: 'code-mutation',
        },
        reg,
      );
      expect(result).toBe('reviewer');
    } finally {
      cleanup();
    }
  });

  test('Phase-15 Item 3: undefined parentTaskDomain preserves Phase-14 behaviour', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      const result = selectVerifierForDelegation(
        {
          description: 'audit',
          parentTaskType: 'code',
          parentAgentId: 'developer',
          // no parentTaskDomain — falls through to Phase-14 gate.
        },
        reg,
      );
      expect(result).toBe('reviewer');
    } finally {
      cleanup();
    }
  });

  test('Phase-15 Item 3: general-reasoning parentTaskDomain does not suppress (only code-reasoning does)', () => {
    const { reg, cleanup } = makeRegistry();
    try {
      // Defensive: if a non-code-reasoning domain reaches the router on a
      // code parentTaskType, the gate is permissive — only `code-reasoning`
      // is whitelisted as the no-artifact case.
      const result = selectVerifierForDelegation(
        {
          description: 'verify',
          parentTaskType: 'code',
          parentAgentId: 'developer',
          parentTaskDomain: 'general-reasoning',
        },
        reg,
      );
      expect(result).toBe('reviewer');
    } finally {
      cleanup();
    }
  });
});

/**
 * R4 — CapabilityToken behavior + checkCapability runtime gate.
 *
 * Verifies:
 *   - issueCapabilityToken populates id/expiresAt deterministically
 *   - explore/plan tokens have every mutation tool forbidden by default
 *   - general-purpose token forbids shell_exec + delegate_task by default
 *   - checkCapability rejects forbidden tools, expired tokens, out-of-scope paths
 *   - undefined token = pass-through (legacy compatibility)
 */
import { describe, expect, test } from 'bun:test';
import {
  checkCapability,
  issueCapabilityToken,
  MUTATION_TOOL_NAMES,
  READONLY_FALLBACK_TOKEN,
} from '../../src/core/capability-token.ts';

const FIXED_NOW = 1_700_000_000_000;

describe('issueCapabilityToken', () => {
  test('explore token forbids every mutation tool', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'parent-1',
      subagentType: 'explore',
      allowedTools: [],
      issuedBy: 'delegation-router',
      now: FIXED_NOW,
    });
    for (const tool of MUTATION_TOOL_NAMES) {
      expect(t.forbiddenTools).toContain(tool);
    }
    expect(t.expiresAt).toBeGreaterThan(FIXED_NOW);
    expect(t.id).toContain('capability-token:');
  });

  test('plan token also forbids every mutation tool', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'parent-2',
      subagentType: 'plan',
      allowedTools: [],
      issuedBy: 'delegation-router',
      now: FIXED_NOW,
    });
    for (const tool of MUTATION_TOOL_NAMES) {
      expect(t.forbiddenTools).toContain(tool);
    }
  });

  test('general-purpose token forbids shell_exec + delegate_task by default', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'parent-3',
      subagentType: 'general-purpose',
      allowedTools: [],
      issuedBy: 'delegation-router',
      now: FIXED_NOW,
    });
    expect(t.forbiddenTools).toContain('shell_exec');
    expect(t.forbiddenTools).toContain('delegate_task');
    // file_write is NOT forbidden by default for general-purpose.
    expect(t.forbiddenTools).not.toContain('file_write');
  });

  test('explicit forbiddenTools merge with defaults', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'parent-4',
      subagentType: 'general-purpose',
      allowedTools: [],
      forbiddenTools: ['file_write'],
      issuedBy: 'router',
      now: FIXED_NOW,
    });
    expect(t.forbiddenTools).toContain('shell_exec'); // default
    expect(t.forbiddenTools).toContain('file_write'); // explicit
  });
});

describe('checkCapability', () => {
  test('undefined token is a pass-through (legacy)', () => {
    const r = checkCapability({ token: undefined, toolName: 'file_write' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tokenId).toBeNull();
  });

  test('explore token rejects file_write with reason "tool_forbidden"', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'p',
      subagentType: 'explore',
      allowedTools: [],
      issuedBy: 'r',
      now: FIXED_NOW,
    });
    const r = checkCapability({ token: t, toolName: 'file_write', now: FIXED_NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('tool_forbidden');
      expect(r.detail).toContain('explore');
    }
  });

  test('explore token allows file_read (not in mutation set)', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'p',
      subagentType: 'explore',
      allowedTools: [],
      issuedBy: 'r',
      now: FIXED_NOW,
    });
    const r = checkCapability({ token: t, toolName: 'file_read', now: FIXED_NOW });
    expect(r.ok).toBe(true);
  });

  test('expired token is rejected with reason "token_expired"', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'p',
      subagentType: 'general-purpose',
      allowedTools: [],
      issuedBy: 'r',
      ttlMs: 1_000,
      now: FIXED_NOW,
    });
    const r = checkCapability({
      token: t,
      toolName: 'file_read',
      now: FIXED_NOW + 5_000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('token_expired');
  });

  test('path scoping — file_write rejected when path is outside allowedPaths', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'p',
      subagentType: 'general-purpose',
      allowedTools: ['file_write'],
      allowedPaths: ['src/foo/'],
      issuedBy: 'r',
      now: FIXED_NOW,
    });
    const r = checkCapability({
      token: t,
      toolName: 'file_write',
      targetPath: 'src/bar/baz.ts',
      now: FIXED_NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('path_out_of_scope');
  });

  test('path scoping — file_write inside allowedPaths is OK', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'p',
      subagentType: 'general-purpose',
      allowedTools: ['file_write'],
      allowedPaths: ['src/foo/'],
      issuedBy: 'r',
      now: FIXED_NOW,
    });
    const r = checkCapability({
      token: t,
      toolName: 'file_write',
      targetPath: 'src/foo/bar.ts',
      now: FIXED_NOW,
    });
    expect(r.ok).toBe(true);
  });

  test('non-empty allowedTools rejects tools not in the list', () => {
    const t = issueCapabilityToken({
      parentTaskId: 'p',
      subagentType: 'general-purpose',
      allowedTools: ['file_read', 'search_grep'],
      issuedBy: 'r',
      now: FIXED_NOW,
    });
    const r = checkCapability({ token: t, toolName: 'file_write', now: FIXED_NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tool_not_allowed');
  });

  test('READONLY_FALLBACK_TOKEN forbids every mutation tool', () => {
    for (const tool of MUTATION_TOOL_NAMES) {
      const r = checkCapability({ token: READONLY_FALLBACK_TOKEN, toolName: tool });
      expect(r.ok).toBe(false);
    }
  });
});

/**
 * Phase-13 — registry A1 helpers (`findCanonicalVerifier`, `assertA1Pair`).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'vinyan-a1-'));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

describe('AgentRegistry.findCanonicalVerifier', () => {
  test('returns the built-in reviewer by default', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      const ver = reg.findCanonicalVerifier();
      expect(ver).not.toBeNull();
      expect(ver!.id).toBe('reviewer');
      expect(ver!.role).toBe('reviewer');
    } finally {
      cleanup();
    }
  });

  test('returns role-matched persona when user-config replaces id', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, [
        {
          id: 'my-reviewer',
          name: 'Custom Reviewer',
          description: 'A user-authored verifier',
          role: 'reviewer',
        },
      ]);
      const ver = reg.findCanonicalVerifier();
      expect(ver).not.toBeNull();
      // Built-in `reviewer` is registered before any config personas, so it
      // wins by registration order. The custom one is also registered but
      // loses the iteration race — both are valid verifiers per role.
      expect(ver!.role).toBe('reviewer');
    } finally {
      cleanup();
    }
  });
});

describe('AgentRegistry.assertA1Pair', () => {
  test('developer + reviewer → ok', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      expect(reg.assertA1Pair('developer', 'reviewer').ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('developer + architect → fail (Generator + Generator)', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      const r = reg.assertA1Pair('developer', 'architect');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('A1 violation');
    } finally {
      cleanup();
    }
  });

  test('developer + developer → fail (same persona)', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      const r = reg.assertA1Pair('developer', 'developer');
      expect(r.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('unknown ids → fail', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      expect(reg.assertA1Pair('nonexistent', 'reviewer').ok).toBe(false);
      expect(reg.assertA1Pair('developer', 'nonexistent').ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('coordinator + reviewer → ok (mixed + verifier)', () => {
    const { ws, cleanup } = makeWs();
    try {
      const reg = loadAgentRegistry(ws, undefined);
      expect(reg.assertA1Pair('coordinator', 'reviewer').ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});

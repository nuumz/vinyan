/**
 * R4 — ToolExecutor enforces capability tokens at runtime.
 *
 * Verifies the integration: when ToolContext carries a CapabilityToken
 * issued for an explore/plan subagent, the executor REJECTS mutation
 * tools with status='denied' and a "capability_token: ..." error,
 * BEFORE the tool's own validator runs.
 */
import { describe, expect, test } from 'bun:test';
import { issueCapabilityToken } from '../../../src/core/capability-token.ts';
import type { ToolCall } from '../../../src/orchestrator/types.ts';
import { ToolExecutor } from '../../../src/orchestrator/tools/tool-executor.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

function baseContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    routingLevel: 1 as const,
    allowedPaths: ['src/'],
    workspace: '/tmp/workspace',
    ...overrides,
  } as ToolContext;
}

describe('R4 ToolExecutor — capability token enforcement', () => {
  test('explore token denies file_write with capability_token error', async () => {
    const exec = new ToolExecutor();
    const token = issueCapabilityToken({
      parentTaskId: 'parent-1',
      subagentType: 'explore',
      allowedTools: [],
      issuedBy: 'delegation-router',
    });
    const calls: ToolCall[] = [
      {
        id: 'c1',
        tool: 'file_write',
        parameters: { path: 'src/foo.ts', content: 'export const x = 1;' },
      },
    ];
    const results = await exec.executeProposedTools(calls, baseContext({ capabilityToken: token }));
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe('denied');
    expect(results[0]?.error).toContain('capability_token');
    expect(results[0]?.error).toContain('tool_forbidden');
  });

  test('no token = pass-through (legacy behavior preserved)', async () => {
    const exec = new ToolExecutor();
    const calls: ToolCall[] = [
      {
        id: 'c1',
        tool: 'file_read',
        parameters: { path: 'src/foo.ts' },
      },
    ];
    const results = await exec.executeProposedTools(calls, baseContext());
    expect(results.length).toBe(1);
    // file_read either succeeds or fails for some unrelated reason
    // (e.g., file doesn't exist), but it does NOT carry a
    // capability_token error.
    expect(results[0]?.error ?? '').not.toContain('capability_token');
  });

  test('expired token denies any tool', async () => {
    const exec = new ToolExecutor();
    const token = issueCapabilityToken({
      parentTaskId: 'parent',
      subagentType: 'general-purpose',
      allowedTools: [],
      ttlMs: 1,
      issuedBy: 'router',
      now: Date.now() - 10_000, // already expired
    });
    const calls: ToolCall[] = [
      { id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } },
    ];
    const results = await exec.executeProposedTools(calls, baseContext({ capabilityToken: token }));
    expect(results[0]?.status).toBe('denied');
    expect(results[0]?.error).toContain('token_expired');
  });
});

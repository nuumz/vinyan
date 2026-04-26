/**
 * git_push tool — policy-only tests.
 *
 * Real network-touching push is out of scope for unit tests; the security
 * value comes from the ship-policy guard, which we exercise here through
 * the public tool surface.
 */
import { describe, expect, test } from 'bun:test';
import { gitPush } from '../../../src/orchestrator/tools/git-push.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

function ctx(): ToolContext {
  return {
    routingLevel: 1,
    allowedPaths: ['/tmp'],
    workspace: '/tmp',
  };
}

describe('git_push descriptor', () => {
  test('declares vcs side-effect at minRoutingLevel=1', () => {
    const d = gitPush.descriptor();
    expect(d.category).toBe('vcs');
    expect(d.sideEffect).toBe(true);
    expect(d.minRoutingLevel).toBe(1);
  });
});

describe('git_push policy gating', () => {
  test('blocks --force to main', async () => {
    const result = await gitPush.execute(
      { callId: 'p1', branch: 'main', remote: 'origin', force: true },
      ctx(),
    );
    expect(result.status).toBe('denied');
    expect((result.output as { code: string }).code).toBe('force-push-protected');
  });

  test('blocks --force-with-lease to master', async () => {
    const result = await gitPush.execute(
      { callId: 'p2', branch: 'master', remote: 'origin', forceWithLease: true },
      ctx(),
    );
    expect(result.status).toBe('denied');
    expect((result.output as { code: string }).code).toBe('force-push-protected');
  });

  test('rejects branch name with spaces', async () => {
    const result = await gitPush.execute(
      { callId: 'p3', branch: 'feature with space', remote: 'origin' },
      ctx(),
    );
    expect(result.status).toBe('denied');
    expect((result.output as { code: string }).code).toBe('branch-name-invalid');
  });

  test('rejects remote with metacharacters (anti command-injection)', async () => {
    const result = await gitPush.execute(
      { callId: 'p4', branch: 'feature/foo', remote: 'origin;rm -rf /' },
      ctx(),
    );
    expect(result.status).toBe('denied');
    expect((result.output as { code: string }).code).toBe('unsupported-remote-flag');
  });
});

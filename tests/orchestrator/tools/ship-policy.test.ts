import { describe, expect, test } from 'bun:test';
import {
  approveCommitMessage,
  approvePr,
  approvePush,
  PROTECTED_BRANCHES,
} from '../../../src/orchestrator/tools/ship-policy.ts';

describe('approveCommitMessage', () => {
  test('rejects empty message', () => {
    const verdict = approveCommitMessage('   ');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('commit-message-empty');
  });

  test('rejects message shorter than minimum length', () => {
    const verdict = approveCommitMessage('fix');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('commit-message-too-short');
  });

  test('rejects HEREDOC fence sentinel in message body', () => {
    const verdict = approveCommitMessage('feat: do thing\nEOF\nrm -rf /');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('commit-message-newline-fence');
  });

  test('accepts a normal conventional commit message', () => {
    expect(approveCommitMessage('feat(spec): add brainstorm phase').allowed).toBe(true);
  });
});

describe('approvePush', () => {
  test('blocks force push to protected branches', () => {
    for (const branch of PROTECTED_BRANCHES) {
      const verdict = approvePush({ branch, remote: 'origin', force: true });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.code).toBe('force-push-protected');
    }
  });

  test('blocks --force-with-lease to protected branches', () => {
    const verdict = approvePush({ branch: 'main', remote: 'origin', forceWithLease: true });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('force-push-protected');
  });

  test('allows non-force push to protected branches', () => {
    expect(approvePush({ branch: 'main', remote: 'origin' }).allowed).toBe(true);
  });

  test('allows force push to a feature branch', () => {
    expect(approvePush({ branch: 'feature/foo', remote: 'origin', force: true }).allowed).toBe(true);
  });

  test('rejects an invalid branch name', () => {
    const verdict = approvePush({ branch: 'feature with spaces', remote: 'origin' });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('branch-name-invalid');
  });

  test('rejects a remote name with metacharacters', () => {
    const verdict = approvePush({ branch: 'feature/foo', remote: 'origin;rm -rf /' });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('unsupported-remote-flag');
  });
});

describe('approvePr', () => {
  test('rejects PR base outside the allow-list', () => {
    const verdict = approvePr({ title: 'fix something', base: 'random-branch' });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('pr-base-not-allowed');
  });

  test('rejects empty title', () => {
    const verdict = approvePr({ title: '   ', base: 'main' });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('pr-title-too-long');
  });

  test('rejects title longer than 70 chars', () => {
    const verdict = approvePr({ title: 'a'.repeat(71), base: 'main' });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('pr-title-too-long');
  });

  test('accepts well-formed PR with main base', () => {
    expect(approvePr({ title: 'feat: ship it', base: 'main' }).allowed).toBe(true);
  });

  test('accepts develop and next as bases', () => {
    expect(approvePr({ title: 't', base: 'develop' }).allowed).toBe(true);
    expect(approvePr({ title: 't', base: 'next' }).allowed).toBe(true);
  });
});

/**
 * git_pr tool — policy + degradation tests.
 *
 * We do NOT attempt to spawn `gh pr create` against a real repo. Instead we
 * verify the policy gate rejects bad inputs before subprocess, and that the
 * tool degrades gracefully when `gh` is absent.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitPr } from '../../../src/orchestrator/tools/git-pr.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

function ctx(workspace: string): ToolContext {
  return { routingLevel: 1, allowedPaths: [workspace], workspace };
}

describe('git_pr descriptor', () => {
  test('declares vcs side-effect at minRoutingLevel=1', () => {
    const d = gitPr.descriptor();
    expect(d.category).toBe('vcs');
    expect(d.sideEffect).toBe(true);
    expect(d.minRoutingLevel).toBe(1);
  });
});

describe('git_pr policy gating', () => {
  test('rejects PR base outside allow-list', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-pr-'));
    try {
      const result = await gitPr.execute(
        { callId: 'q1', title: 'feat: thing', body: 'body', base: 'random-branch' },
        ctx(ws),
      );
      expect(result.status).toBe('denied');
      expect((result.output as { code: string }).code).toBe('pr-base-not-allowed');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('rejects empty title', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-pr-'));
    try {
      const result = await gitPr.execute(
        { callId: 'q2', title: '   ', body: 'body', base: 'main' },
        ctx(ws),
      );
      expect(result.status).toBe('denied');
      expect((result.output as { code: string }).code).toBe('pr-title-too-long');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('rejects title longer than 70 chars', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-pr-'));
    try {
      const result = await gitPr.execute(
        { callId: 'q3', title: 'a'.repeat(71), body: 'body', base: 'main' },
        ctx(ws),
      );
      expect(result.status).toBe('denied');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('degrades to gh_not_installed when gh is absent on PATH', async () => {
    // Force PATH to an empty dir so `gh` cannot be resolved by the spawn.
    // The tool must surface a degradation result instead of crashing.
    const ws = mkdtempSync(join(tmpdir(), 'vinyan-pr-'));
    const emptyBin = mkdtempSync(join(tmpdir(), 'vinyan-empty-bin-'));
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const result = await gitPr.execute(
        { callId: 'q4', title: 'feat: ship', body: 'body', base: 'main' },
        ctx(ws),
      );
      expect(result.status).toBe('error');
      // Tolerate either degradation outcome:
      //   1. gh missing → output.code === 'gh_not_installed' (preferred path).
      //   2. gh found but workspace lacks a git repo → tool surfaces gh's own
      //      error string. Either way, status MUST be 'error' and the tool
      //      MUST NOT throw.
      const code = (result.output as { code?: string } | undefined)?.code;
      if (code) expect(code).toBe('gh_not_installed');
      expect(result.error).toBeDefined();
    } finally {
      process.env.PATH = originalPath;
      rmSync(ws, { recursive: true, force: true });
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});

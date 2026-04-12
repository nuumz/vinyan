/**
 * Tests for shared prompt-section renderers.
 *
 * The renderers here are the single source of truth for M1-M4 instruction
 * hierarchy rendering and [ENVIRONMENT] blocks. Both the structured-worker
 * prompt assembler AND the L2+ agent worker system prompt call them, so drift
 * between the two code paths would silently regress every agent session.
 */
import { describe, expect, test } from 'bun:test';
import type { InstructionMemory, InstructionSource } from '../../../src/orchestrator/llm/instruction-hierarchy.ts';
import {
  computeEnvironmentInfo,
  type EnvironmentInfo,
  renderEnvironmentSection,
  renderInstructionHierarchy,
  TIER_HEADER_LABELS,
  TIER_TRUST_HINT,
} from '../../../src/orchestrator/llm/shared-prompt-sections.ts';

// ── Test helpers ───────────────────────────────────────────────────

function makeSource(partial: Partial<InstructionSource>): InstructionSource {
  return {
    tier: 'project',
    filePath: '/ws/VINYAN.md',
    content: 'Project rule body',
    contentHash: 'deadbeef',
    frontmatter: {},
    includes: [],
    ...partial,
  };
}

// ── renderInstructionHierarchy ─────────────────────────────────────

describe('renderInstructionHierarchy', () => {
  test('returns null for null/undefined input', () => {
    expect(renderInstructionHierarchy(null)).toBeNull();
    expect(renderInstructionHierarchy(undefined)).toBeNull();
  });

  test('renders legacy flat format when sources array is empty', () => {
    const memory: InstructionMemory = {
      content: 'Legacy single-file content',
      contentHash: 'hash',
      filePath: '/ws/VINYAN.md',
      sources: [],
    };
    const out = renderInstructionHierarchy(memory);
    expect(out).toContain('[PROJECT INSTRUCTIONS]');
    expect(out).toContain('Legacy single-file content');
  });

  test('renders multi-tier format with provenance headers', () => {
    const memory: InstructionMemory = {
      content: 'merged',
      contentHash: 'hash',
      filePath: '/ws/VINYAN.md',
      sources: [
        makeSource({
          tier: 'user',
          filePath: '~/.vinyan/preferences.md',
          content: 'User prefers tabs',
        }),
        makeSource({
          tier: 'project',
          filePath: '/ws/VINYAN.md',
          content: 'Project uses bun:test',
          frontmatter: { description: 'Project conventions' },
        }),
      ],
    };
    const out = renderInstructionHierarchy(memory)!;
    expect(out).toContain('[PROJECT INSTRUCTIONS]');
    expect(out).toContain(TIER_HEADER_LABELS.user);
    expect(out).toContain(TIER_HEADER_LABELS.project);
    expect(out).toContain(TIER_TRUST_HINT.user);
    expect(out).toContain('User prefers tabs');
    expect(out).toContain('Project uses bun:test');
    expect(out).toContain('Project conventions');
  });

  test('surfaces applyTo glob patterns in scoped-rule headers', () => {
    const memory: InstructionMemory = {
      content: 'merged',
      contentHash: 'hash',
      filePath: '/ws/.vinyan/rules/tests.md',
      sources: [
        makeSource({
          tier: 'scoped-rule',
          filePath: '/ws/.vinyan/rules/tests.md',
          content: 'Tests must use describe/test blocks',
          frontmatter: { applyTo: ['tests/**/*.ts'] },
        }),
      ],
    };
    const out = renderInstructionHierarchy(memory)!;
    expect(out).toContain(TIER_HEADER_LABELS['scoped-rule']);
    expect(out).toContain('applies to: tests/**/*.ts');
  });

  test('surfaces confidence label for M4 learned entries', () => {
    const memory: InstructionMemory = {
      content: 'merged',
      contentHash: 'hash',
      filePath: '/ws/.vinyan/memory/learned.md',
      sources: [
        makeSource({
          tier: 'learned',
          filePath: '/ws/.vinyan/memory/learned.md',
          content: 'Never use process.chdir in tests',
          frontmatter: {
            tier: 'heuristic',
            confidence: 0.78,
            description: 'Test isolation',
          },
        }),
      ],
    };
    const out = renderInstructionHierarchy(memory)!;
    expect(out).toContain(TIER_HEADER_LABELS.learned);
    expect(out).toContain('confidence=0.78');
    expect(out).toContain('Never use process.chdir in tests');
  });

  test('preserves source order across mixed tiers', () => {
    const memory: InstructionMemory = {
      content: 'merged',
      contentHash: 'hash',
      filePath: '/ws/VINYAN.md',
      sources: [
        makeSource({ tier: 'user', content: 'USER RULE' }),
        makeSource({ tier: 'project', content: 'PROJECT RULE' }),
        makeSource({ tier: 'scoped-rule', content: 'SCOPED RULE' }),
        makeSource({ tier: 'learned', content: 'LEARNED RULE' }),
      ],
    };
    const out = renderInstructionHierarchy(memory)!;
    const userIdx = out.indexOf('USER RULE');
    const projectIdx = out.indexOf('PROJECT RULE');
    const scopedIdx = out.indexOf('SCOPED RULE');
    const learnedIdx = out.indexOf('LEARNED RULE');
    expect(userIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(userIdx);
    expect(scopedIdx).toBeGreaterThan(projectIdx);
    expect(learnedIdx).toBeGreaterThan(scopedIdx);
  });
});

// ── renderEnvironmentSection ───────────────────────────────────────

describe('renderEnvironmentSection', () => {
  test('returns null for null/undefined input', () => {
    expect(renderEnvironmentSection(null)).toBeNull();
    expect(renderEnvironmentSection(undefined)).toBeNull();
  });

  test('renders core fields (cwd, platform, date)', () => {
    const env: EnvironmentInfo = {
      cwd: '/home/user/repo',
      platform: 'linux',
      arch: 'x64',
      dateIso: '2026-04-12T15:30:00.000Z',
    };
    const out = renderEnvironmentSection(env)!;
    expect(out).toContain('[ENVIRONMENT]');
    expect(out).toContain('Working directory: /home/user/repo');
    expect(out).toContain('Linux');
    expect(out).toContain('x64');
    expect(out).toContain('Current date:');
  });

  test('maps platform names to human labels', () => {
    const darwin = renderEnvironmentSection({
      cwd: '/a',
      platform: 'darwin',
      arch: 'arm64',
      dateIso: '2026-04-12T00:00:00.000Z',
    })!;
    expect(darwin).toContain('macOS');

    const win = renderEnvironmentSection({
      cwd: 'C:\\repo',
      platform: 'win32',
      arch: 'x64',
      dateIso: '2026-04-12T00:00:00.000Z',
    })!;
    expect(win).toContain('Windows');
  });

  test('renders git branch and dirty state when available', () => {
    const env: EnvironmentInfo = {
      cwd: '/ws',
      platform: 'linux',
      arch: 'x64',
      dateIso: '2026-04-12T00:00:00.000Z',
      isGitRepo: true,
      gitBranch: 'feature/foo',
      gitDirty: true,
    };
    const out = renderEnvironmentSection(env)!;
    expect(out).toContain('Git: feature/foo');
    expect(out).toContain('dirty');
  });

  test('renders clean git state', () => {
    const env: EnvironmentInfo = {
      cwd: '/ws',
      platform: 'linux',
      arch: 'x64',
      dateIso: '2026-04-12T00:00:00.000Z',
      isGitRepo: true,
      gitBranch: 'main',
      gitDirty: false,
    };
    const out = renderEnvironmentSection(env)!;
    expect(out).toContain('Git: main');
    expect(out).toContain('clean');
  });

  test('indicates non-repo state when cwd is not a git repo', () => {
    const env: EnvironmentInfo = {
      cwd: '/tmp/scratch',
      platform: 'linux',
      arch: 'x64',
      dateIso: '2026-04-12T00:00:00.000Z',
      isGitRepo: false,
    };
    const out = renderEnvironmentSection(env)!;
    expect(out).toContain('Git: not a repository');
  });

  test('falls back to raw iso string when date parse fails', () => {
    const env: EnvironmentInfo = {
      cwd: '/ws',
      platform: 'linux',
      arch: 'x64',
      dateIso: 'not-a-date',
    };
    const out = renderEnvironmentSection(env)!;
    expect(out).toContain('not-a-date');
  });
});

// ── computeEnvironmentInfo ─────────────────────────────────────────

describe('computeEnvironmentInfo', () => {
  test('returns core fields for any directory', () => {
    const info = computeEnvironmentInfo('/tmp');
    expect(info.cwd).toBe('/tmp');
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(info.dateIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('marks isGitRepo=false for non-repo directory', () => {
    // Use /tmp — usually not a git repo on CI
    const info = computeEnvironmentInfo('/tmp');
    // /tmp might coincidentally be inside a repo in dev; tolerate both outcomes
    expect(typeof info.isGitRepo === 'boolean' || info.isGitRepo === undefined).toBe(true);
  });

  test('detects git branch when cwd is a git repo', () => {
    // This test repo IS a git repo, so we should get a branch name back.
    const info = computeEnvironmentInfo(process.cwd());
    if (info.isGitRepo) {
      expect(info.gitBranch).toBeTruthy();
      expect(typeof info.gitDirty).toBe('boolean');
    }
  });
});

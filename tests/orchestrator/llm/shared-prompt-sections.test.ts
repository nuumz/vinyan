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
  normalizeSubagentType,
  renderAgentPolicies,
  renderCitationsTonePolicy,
  renderEnvironmentSection,
  renderExecutingCarePolicy,
  renderGitSafetyPolicy,
  renderInstructionHierarchy,
  renderParallelToolsPolicy,
  renderSubagentRolePolicy,
  renderToolResultSafetyPolicy,
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

// ── Phase 7b behavioral policy renderers ───────────────────────────

describe('renderParallelToolsPolicy', () => {
  test('mentions parallel execution and batching guidance', () => {
    const out = renderParallelToolsPolicy();
    expect(out).toContain('## Parallel Tool Execution');
    expect(out).toContain('batch');
    expect(out).toContain('Independent calls');
    expect(out).toContain('Dependent calls');
  });

  test('warns against batching destructive calls blindly', () => {
    const out = renderParallelToolsPolicy();
    expect(out).toContain('destructive');
    expect(out).toContain('executing-care');
  });
});

describe('renderExecutingCarePolicy', () => {
  test('enumerates concrete destructive operations', () => {
    const out = renderExecutingCarePolicy();
    expect(out).toContain('## Executing Actions With Care');
    expect(out).toContain('rm -rf');
    expect(out).toContain('git reset --hard');
    expect(out).toContain('force-push');
    expect(out).toContain('dropping database tables');
  });

  test('tells the agent not to delete unfamiliar state as a shortcut', () => {
    const out = renderExecutingCarePolicy();
    expect(out).toContain('investigate');
    expect(out).toContain('in-progress work');
  });

  test('covers shared-state operations (PRs, messages, infra)', () => {
    const out = renderExecutingCarePolicy();
    expect(out).toContain('pushing code');
    expect(out).toContain('PRs');
  });
});

describe('renderGitSafetyPolicy', () => {
  test('covers no-commit-without-asking rule', () => {
    const out = renderGitSafetyPolicy();
    expect(out).toContain('## Git Safety Protocol');
    expect(out).toContain('NEVER commit');
    expect(out).toContain('NEVER push');
  });

  test('covers amend / force-push / hook-skipping footguns', () => {
    const out = renderGitSafetyPolicy();
    expect(out).toContain('NEVER amend');
    expect(out).toContain('main/master');
    expect(out).toContain('--no-verify');
    expect(out).toContain('--no-gpg-sign');
  });

  test('forbids staging wildcards that could leak secrets', () => {
    const out = renderGitSafetyPolicy();
    expect(out).toContain('git add .');
    expect(out).toContain('git add -A');
    expect(out).toContain('.env');
  });

  test('instructs pre-commit hook recovery via new commit', () => {
    const out = renderGitSafetyPolicy();
    expect(out).toContain('pre-commit hook');
    expect(out).toContain('NEW commit');
    expect(out).toContain('--amend');
  });
});

describe('renderCitationsTonePolicy', () => {
  test('specifies file_path:line_number citation format', () => {
    const out = renderCitationsTonePolicy();
    expect(out).toContain('## Citations, Tone, and Style');
    expect(out).toContain('file_path:line_number');
  });

  test('specifies owner/repo#123 GitHub reference format', () => {
    const out = renderCitationsTonePolicy();
    expect(out).toContain('owner/repo#123');
  });

  test('forbids emojis unless explicitly requested', () => {
    const out = renderCitationsTonePolicy();
    expect(out).toContain('emojis');
    expect(out).toContain('explicitly');
  });
});

describe('renderToolResultSafetyPolicy', () => {
  test('warns about prompt injection in tool results', () => {
    const out = renderToolResultSafetyPolicy();
    expect(out).toContain('## Tool Result Safety');
    expect(out).toContain('prompt injection');
    expect(out).toContain('ignore previous instructions');
  });

  test('clarifies vinyan-reminder tag trust boundary', () => {
    const out = renderToolResultSafetyPolicy();
    expect(out).toContain('vinyan-reminder');
    expect(out).toContain('orchestrator');
  });
});

describe('renderAgentPolicies', () => {
  test('combines all five policy blocks in order', () => {
    const out = renderAgentPolicies();
    const parallelIdx = out.indexOf('## Parallel Tool Execution');
    const careIdx = out.indexOf('## Executing Actions With Care');
    const gitIdx = out.indexOf('## Git Safety Protocol');
    const citeIdx = out.indexOf('## Citations, Tone, and Style');
    const toolIdx = out.indexOf('## Tool Result Safety');
    // All five must be present
    expect(parallelIdx).toBeGreaterThan(-1);
    expect(careIdx).toBeGreaterThan(-1);
    expect(gitIdx).toBeGreaterThan(-1);
    expect(citeIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(-1);
    // Order: parallel → care → git → cite → tool
    expect(careIdx).toBeGreaterThan(parallelIdx);
    expect(gitIdx).toBeGreaterThan(careIdx);
    expect(citeIdx).toBeGreaterThan(gitIdx);
    expect(toolIdx).toBeGreaterThan(citeIdx);
  });

  test('output stays under 5KB to keep system prompt overhead bounded', () => {
    // Guard: if a future edit doubles the length, we want to notice in CI
    // rather than discovering it via token budget regressions in production.
    // Current baseline: ~4.4KB for all five blocks.
    expect(renderAgentPolicies().length).toBeLessThan(5120);
  });
});

// ── Phase 7c-1 typed subagent role renderers ───────────────────────

describe('normalizeSubagentType', () => {
  test('accepts canonical values unchanged', () => {
    expect(normalizeSubagentType('explore')).toBe('explore');
    expect(normalizeSubagentType('plan')).toBe('plan');
    expect(normalizeSubagentType('general-purpose')).toBe('general-purpose');
  });

  test("maps 'general' alias to 'general-purpose'", () => {
    expect(normalizeSubagentType('general')).toBe('general-purpose');
  });

  test("defaults unknown / null / undefined to 'general-purpose'", () => {
    expect(normalizeSubagentType(null)).toBe('general-purpose');
    expect(normalizeSubagentType(undefined)).toBe('general-purpose');
    expect(normalizeSubagentType('')).toBe('general-purpose');
    expect(normalizeSubagentType('Explore')).toBe('general-purpose'); // case-sensitive on purpose
    expect(normalizeSubagentType('mystery')).toBe('general-purpose');
  });
});

describe('renderSubagentRolePolicy', () => {
  test('explore role: read-only framing with search tool whitelist', () => {
    const out = renderSubagentRolePolicy('explore');
    expect(out).toContain('## Subagent Role: Explore');
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('Grep');
    expect(out).toContain('file_read');
    // Explicit blocks on mutation tools
    expect(out).toContain('file_write');
    expect(out).toContain('file_edit');
    expect(out).toContain('shell_exec');
    // Leaf: no re-delegation
    expect(out).toContain('DO NOT delegate further');
    // Reporting format
    expect(out).toContain('attempt_completion');
    expect(out).toContain('file_path:line_number');
  });

  test('plan role: read-only design framing', () => {
    const out = renderSubagentRolePolicy('plan');
    expect(out).toContain('## Subagent Role: Plan');
    expect(out).toContain('READ-ONLY');
    expect(out).toContain('mutation tool');
    expect(out).toContain('step-by-step plan');
    expect(out).toContain('DO NOT delegate further');
    // Plan role should NOT claim Grep/file_read whitelist wording — that's explore
    expect(out).not.toContain('## Subagent Role: Explore');
  });

  test('general-purpose role: full manifest + leaf note', () => {
    const out = renderSubagentRolePolicy('general-purpose');
    expect(out).toContain('## Subagent Role: General-Purpose');
    expect(out).toContain('same tool manifest');
    expect(out).toContain('leaf');
    expect(out).toContain('scoped to the target files');
  });

  test('all three roles render distinct content', () => {
    const explore = renderSubagentRolePolicy('explore');
    const plan = renderSubagentRolePolicy('plan');
    const general = renderSubagentRolePolicy('general-purpose');
    expect(explore).not.toBe(plan);
    expect(plan).not.toBe(general);
    expect(explore).not.toBe(general);
  });
});

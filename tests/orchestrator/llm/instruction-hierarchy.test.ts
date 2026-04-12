/**
 * Tests for the multi-tier instruction hierarchy.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearInstructionHierarchyCache,
  matchesGlob,
  parseFrontmatter,
  resolveInstructions,
} from '../../../src/orchestrator/llm/instruction-hierarchy.ts';
import {
  approveProposal,
  LEARNED_FILE_REL,
  type MemoryProposal,
  writeProposal,
} from '../../../src/orchestrator/memory/memory-proposals.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function makeTempWorkspace(name: string): string {
  const dir = join(tmpdir(), `vinyan-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupWorkspace(dir: string): void {
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── Frontmatter parsing ──────────────────────────────────────────────

describe('parseFrontmatter', () => {
  test('returns empty frontmatter for content without delimiter', () => {
    const { frontmatter, body } = parseFrontmatter('just a regular markdown file');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just a regular markdown file');
  });

  test('parses simple key:value pairs', () => {
    const content = `---
priority: 10
description: "A test rule"
tier: heuristic
---
Body content`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.priority).toBe(10);
    expect(frontmatter.description).toBe('A test rule');
    expect(frontmatter.tier).toBe('heuristic');
    expect(body).toBe('Body content');
  });

  test('parses inline applyTo array', () => {
    const content = `---
applyTo: [src/api/**, "*.controller.ts"]
---
Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.applyTo).toEqual(['src/api/**', '*.controller.ts']);
  });

  test('parses multiline applyTo list', () => {
    const content = `---
applyTo:
  - "src/api/**"
  - "*.controller.ts"
  - lib/routes/**
priority: 20
---
Body`;
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.applyTo).toEqual(['src/api/**', '*.controller.ts', 'lib/routes/**']);
    expect(frontmatter.priority).toBe(20);
    expect(body).toBe('Body');
  });

  test('ignores invalid tier values', () => {
    const content = `---
tier: invalid
---
Body`;
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.tier).toBeUndefined();
  });
});

// ── Glob matching ────────────────────────────────────────────────────

describe('matchesGlob', () => {
  test('matches simple star', () => {
    expect(matchesGlob('foo.ts', '*.ts')).toBe(true);
    expect(matchesGlob('foo.js', '*.ts')).toBe(false);
  });

  test('matches directory double-star', () => {
    expect(matchesGlob('src/api/user.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('src/api/deep/nested/file.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('lib/foo.ts', 'src/**/*.ts')).toBe(false);
  });

  test('matches brace expansion', () => {
    expect(matchesGlob('foo.ts', '*.{ts,tsx}')).toBe(true);
    expect(matchesGlob('foo.tsx', '*.{ts,tsx}')).toBe(true);
    expect(matchesGlob('foo.js', '*.{ts,tsx}')).toBe(false);
  });

  test('normalizes path separators', () => {
    expect(matchesGlob('src\\api\\user.ts', 'src/**/*.ts')).toBe(true);
  });

  test('matches controller pattern', () => {
    expect(matchesGlob('src/api/user.controller.ts', '*.controller.ts')).toBe(false); // No star crossing /
    expect(matchesGlob('src/api/user.controller.ts', '**/*.controller.ts')).toBe(true);
  });
});

// ── Tier resolution ──────────────────────────────────────────────────

describe('resolveInstructions', () => {
  let workspace: string;

  beforeEach(() => {
    clearInstructionHierarchyCache();
    workspace = makeTempWorkspace('resolve');
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('returns null when no instruction sources exist', () => {
    const result = resolveInstructions({ workspace });
    expect(result).toBeNull();
  });

  test('loads project-level VINYAN.md', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Use semicolons in TypeScript.');
    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Use semicolons in TypeScript.');
    expect(result!.sources).toHaveLength(1);
    expect(result!.sources[0]!.tier).toBe('project');
  });

  test('loads scoped rules from .vinyan/rules/', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Base rule');
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'api.md'),
      `---
applyTo:
  - "src/api/**"
description: "API conventions"
---
Use async/await in API handlers.`,
    );
    // Task targets a matching file
    const result = resolveInstructions({
      workspace,
      targetFiles: ['src/api/users.ts'],
    });
    expect(result).not.toBeNull();
    expect(result!.sources.length).toBeGreaterThanOrEqual(2);
    const scopedRule = result!.sources.find((s) => s.tier === 'scoped-rule');
    expect(scopedRule).toBeDefined();
    expect(scopedRule!.content).toContain('Use async/await');
    expect(result!.content).toContain('API conventions');
  });

  test('filters out scoped rules that do not match target files', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'api.md'),
      `---
applyTo:
  - "src/api/**"
---
API rules`,
    );
    // Task targets a non-matching file
    const result = resolveInstructions({
      workspace,
      targetFiles: ['src/ui/button.tsx'],
    });
    // The scoped rule should NOT be loaded (applyTo doesn't match)
    expect(result).toBeNull();
  });

  test('tier precedence: scoped rules come after project', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project-level');
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'rules', 'r.md'), 'Scoped rule');

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const tiers = result!.sources.map((s) => s.tier);
    // project should come before scoped-rule in merge order
    expect(tiers.indexOf('project')).toBeLessThan(tiers.indexOf('scoped-rule'));
  });

  test('priority within tier orders correctly', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'high.md'),
      `---
priority: 90
---
High priority rule`,
    );
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'low.md'),
      `---
priority: 10
---
Low priority rule`,
    );

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const rules = result!.sources.filter((s) => s.tier === 'scoped-rule');
    expect(rules).toHaveLength(2);
    // Lower priority number sorted first (applied earlier)
    expect(rules[0]!.frontmatter.priority).toBe(10);
    expect(rules[1]!.frontmatter.priority).toBe(90);
  });

  test('expands @include directive', () => {
    writeFileSync(join(workspace, 'conventions.md'), '## Conventions\nAlways use const.');
    writeFileSync(
      join(workspace, 'VINYAN.md'),
      `# Project instructions

@./conventions.md

That's all.`,
    );

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const project = result!.sources.find((s) => s.tier === 'project');
    expect(project!.content).toContain('Always use const');
    expect(project!.includes.length).toBeGreaterThan(0);
  });

  test('detects circular @include references', () => {
    writeFileSync(join(workspace, 'a.md'), '@./b.md');
    writeFileSync(join(workspace, 'b.md'), '@./a.md\nB content');
    writeFileSync(join(workspace, 'VINYAN.md'), '@./a.md\nMain');

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const project = result!.sources.find((s) => s.tier === 'project')!;
    // Circular reference should be caught — comment inserted instead of infinite loop
    expect(project.content).toContain('circular reference');
  });

  test('handles missing @include gracefully', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), '@./nonexistent.md\nMain content');
    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const project = result!.sources.find((s) => s.tier === 'project')!;
    expect(project.content).toContain('file not found');
    expect(project.content).toContain('Main content');
  });

  test('applies tier precedence: learned conventions come last', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project');
    mkdirSync(join(workspace, '.vinyan', 'memory'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'memory', 'learned.md'), 'Learned');

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const tiers = result!.sources.map((s) => s.tier);
    expect(tiers.indexOf('project')).toBeLessThan(tiers.indexOf('learned'));
  });

  test('scoped rule with no applyTo is always active', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'rules', 'global.md'), 'Global rule');

    // No target files — global rule still applies
    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    expect(result!.sources.some((s) => s.tier === 'scoped-rule')).toBe(true);
  });

  test('caches resolved results by content hash', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Content A');
    const first = resolveInstructions({ workspace });
    const second = resolveInstructions({ workspace });
    expect(first).toBe(second); // Same object reference → cached
  });

  test('invalidates cache when source changes', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Content A');
    const first = resolveInstructions({ workspace });
    expect(first!.content).toContain('Content A');

    writeFileSync(join(workspace, 'VINYAN.md'), 'Content B');
    const second = resolveInstructions({ workspace });
    expect(second!.content).toContain('Content B');
    expect(first).not.toBe(second);
  });

  test('invalidates cache when a scoped rule file is deleted', () => {
    // Start with two scoped rules
    writeFileSync(join(workspace, 'VINYAN.md'), 'Base');
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'rules', 'keep.md'), 'Keep me');
    writeFileSync(join(workspace, '.vinyan', 'rules', 'drop.md'), 'Drop me');

    const first = resolveInstructions({ workspace });
    expect(first!.content).toContain('Keep me');
    expect(first!.content).toContain('Drop me');

    // Delete drop.md — cache MUST invalidate so it disappears from the merged output
    rmSync(join(workspace, '.vinyan', 'rules', 'drop.md'));
    const second = resolveInstructions({ workspace });
    expect(second!.content).toContain('Keep me');
    expect(second!.content).not.toContain('Drop me');
    expect(first).not.toBe(second);
  });

  test('invalidates cache when a new scoped rule file is added', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Base');
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'rules', 'one.md'), 'Rule one');

    const first = resolveInstructions({ workspace });
    expect(first!.content).toContain('Rule one');
    expect(first!.content).not.toContain('Rule two');

    // Add a new rule — cache MUST invalidate so it appears in the merged output
    writeFileSync(join(workspace, '.vinyan', 'rules', 'two.md'), 'Rule two');
    const second = resolveInstructions({ workspace });
    expect(second!.content).toContain('Rule one');
    expect(second!.content).toContain('Rule two');
    expect(first).not.toBe(second);
  });
});

describe('ecosystem hospitality', () => {
  let workspace: string;

  beforeEach(() => {
    clearInstructionHierarchyCache();
    workspace = makeTempWorkspace('ecosystem');
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('reads AGENTS.md as project source when VINYAN.md absent', () => {
    writeFileSync(join(workspace, 'AGENTS.md'), 'Agents-native project');
    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Agents-native project');
    expect(result!.sources.some((s) => s.filePath.endsWith('AGENTS.md'))).toBe(true);
  });

  test('reads CLAUDE.md as project source', () => {
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Claude Code project');
    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Claude Code project');
  });

  test('reads .github/copilot-instructions.md as project source', () => {
    mkdirSync(join(workspace, '.github'), { recursive: true });
    writeFileSync(join(workspace, '.github', 'copilot-instructions.md'), 'Copilot project');
    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Copilot project');
  });

  test('VINYAN.md takes precedence over ecosystem files when both present', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Vinyan native');
    writeFileSync(join(workspace, 'AGENTS.md'), 'Agents fallback');
    writeFileSync(join(workspace, 'CLAUDE.md'), 'Claude fallback');

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    // Both should be loaded, but VINYAN.md content appears first
    const vinyanIdx = result!.content.indexOf('Vinyan native');
    const agentsIdx = result!.content.indexOf('Agents fallback');
    expect(vinyanIdx).toBeGreaterThanOrEqual(0);
    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(vinyanIdx).toBeLessThan(agentsIdx);
  });

  test('reads .claude/rules and .github/instructions as scoped rule dirs', () => {
    mkdirSync(join(workspace, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'rules', 'claude-rule.md'), 'Claude rule');

    mkdirSync(join(workspace, '.github', 'instructions'), { recursive: true });
    writeFileSync(
      join(workspace, '.github', 'instructions', 'api.instructions.md'),
      `---
applyTo:
  - "src/api/**"
---
Copilot API rules`,
    );

    const result = resolveInstructions({
      workspace,
      targetFiles: ['src/api/user.ts'],
    });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Claude rule');
    expect(result!.content).toContain('Copilot API rules');
  });
});

describe('task-context filtering', () => {
  let workspace: string;

  beforeEach(() => {
    clearInstructionHierarchyCache();
    workspace = makeTempWorkspace('ctx-filter');
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  test('taskTypes filter excludes rule for wrong task type', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'code-only.md'),
      `---
taskTypes:
  - code
---
Code-only rule`,
    );

    const codeResult = resolveInstructions({ workspace, taskType: 'code' });
    expect(codeResult).not.toBeNull();
    expect(codeResult!.content).toContain('Code-only rule');

    const reasoningResult = resolveInstructions({ workspace, taskType: 'reasoning' });
    expect(reasoningResult).toBeNull();
  });

  test('applyToActions filter includes rule only for matching action', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'fix-only.md'),
      `---
applyToActions:
  - fix
  - debug
---
Debug/fix conventions`,
    );

    const fixResult = resolveInstructions({ workspace, actionVerb: 'fix' });
    expect(fixResult).not.toBeNull();
    expect(fixResult!.content).toContain('Debug/fix conventions');

    const addResult = resolveInstructions({ workspace, actionVerb: 'add' });
    expect(addResult).toBeNull();
  });

  test('excludeActions filter skips rule for excluded actions', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'not-for-refactor.md'),
      `---
excludeActions:
  - refactor
---
Not for refactoring`,
    );

    const refactorResult = resolveInstructions({ workspace, actionVerb: 'refactor' });
    expect(refactorResult).toBeNull();

    const fixResult = resolveInstructions({ workspace, actionVerb: 'fix' });
    expect(fixResult).not.toBeNull();
    expect(fixResult!.content).toContain('Not for refactoring');
  });
});

// ── Phase 4: structured M4 learned.md reader ────────────────────────

describe('learned.md structured reader (Phase 4)', () => {
  let workspace: string;

  beforeEach(() => {
    clearInstructionHierarchyCache();
    workspace = makeTempWorkspace('learned-entries');
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  /** Helper to write a single well-formed approved-entry block to learned.md. */
  function writeEntry(
    filename: string,
    opts: {
      slug: string;
      category?: string;
      tier?: string;
      confidence?: number;
      description: string;
      applyTo?: string[];
      body: string;
    },
  ): void {
    const {
      slug,
      category = 'convention',
      tier = 'heuristic',
      confidence = 0.85,
      description,
      applyTo = [],
      body,
    } = opts;
    const meta = `<!-- vinyan-memory-entry: slug=${slug}, category=${category}, tier=${tier}, confidence=${confidence}, proposedBy=worker, approvedBy=alice, approvedAt=2026-01-01T00:00:00.000Z -->`;
    const heading = `## ${slug} (${category})`;
    const applyToLine = applyTo.length ? `\n**Applies to**: ${applyTo.join(', ')}` : '';
    const block = `${meta}\n${heading}\n\n**Summary**: ${description}${applyToLine}\n\n${body}`;
    mkdirSync(join(workspace, '.vinyan', 'memory'), { recursive: true });
    const existing = existsSync(filename) ? readFileSync(filename, 'utf-8') : '';
    writeFileSync(filename, existing ? `${existing}\n\n${block}\n` : `${block}\n`);
  }

  test('hand-authored learned.md (no markers) still loads as a single source', () => {
    // Backwards-compat path: pre-Phase 4 format — one opaque instruction source
    // covering the whole file, no per-entry filtering.
    mkdirSync(join(workspace, '.vinyan', 'memory'), { recursive: true });
    writeFileSync(join(workspace, '.vinyan', 'memory', 'learned.md'), '# Hand-authored\n\nUse async/await everywhere.');

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const learned = result!.sources.filter((s) => s.tier === 'learned');
    expect(learned).toHaveLength(1);
    expect(learned[0]!.content).toContain('Use async/await everywhere.');
  });

  test('multi-entry learned.md emits one InstructionSource per approved rule', () => {
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    writeEntry(learnedPath, {
      slug: 'rule-alpha',
      description: 'Alpha convention.',
      body: 'Body for alpha.',
    });
    writeEntry(learnedPath, {
      slug: 'rule-beta',
      description: 'Beta convention.',
      body: 'Body for beta.',
    });
    writeEntry(learnedPath, {
      slug: 'rule-gamma',
      description: 'Gamma convention.',
      body: 'Body for gamma.',
    });

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const learned = result!.sources.filter((s) => s.tier === 'learned');
    expect(learned).toHaveLength(3);
    // Each source should carry its per-entry description in frontmatter so
    // buildSectionHeader can render it in the merged prompt.
    const descriptions = learned.map((s) => s.frontmatter.description);
    expect(descriptions).toEqual(['Alpha convention.', 'Beta convention.', 'Gamma convention.']);
  });

  test('per-entry applyTo filters each rule against target files independently', () => {
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    // Three rules: one API-only, one UI-only, one always-active (no applyTo).
    writeEntry(learnedPath, {
      slug: 'api-rule',
      description: 'API convention.',
      applyTo: ['src/api/**'],
      body: 'API bodies.',
    });
    writeEntry(learnedPath, {
      slug: 'ui-rule',
      description: 'UI convention.',
      applyTo: ['src/ui/**'],
      body: 'UI bodies.',
    });
    writeEntry(learnedPath, {
      slug: 'global-rule',
      description: 'Always active.',
      body: 'Global body.',
    });

    // Task targets an API file only. Expect: api-rule + global-rule kept,
    // ui-rule filtered out.
    const apiResult = resolveInstructions({
      workspace,
      targetFiles: ['src/api/users.ts'],
    });
    expect(apiResult).not.toBeNull();
    const apiLearnedSlugs = apiResult!.sources
      .filter((s) => s.tier === 'learned')
      .map((s) => s.frontmatter.description);
    expect(apiLearnedSlugs).toContain('API convention.');
    expect(apiLearnedSlugs).toContain('Always active.');
    expect(apiLearnedSlugs).not.toContain('UI convention.');

    clearInstructionHierarchyCache();

    // Task targets a UI file. Expect: ui-rule + global-rule kept, api-rule out.
    const uiResult = resolveInstructions({
      workspace,
      targetFiles: ['src/ui/button.tsx'],
    });
    expect(uiResult).not.toBeNull();
    const uiLearnedSlugs = uiResult!.sources.filter((s) => s.tier === 'learned').map((s) => s.frontmatter.description);
    expect(uiLearnedSlugs).toContain('UI convention.');
    expect(uiLearnedSlugs).toContain('Always active.');
    expect(uiLearnedSlugs).not.toContain('API convention.');
  });

  test('learned rule with applyTo is dropped when no target files supplied', () => {
    // Scoped learned rule requires target files to match — same behavior as
    // scoped M3 rules. Without targetFiles it must NOT appear.
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    writeEntry(learnedPath, {
      slug: 'scoped-only',
      description: 'Only for API.',
      applyTo: ['src/api/**'],
      body: 'API body.',
    });

    const result = resolveInstructions({ workspace });
    // No project source, no matching scoped learned rule → null.
    expect(result).toBeNull();
  });

  test('learned tier still comes after project/scoped tiers in merge order', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project instructions');
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    writeEntry(learnedPath, {
      slug: 'learned-rule',
      description: 'Learned rule.',
      body: 'Learned body.',
    });

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const tiers = result!.sources.map((s) => s.tier);
    expect(tiers.indexOf('project')).toBeLessThan(tiers.indexOf('learned'));
  });

  test('invalidates cache when a new approved entry is appended', () => {
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    writeEntry(learnedPath, {
      slug: 'first',
      description: 'First rule.',
      body: 'First body.',
    });

    const first = resolveInstructions({ workspace });
    expect(first!.sources.filter((s) => s.tier === 'learned')).toHaveLength(1);

    // Append another entry — the discovery fingerprint must change and the
    // cache must invalidate so the new entry appears in the next resolve.
    writeEntry(learnedPath, {
      slug: 'second',
      description: 'Second rule.',
      body: 'Second body.',
    });

    const second = resolveInstructions({ workspace });
    expect(second!.sources.filter((s) => s.tier === 'learned')).toHaveLength(2);
    expect(first).not.toBe(second);
  });

  test('per-entry tier flows into InstructionSource frontmatter', () => {
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    writeEntry(learnedPath, {
      slug: 'strong-rule',
      tier: 'deterministic',
      description: 'Strong rule.',
      body: 'Strong body.',
    });
    writeEntry(learnedPath, {
      slug: 'weak-rule',
      tier: 'probabilistic',
      description: 'Weak rule.',
      body: 'Weak body.',
    });

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    const learned = result!.sources.filter((s) => s.tier === 'learned');
    const tiers = learned.map((s) => s.frontmatter.tier);
    expect(tiers).toContain('deterministic');
    expect(tiers).toContain('probabilistic');
  });
});

// ── Phase 5: production hardening (weight labels + end-to-end) ──────

describe('learned.md section headers (Phase 5 weight labels)', () => {
  let workspace: string;

  beforeEach(() => {
    clearInstructionHierarchyCache();
    workspace = makeTempWorkspace('learned-weights');
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  /** Inline helper mirroring the Phase 4 block writer. */
  function writeEntry(opts: {
    slug: string;
    tier?: string;
    confidence?: number;
    description: string;
    body: string;
  }): void {
    const { slug, tier = 'heuristic', confidence = 0.85, description, body } = opts;
    const meta = `<!-- vinyan-memory-entry: slug=${slug}, category=convention, tier=${tier}, confidence=${confidence}, proposedBy=worker, approvedBy=alice, approvedAt=2026-01-01T00:00:00.000Z -->`;
    const block = `${meta}\n## ${slug} (convention)\n\n**Summary**: ${description}\n\n${body}`;
    mkdirSync(join(workspace, '.vinyan', 'memory'), { recursive: true });
    const learnedPath = join(workspace, '.vinyan', 'memory', 'learned.md');
    const existing = existsSync(learnedPath) ? readFileSync(learnedPath, 'utf-8') : '';
    writeFileSync(learnedPath, existing ? `${existing}\n\n${block}\n` : `${block}\n`);
  }

  test('merged content surfaces trust tier and confidence for learned entries', () => {
    // Give resolveInstructions a non-scoped project anchor so the merge is
    // guaranteed to include our learned entry.
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project root');
    writeEntry({
      slug: 'weighted-rule',
      tier: 'deterministic',
      confidence: 0.92,
      description: 'Deterministic rule with high confidence.',
      body: 'Body.',
    });

    const result = resolveInstructions({ workspace });
    expect(result).not.toBeNull();
    // The section header for the learned entry should carry a machine-readable
    // weight label the LLM can attend to.
    expect(result!.content).toMatch(/trust=deterministic/);
    expect(result!.content).toMatch(/confidence=0\.92/);
  });

  test('probabilistic rules get a distinct weight label', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project root');
    writeEntry({
      slug: 'soft-rule',
      tier: 'probabilistic',
      confidence: 0.71,
      description: 'Probabilistic rule at the floor.',
      body: 'Body.',
    });
    const result = resolveInstructions({ workspace });
    expect(result!.content).toMatch(/trust=probabilistic/);
    expect(result!.content).toMatch(/confidence=0\.71/);
  });

  test('non-learned tiers do not receive weight labels', () => {
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project root');
    const result = resolveInstructions({ workspace });
    expect(result!.content).not.toMatch(/trust=/);
    expect(result!.content).not.toMatch(/confidence=/);
  });
});

describe('writeProposal → approveProposal → resolveInstructions (Phase 5 e2e)', () => {
  let workspace: string;

  beforeEach(() => {
    clearInstructionHierarchyCache();
    workspace = makeTempWorkspace('memory-e2e');
    writeFileSync(join(workspace, 'VINYAN.md'), 'Project root instructions.');
  });

  afterEach(() => {
    cleanupWorkspace(workspace);
  });

  function makeProposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
    return {
      slug: 'e2e-rule',
      proposedBy: 'worker-e2e',
      sessionId: 'session-e2e',
      category: 'convention',
      tier: 'heuristic',
      confidence: 0.88,
      applyTo: ['src/api/**/*.ts'],
      description: 'API handlers must return typed responses.',
      body: '## Rule\n\nAPI handlers return typed responses.',
      evidence: [{ filePath: 'src/api/users.ts', note: 'existing handler already returns typed.' }],
      ...overrides,
    };
  }

  test('approved proposal surfaces in resolveInstructions output with weight label', () => {
    writeProposal(workspace, makeProposal());
    approveProposal(workspace, 'e2e-rule', 'alice');

    // Task is scoped to the API glob, so the rule must match.
    const result = resolveInstructions({
      workspace,
      targetFiles: ['src/api/users.ts'],
    });
    expect(result).not.toBeNull();
    const learned = result!.sources.filter((s) => s.tier === 'learned');
    expect(learned).toHaveLength(1);
    expect(learned[0]!.frontmatter.description).toBe('API handlers must return typed responses.');
    expect(learned[0]!.frontmatter.confidence).toBe(0.88);
    // The merged prompt carries the confidence label for worker visibility.
    expect(result!.content).toMatch(/confidence=0\.88/);
  });

  test('approved rule filtered out when target files do not match applyTo', () => {
    writeProposal(workspace, makeProposal({ slug: 'api-only', applyTo: ['src/api/**'] }));
    approveProposal(workspace, 'api-only', 'alice');

    // Task targets UI, so the API-only rule must NOT surface.
    const result = resolveInstructions({
      workspace,
      targetFiles: ['src/ui/button.tsx'],
    });
    // Project tier still carries VINYAN.md, but no learned source.
    expect(result).not.toBeNull();
    const learned = result!.sources.filter((s) => s.tier === 'learned');
    expect(learned).toHaveLength(0);
  });

  test('duplicate-slug approval is blocked and existing entry is preserved', () => {
    writeProposal(workspace, makeProposal({ slug: 'stable' }));
    approveProposal(workspace, 'stable', 'alice');

    writeProposal(workspace, makeProposal({ slug: 'stable', description: 'second attempt' }));
    expect(() => approveProposal(workspace, 'stable', 'alice')).toThrow(/already exists/);

    // resolve still sees exactly one learned entry for this slug.
    const result = resolveInstructions({
      workspace,
      targetFiles: ['src/api/users.ts'],
    });
    const learned = result!.sources.filter((s) => s.tier === 'learned');
    expect(learned).toHaveLength(1);
    expect(learned[0]!.frontmatter.description).toBe('API handlers must return typed responses.');
  });

  test('multiple approvals chain and each per-entry applyTo filters independently', () => {
    writeProposal(
      workspace,
      makeProposal({ slug: 'api-rule', applyTo: ['src/api/**'], description: 'API rule text.' }),
    );
    approveProposal(workspace, 'api-rule', 'alice');

    writeProposal(
      workspace,
      makeProposal({
        slug: 'ui-rule',
        applyTo: ['src/ui/**'],
        description: 'UI rule text.',
      }),
    );
    approveProposal(workspace, 'ui-rule', 'alice');

    writeProposal(
      workspace,
      makeProposal({
        slug: 'global-rule',
        applyTo: undefined,
        description: 'Always-on rule.',
      }),
    );
    approveProposal(workspace, 'global-rule', 'alice');

    // API task: api-rule + global-rule
    const apiResult = resolveInstructions({ workspace, targetFiles: ['src/api/users.ts'] });
    const apiSlugs = apiResult!.sources.filter((s) => s.tier === 'learned').map((s) => s.frontmatter.description);
    expect(apiSlugs).toContain('API rule text.');
    expect(apiSlugs).toContain('Always-on rule.');
    expect(apiSlugs).not.toContain('UI rule text.');

    clearInstructionHierarchyCache();

    // UI task: ui-rule + global-rule
    const uiResult = resolveInstructions({ workspace, targetFiles: ['src/ui/button.tsx'] });
    const uiSlugs = uiResult!.sources.filter((s) => s.tier === 'learned').map((s) => s.frontmatter.description);
    expect(uiSlugs).toContain('UI rule text.');
    expect(uiSlugs).toContain('Always-on rule.');
    expect(uiSlugs).not.toContain('API rule text.');
  });

  test('learned.md path constant matches what resolveInstructions reads from', () => {
    writeProposal(workspace, makeProposal());
    const result = approveProposal(workspace, 'e2e-rule', 'alice');
    // The path the approver wrote to is exactly where instruction-hierarchy looks.
    expect(result.learnedPath).toContain(LEARNED_FILE_REL);
    expect(existsSync(result.learnedPath)).toBe(true);
  });
});

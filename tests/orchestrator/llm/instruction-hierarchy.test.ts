/**
 * Tests for the multi-tier instruction hierarchy.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveInstructions,
  parseFrontmatter,
  matchesGlob,
  clearInstructionHierarchyCache,
} from '../../../src/orchestrator/llm/instruction-hierarchy.ts';

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

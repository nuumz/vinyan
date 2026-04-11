/**
 * Tests for tool-manifest.ts — routing-level-based tool filtering.
 * Phase 6.0: Agentic Worker Protocol.
 */
import { describe, expect, test } from 'bun:test';
import type { RoutingDecision } from '@vinyan/orchestrator/types.ts';
import { manifestFor } from '@vinyan/orchestrator/tools/tool-manifest.ts';

function routing(level: 0 | 1 | 2 | 3): RoutingDecision {
  return { level, model: level === 0 ? null : 'test-model', budgetTokens: 10000, latencyBudgetMs: 30000 };
}

describe('manifestFor', () => {
  test('L0 returns empty manifest', () => {
    expect(manifestFor(routing(0))).toEqual([]);
  });

  test('L1 includes read-only tools + control tools', () => {
    const manifest = manifestFor(routing(1));
    const names = manifest.map((d) => d.name);
    expect(names).toContain('file_read');
    expect(names).toContain('search_grep');
    expect(names).toContain('search_semantic');
    expect(names).toContain('git_status');
    expect(names).toContain('git_diff');
    expect(names).toContain('attempt_completion');
    expect(names).toContain('request_budget_extension');
    // Should NOT include write tools
    expect(names).not.toContain('file_write');
    expect(names).not.toContain('file_edit');
    expect(names).not.toContain('shell_exec');
  });

  test('L2 includes write tools + delegation', () => {
    const manifest = manifestFor(routing(2));
    const names = manifest.map((d) => d.name);
    expect(names).toContain('file_write');
    expect(names).toContain('file_edit');
    expect(names).toContain('shell_exec');
    expect(names).toContain('directory_list');
    expect(names).toContain('http_get');
    expect(names).toContain('delegate_task');
    // Also includes L1 tools
    expect(names).toContain('file_read');
    expect(names).toContain('attempt_completion');
  });

  test('L3 includes all tools', () => {
    const manifest = manifestFor(routing(3));
    const names = manifest.map((d) => d.name);
    // Should include everything from L2
    expect(names).toContain('file_write');
    expect(names).toContain('delegate_task');
    expect(names).toContain('file_read');
  });

  test('all descriptors have valid inputSchema', () => {
    const manifest = manifestFor(routing(3));
    for (const d of manifest) {
      expect(d.inputSchema).toBeDefined();
      expect(d.inputSchema.type).toBe('object');
      expect(d.inputSchema.properties).toBeDefined();
      expect(d.inputSchema.required).toBeDefined();
      expect(Array.isArray(d.inputSchema.required)).toBe(true);
    }
  });

  test('side effect flags are correct', () => {
    const manifest = manifestFor(routing(3));
    const byName = new Map(manifest.map((d) => [d.name, d]));
    expect(byName.get('file_read')!.sideEffect).toBe(false);
    expect(byName.get('file_write')!.sideEffect).toBe(true);
    expect(byName.get('attempt_completion')!.sideEffect).toBe(false);
    expect(byName.get('shell_exec')!.sideEffect).toBe(true);
  });

  test('toolKind distinguishes executable from control tools', () => {
    const manifest = manifestFor(routing(3));
    const byName = new Map(manifest.map((d) => [d.name, d]));

    // Executable tools
    expect(byName.get('file_read')!.toolKind).toBe('executable');
    expect(byName.get('file_write')!.toolKind).toBe('executable');
    expect(byName.get('file_edit')!.toolKind).toBe('executable');
    expect(byName.get('shell_exec')!.toolKind).toBe('executable');
    expect(byName.get('search_grep')!.toolKind).toBe('executable');
    expect(byName.get('git_status')!.toolKind).toBe('executable');
    expect(byName.get('http_get')!.toolKind).toBe('executable');

    // Control tools
    expect(byName.get('attempt_completion')!.toolKind).toBe('control');
    expect(byName.get('request_budget_extension')!.toolKind).toBe('control');
    expect(byName.get('delegate_task')!.toolKind).toBe('control');
  });

  test('all descriptors have toolKind set', () => {
    const manifest = manifestFor(routing(3));
    for (const d of manifest) {
      expect(['executable', 'control']).toContain(d.toolKind);
    }
  });
});

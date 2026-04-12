/**
 * Tests for tool-manifest.ts — routing-level-based tool filtering.
 * Phase 6.0: Agentic Worker Protocol.
 */
import { describe, expect, test } from 'bun:test';
import type { Tool, ToolDescriptor } from '@vinyan/orchestrator/tools/tool-interface.ts';
import { manifestFor } from '@vinyan/orchestrator/tools/tool-manifest.ts';
import type { RoutingDecision } from '@vinyan/orchestrator/types.ts';

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
    // Phase 7c-2: plan_update is L1+ (available as soon as there are tools
    // to plan around) so L1 read-only exploration workers can track progress.
    expect(names).toContain('plan_update');
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
    expect(byName.get('plan_update')!.toolKind).toBe('control');
  });

  test('all descriptors have toolKind set', () => {
    const manifest = manifestFor(routing(3));
    for (const d of manifest) {
      expect(['executable', 'control']).toContain(d.toolKind);
    }
  });

  // Phase 7e: extraTools merge (MCP adapter integration point)
  describe('extraTools', () => {
    function fakeTool(name: string, minRoutingLevel: 0 | 1 | 2 | 3): Tool {
      const desc: ToolDescriptor = {
        name,
        description: `fake ${name}`,
        inputSchema: { type: 'object', properties: {}, required: [] },
        category: 'delegation',
        sideEffect: true,
        minRoutingLevel,
        toolKind: 'executable',
      };
      // IsolationLevel is 0|1|2; clamp 3 to 2 for the fake tool's
      // isolation value (routing filtering still uses `minRoutingLevel`).
      const isolation = (minRoutingLevel === 3 ? 2 : minRoutingLevel) as 0 | 1 | 2;
      return {
        name,
        description: desc.description,
        minIsolationLevel: isolation,
        category: 'delegation',
        sideEffect: true,
        descriptor: () => desc,
        execute: async () => ({
          callId: '',
          tool: name,
          status: 'success',
          durationMs: 0,
        }),
      };
    }

    test('extra tools are merged on top of built-ins at the same routing level', () => {
      const extra = new Map<string, Tool>([['mcp__gh__create_issue', fakeTool('mcp__gh__create_issue', 2)]]);
      const manifest = manifestFor(routing(2), extra);
      const names = manifest.map((d) => d.name);
      expect(names).toContain('file_write');
      expect(names).toContain('mcp__gh__create_issue');
    });

    test('extra tools are filtered by routing level like built-ins', () => {
      const extra = new Map<string, Tool>([['mcp__gh__create_issue', fakeTool('mcp__gh__create_issue', 2)]]);
      // L1 should NOT see the L2-gated MCP tool.
      const manifest = manifestFor(routing(1), extra);
      const names = manifest.map((d) => d.name);
      expect(names).not.toContain('mcp__gh__create_issue');
    });

    test('L0 with extra tools still returns empty manifest', () => {
      const extra = new Map<string, Tool>([['mcp__fs__read', fakeTool('mcp__fs__read', 2)]]);
      expect(manifestFor(routing(0), extra)).toEqual([]);
    });

    test('omitting extra tools preserves built-in-only behavior', () => {
      const withExtras = manifestFor(routing(2), new Map());
      const withoutExtras = manifestFor(routing(2));
      expect(withExtras.map((d) => d.name).sort()).toEqual(withoutExtras.map((d) => d.name).sort());
    });
  });
});

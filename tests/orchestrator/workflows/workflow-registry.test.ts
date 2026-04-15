/**
 * Wave 6: workflow registry unit tests.
 */
import { describe, expect, test } from 'bun:test';
import {
  BUILT_IN_WORKFLOWS,
  WorkflowRegistry,
  type WorkflowMetadata,
} from '../../../src/orchestrator/workflows/workflow-registry.ts';

describe('WorkflowRegistry', () => {
  test('constructs with 4 built-in workflows by default', () => {
    const registry = new WorkflowRegistry();
    expect(registry.list()).toEqual([
      'agentic-workflow',
      'conversational',
      'direct-tool',
      'full-pipeline',
    ]);
  });

  test('get() returns metadata for known strategy', () => {
    const registry = new WorkflowRegistry();
    const meta = registry.get('conversational');
    expect(meta).toBeDefined();
    expect(meta?.requiresTools).toBe(false);
    expect(meta?.shortCircuits).toBe(true);
    expect(meta?.builtIn).toBe(true);
  });

  test('get() returns undefined for unknown strategy', () => {
    const registry = new WorkflowRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  test('has() for known + unknown', () => {
    const registry = new WorkflowRegistry();
    expect(registry.has('full-pipeline')).toBe(true);
    expect(registry.has('custom-thing')).toBe(false);
  });

  test('register() adds a new strategy', () => {
    const registry = new WorkflowRegistry();
    const custom: WorkflowMetadata = {
      strategy: 'research-swarm-v2',
      description: 'Custom research workflow',
      requiresTools: true,
      routingFloor: 2,
      shortCircuits: false,
      builtIn: false,
    };
    registry.register(custom);
    expect(registry.has('research-swarm-v2')).toBe(true);
    expect(registry.get('research-swarm-v2')?.builtIn).toBe(false);
  });

  test('register() rejects duplicate strategy', () => {
    const registry = new WorkflowRegistry();
    expect(() =>
      registry.register({
        strategy: 'conversational',
        description: 'x',
        requiresTools: false,
        shortCircuits: false,
        builtIn: false,
      }),
    ).toThrow(/already registered/);
  });

  test('listShortCircuits returns only short-circuiting strategies', () => {
    const registry = new WorkflowRegistry();
    const shortCircuits = registry.listShortCircuits();
    expect(shortCircuits).toContain('conversational');
    expect(shortCircuits).toContain('direct-tool');
    expect(shortCircuits).not.toContain('full-pipeline');
    expect(shortCircuits).not.toContain('agentic-workflow');
  });

  test('fallback() returns full-pipeline', () => {
    const registry = new WorkflowRegistry();
    expect(registry.fallback()).toBe('full-pipeline');
  });

  test('BUILT_IN_WORKFLOWS has 4 entries and matches current strategies', () => {
    expect(BUILT_IN_WORKFLOWS).toHaveLength(4);
    const strategies = BUILT_IN_WORKFLOWS.map((w) => w.strategy);
    expect(strategies).toContain('conversational');
    expect(strategies).toContain('direct-tool');
    expect(strategies).toContain('agentic-workflow');
    expect(strategies).toContain('full-pipeline');
  });

  test('custom initial workflow list is honored', () => {
    const custom: WorkflowMetadata[] = [
      {
        strategy: 'only-this',
        description: 'sole entry',
        requiresTools: false,
        shortCircuits: true,
        builtIn: false,
      },
    ];
    const registry = new WorkflowRegistry(custom);
    expect(registry.list()).toEqual(['only-this']);
  });
});

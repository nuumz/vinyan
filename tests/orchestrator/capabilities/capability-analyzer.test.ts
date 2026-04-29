/**
 * Capability Analyzer tests — deterministic requirement derivation.
 *
 * Covers:
 *   - File-extension fingerprint emits a `task.file-extensions` requirement
 *   - Action-verb fingerprint becomes a low-weight verb requirement
 *   - taskType=reasoning maps to `general-reasoning` domain
 *   - taskType=code with files maps to `code-mutation` domain
 *   - taskType=code without files maps to `code-reasoning` domain
 *   - Caller-supplied `requirements` pass through with normalized `source`
 *   - Caller-supplied `roles` become role-typed requirements (deduped)
 */
import { describe, expect, test } from 'bun:test';
import { analyzeRequirements } from '../../../src/orchestrator/capabilities/capability-analyzer.ts';
import type { CapabilityRequirement, TaskInput } from '../../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-analyzer',
    source: 'cli',
    goal: 'refactor module',
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 10_000, maxRetries: 1 },
    ...overrides,
  };
}

describe('analyzeRequirements', () => {
  test('emits file-extension requirement when task targets files', () => {
    const reqs = analyzeRequirements({
      task: makeInput({ targetFiles: ['src/foo.ts', 'src/bar.tsx'] }),
    });
    const ext = reqs.find((r) => r.id === 'task.file-extensions');
    expect(ext).toBeDefined();
    expect(ext?.fileExtensions).toContain('.ts');
    expect(ext?.fileExtensions).toContain('.tsx');
    expect(ext?.weight).toBeGreaterThan(0);
    expect(ext?.source).toBe('fingerprint');
  });

  test('action verb becomes a low-weight verb requirement', () => {
    const reqs = analyzeRequirements({
      task: makeInput({ goal: 'refactor the auth module', targetFiles: ['src/auth.ts'] }),
    });
    const verb = reqs.find((r) => r.id?.startsWith('task.action.'));
    expect(verb).toBeDefined();
    expect(verb?.actionVerbs?.length).toBeGreaterThan(0);
    // Verbs are intentionally weighted below extensions to avoid pulling
    // the wrong specialist on shared verbs (e.g. "test" → ts-coder on a .md).
    const ext = reqs.find((r) => r.id === 'task.file-extensions');
    expect(verb?.weight ?? 0).toBeLessThan(ext?.weight ?? 1);
  });

  test('taskType=reasoning maps to general-reasoning domain', () => {
    const reqs = analyzeRequirements({
      task: makeInput({ taskType: 'reasoning', goal: 'what is two plus two', targetFiles: undefined }),
    });
    const domain = reqs.find((r) => r.id?.startsWith('task.domain.'));
    expect(domain?.domains).toEqual(['general-reasoning']);
  });

  test('taskType=code with files maps to code-mutation domain', () => {
    const reqs = analyzeRequirements({
      task: makeInput({ taskType: 'code', targetFiles: ['src/x.ts'] }),
    });
    const domain = reqs.find((r) => r.id?.startsWith('task.domain.'));
    expect(domain?.domains).toEqual(['code-mutation']);
  });

  test('taskType=code without files maps to code-reasoning domain', () => {
    const reqs = analyzeRequirements({
      task: makeInput({ taskType: 'code', targetFiles: undefined }),
    });
    const domain = reqs.find((r) => r.id?.startsWith('task.domain.'));
    expect(domain?.domains).toEqual(['code-reasoning']);
  });

  test('caller-supplied requirements pass through with normalized source', () => {
    const callerReqs: CapabilityRequirement[] = [
      { id: 'custom.thing', weight: 0.7, domains: ['x'], source: 'llm-extract' },
    ];
    const reqs = analyzeRequirements({
      task: makeInput(),
      requirements: callerReqs,
    });
    const custom = reqs.find((r) => r.id === 'custom.thing');
    expect(custom).toBeDefined();
    expect(custom?.source).toBe('llm-extract');
  });

  test('caller-supplied requirements without source default to caller', () => {
    // The analyzer normalizes a missing `source` to 'caller'. Cast through
    // unknown to construct a partial req — production callers come from the
    // LLM intent resolver where TS strictness can't catch a forgotten field.
    const partial = { id: 'custom.partial', weight: 0.5 } as unknown as CapabilityRequirement;
    const reqs = analyzeRequirements({
      task: makeInput(),
      requirements: [partial],
    });
    const found = reqs.find((r) => r.id === 'custom.partial');
    expect(found?.source).toBe('caller');
  });

  test('roles become role-typed requirements deduped against caller requirements', () => {
    const reqs = analyzeRequirements({
      task: makeInput(),
      roles: ['editor', 'researcher'],
    });
    const editor = reqs.find((r) => r.role === 'editor');
    const researcher = reqs.find((r) => r.role === 'researcher');
    expect(editor).toBeDefined();
    expect(researcher).toBeDefined();
    expect(editor?.weight).toBeGreaterThan(0);
  });

  test('skips action.unknown', () => {
    const reqs = analyzeRequirements({
      task: makeInput({ goal: 'x' }), // no recognisable verb
    });
    const verb = reqs.find((r) => r.id === 'task.action.unknown');
    expect(verb).toBeUndefined();
  });
});

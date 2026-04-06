import { describe, expect, it } from 'bun:test';
import { PromptSectionRegistry, createDefaultRegistry } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';

function makeContext(overrides: Partial<SectionContext> = {}): SectionContext {
  return {
    goal: 'Fix the bug in auth module',
    perception: {
      taskTarget: { file: 'src/auth.ts', description: 'Fix auth bug' },
      dependencyCone: {
        directImporters: ['src/api.ts'],
        directImportees: ['src/db.ts'],
        transitiveBlastRadius: 5,
      },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: ['bun', 'tsc'] },
    },
    memory: {
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    },
    ...overrides,
  };
}

describe('PromptSectionRegistry', () => {
  it('renders sections sorted by priority', () => {
    const registry = new PromptSectionRegistry();
    registry.register({ id: 'b', target: 'user', cache: 'ephemeral', priority: 20, render: () => 'B' });
    registry.register({ id: 'a', target: 'user', cache: 'ephemeral', priority: 10, render: () => 'A' });
    registry.register({ id: 'c', target: 'user', cache: 'ephemeral', priority: 30, render: () => 'C' });

    const result = registry.renderTarget('user', makeContext());
    expect(result).toBe('A\n\nB\n\nC');
  });

  it('skips sections that return null', () => {
    const registry = new PromptSectionRegistry();
    registry.register({ id: 'a', target: 'user', cache: 'ephemeral', priority: 10, render: () => 'A' });
    registry.register({ id: 'b', target: 'user', cache: 'ephemeral', priority: 20, render: () => null });
    registry.register({ id: 'c', target: 'user', cache: 'ephemeral', priority: 30, render: () => 'C' });

    const result = registry.renderTarget('user', makeContext());
    expect(result).toBe('A\n\nC');
  });

  it('filters by target', () => {
    const registry = new PromptSectionRegistry();
    registry.register({ id: 'sys', target: 'system', cache: 'static', priority: 10, render: () => 'SYS' });
    registry.register({ id: 'usr', target: 'user', cache: 'ephemeral', priority: 10, render: () => 'USR' });

    expect(registry.renderTarget('system', makeContext())).toBe('SYS');
    expect(registry.renderTarget('user', makeContext())).toBe('USR');
  });

  it('getSectionIds returns all registered IDs', () => {
    const registry = new PromptSectionRegistry();
    registry.register({ id: 'a', target: 'user', cache: 'ephemeral', priority: 10, render: () => 'A' });
    registry.register({ id: 'b', target: 'system', cache: 'static', priority: 20, render: () => 'B' });

    expect(registry.getSectionIds()).toEqual(['a', 'b']);
  });
});

describe('createDefaultRegistry', () => {
  it('registers 16 sections', () => {
    const registry = createDefaultRegistry();
    expect(registry.getSectionIds()).toHaveLength(16);
  });

  it('system prompt contains ROLE, OUTPUT FORMAT, BEHAVIORAL RULES, TOOLS, ORACLE', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext();
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[ROLE]');
    expect(system).toContain('[OUTPUT FORMAT]');
    expect(system).toContain('[BEHAVIORAL RULES]');
    expect(system).toContain('[AVAILABLE TOOLS]');
    expect(system).toContain('[ORACLE VERIFICATION CAPABILITIES]');
  });

  it('BEHAVIORAL RULES section contains anti-hallucination directives', () => {
    const registry = createDefaultRegistry();
    const system = registry.renderTarget('system', makeContext());

    expect(system).toContain('do NOT guess');
    expect(system).toContain('Never fabricate import paths');
    expect(system).toContain('minimal changes');
  });

  it('user prompt contains TASK section', () => {
    const registry = createDefaultRegistry();
    const user = registry.renderTarget('user', makeContext());

    expect(user).toContain('[TASK]');
    expect(user).toContain('Fix the bug in auth module');
  });

  it('user prompt skips instructions when absent', () => {
    const registry = createDefaultRegistry();
    const user = registry.renderTarget('user', makeContext());

    expect(user).not.toContain('[PROJECT INSTRUCTIONS]');
  });

  it('user prompt includes instructions when present', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext({
      instructions: { content: 'Use Bun for everything', contentHash: 'abc123', filePath: '/workspace/VINYAN.md' },
    });
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[PROJECT INSTRUCTIONS]');
    expect(user).toContain('Use Bun for everything');
  });

  it('user prompt includes KNOWN FACTS with trust annotations', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext({
      perception: {
        taskTarget: { file: 'src/auth.ts', description: 'Fix auth bug' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [
          { target: 'src/auth.ts', pattern: 'export function login', verified_at: 1, hash: 'h1', confidence: 0.95, oracleName: 'ast', tierReliability: 0.99 },
        ],
        runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: ['bun'] },
      },
    });
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[KNOWN FACTS]');
    expect(user).toContain('deterministic');
    expect(user).toContain('oracle: ast');
  });

  it('user prompt includes FAILED APPROACHES for failed approaches', () => {
    const registry = createDefaultRegistry();
    const ctx = makeContext({
      memory: {
        failedApproaches: [{ approach: 'regex replace', oracleVerdict: 'type error', timestamp: Date.now() }],
        activeHypotheses: [],
        unresolvedUncertainties: [],
        scopedFacts: [],
      },
    });
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[FAILED APPROACHES]');
    expect(user).toContain('Do NOT try: regex replace');
  });

  it('user prompt skips empty sections', () => {
    const registry = createDefaultRegistry();
    const user = registry.renderTarget('user', makeContext());

    // No facts, no constraints, no hypotheses, no plan
    expect(user).not.toContain('[KNOWN FACTS]');
    expect(user).not.toContain('[FAILED APPROACHES]');
    expect(user).not.toContain('[USER CONSTRAINTS]');
    expect(user).not.toContain('[HYPOTHESES]');
    expect(user).not.toContain('[PLAN]');
  });
});

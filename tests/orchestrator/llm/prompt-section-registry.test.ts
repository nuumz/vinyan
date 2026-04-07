import { describe, expect, it } from 'bun:test';
import { PromptSectionRegistry, createDefaultRegistry, createReasoningRegistry } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { SectionContext } from '../../../src/orchestrator/llm/prompt-section-registry.ts';
import type { SemanticTaskUnderstanding, TaskDomain, TaskIntent } from '../../../src/orchestrator/types.ts';

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

// ── Reasoning Registry (domain-aware prompts) ──────────────────────

function makeReasoningContext(
  domain: TaskDomain,
  overrides: Partial<SectionContext> = {},
  intent?: TaskIntent,
): SectionContext {
  const resolvedIntent = intent ?? (domain === 'conversational' ? 'converse' : 'inquire');
  return {
    goal: 'สวัสดี',
    perception: {
      taskTarget: { file: '', description: '' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: ['file_read', 'shell_exec'] },
    },
    memory: {
      failedApproaches: [],
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    },
    understanding: {
      rawGoal: 'สวัสดี',
      actionVerb: 'unknown',
      actionCategory: 'mutation',
      targetSymbol: undefined,
      frameworkContext: [],
      constraints: [],
      acceptanceCriteria: [],
      expectsMutation: false,
      taskDomain: domain,
      taskIntent: resolvedIntent,
      toolRequirement: 'none',
      resolvedEntities: [],
      understandingDepth: 0,
      verifiedClaims: [],
      understandingFingerprint: 'test-fp',
    } satisfies SemanticTaskUnderstanding,
    ...overrides,
  };
}

describe('createReasoningRegistry — domain-aware prompts', () => {
  it('general-reasoning: role has no orchestrator mention, has anti-hallucination', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('general-reasoning'));

    expect(system).toContain('helpful assistant');
    expect(system).not.toContain('orchestrator');
    expect(system).toContain('Do NOT claim to have tools');
  });

  it('conversational: friendly assistant role, no orchestrator mention', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('conversational'));

    expect(system).toContain('friendly assistant');
    expect(system).not.toContain('orchestrator');
  });

  it('code-reasoning: role mentions Vinyan orchestrator', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('code-reasoning'));

    expect(system).toContain('Vinyan');
    expect(system).toContain('orchestrator');
    expect(system).not.toContain('Do NOT claim to have tools');
  });

  it('general-reasoning: task section has intent hint, no code metadata', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('general-reasoning');
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[TASK]');
    expect(user).toContain('Intent: unknown');
    expect(user).not.toContain('Action:');
    expect(user).not.toContain('Symbol:');
  });

  it('code-reasoning: task section includes code metadata', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('code-reasoning');
    (ctx.understanding as SemanticTaskUnderstanding).actionVerb = 'explain';
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('Action: explain');
  });

  it('general-reasoning: no tools shown', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('general-reasoning'));

    expect(system).not.toContain('[AVAILABLE TOOLS]');
    expect(system).not.toContain('shell_exec');
  });

  it('conversational: no tools shown', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('conversational'));

    expect(system).not.toContain('[AVAILABLE TOOLS]');
  });

  it('general-reasoning: no codebase perception', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('general-reasoning', {
      perception: {
        taskTarget: { file: 'src/auth.ts', description: 'target file' },
        dependencyCone: { directImporters: ['src/api.ts'], directImportees: [], transitiveBlastRadius: 3 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: ['file_read'] },
        fileContents: [{ file: 'src/auth.ts', content: 'export function login() {}', truncated: false }],
      },
    });
    const user = registry.renderTarget('user', ctx);

    expect(user).not.toContain('[CODEBASE CONTEXT]');
    expect(user).not.toContain('[FILE CONTENTS]');
  });

  it('code-reasoning: includes codebase perception when available', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('code-reasoning', {
      perception: {
        taskTarget: { file: 'src/auth.ts', description: 'target file' },
        dependencyCone: { directImporters: ['src/api.ts'], directImportees: [], transitiveBlastRadius: 3 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: ['file_read'] },
        fileContents: [{ file: 'src/auth.ts', content: 'export function login() {}', truncated: false }],
      },
    });
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('[CODEBASE CONTEXT]');
    expect(user).toContain('[FILE CONTENTS]');
  });

  it('code-mutation: tools shown when available', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('code-mutation'));

    expect(system).toContain('[AVAILABLE TOOLS]');
    expect(system).toContain('shell_exec');
  });

  it('general-reasoning: environment section renders OS', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('general-reasoning', {
      perception: {
        taskTarget: { file: '', description: '' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '20.0.0', os: 'darwin', availableTools: [] },
      },
    });
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[ENVIRONMENT]');
    expect(system).toContain('Platform: macOS');
  });

  it('conversational: environment section renders OS', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('conversational', {
      perception: {
        taskTarget: { file: '', description: '' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '20.0.0', os: 'linux', availableTools: [] },
      },
    });
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[ENVIRONMENT]');
    expect(system).toContain('Platform: Linux');
  });

  it('code-reasoning: environment section renders OS', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('code-reasoning', {
      perception: {
        taskTarget: { file: '', description: '' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '20.0.0', os: 'win32', availableTools: [] },
      },
    });
    const system = registry.renderTarget('system', ctx);

    expect(system).toContain('[ENVIRONMENT]');
    expect(system).toContain('Platform: Windows');
  });

  it('non-code role mentions environment awareness', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('general-reasoning'));

    expect(system).toContain('operating environment');
    expect(system).toContain('specific to their platform');
  });

  it('code-reasoning role does not mention platform awareness', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('code-reasoning'));

    expect(system).not.toContain('operating environment');
  });

  it('conversational: task section has intent hint', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('conversational');
    (ctx.understanding as SemanticTaskUnderstanding).actionVerb = 'greet';
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('Intent: greet');
    expect(user).not.toContain('Action:');
  });

  // ── Intent-aware prompt framing ────────────────────────────────────

  it('execute intent: role is task orchestrator with goal framing', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('general-reasoning', {}, 'execute'));

    expect(system).toContain('task orchestrator');
    expect(system).toContain('goal');
    expect(system).not.toContain('helpful assistant');
    expect(system).not.toContain('Do NOT claim to have tools');
  });

  it('execute intent: task section has Goal line', () => {
    const registry = createReasoningRegistry();
    const ctx = makeReasoningContext('general-reasoning', { goal: 'ช่วย capture window screen' }, 'execute');
    (ctx.understanding as SemanticTaskUnderstanding).actionVerb = 'capture';
    const user = registry.renderTarget('user', ctx);

    expect(user).toContain('Goal: capture');
    expect(user).not.toContain('Intent:');
    expect(user).not.toContain('Action:');
  });

  it('inquire intent: role is helpful assistant', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('general-reasoning', {}, 'inquire'));

    expect(system).toContain('helpful assistant');
    expect(system).not.toContain('task orchestrator');
  });

  it('converse intent: role is friendly assistant', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('conversational', {}, 'converse'));

    expect(system).toContain('friendly assistant');
    expect(system).not.toContain('task orchestrator');
    expect(system).not.toContain('helpful assistant');
  });

  it('execute intent on code domain: still uses Vinyan orchestrator role', () => {
    const registry = createReasoningRegistry();
    const system = registry.renderTarget('system', makeReasoningContext('code-mutation', {}, 'execute'));

    expect(system).toContain('Vinyan');
    expect(system).toContain('orchestrator');
  });
});

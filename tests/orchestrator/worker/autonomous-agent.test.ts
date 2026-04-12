/**
 * Tests for autonomous agent features:
 * - SessionProgress (agent-loop.ts) — progress tracking, stall detection, budget hints
 * - buildSystemPrompt / buildInitUserMessage (agent-worker-entry.ts) — prompt construction
 */
import { describe, expect, test } from 'bun:test';
import { SessionProgress } from '../../../src/orchestrator/worker/agent-loop.ts';
import {
  buildInitUserMessage,
  buildSystemPrompt,
} from '../../../src/orchestrator/worker/agent-worker-entry.ts';

// ── SessionProgress ─────────────────────────────────────────────────

describe('SessionProgress', () => {
  test('recordToolResult tracks success and failure counts', () => {
    const sp = new SessionProgress();
    sp.recordToolResult('file_read', false, 'Reading /tmp/a.ts');
    sp.recordToolResult('file_read', false, 'Reading /tmp/b.ts');
    sp.recordToolResult('shell_exec', true);

    expect(sp.toolSuccessCount).toBe(2);
    expect(sp.toolFailureCount).toBe(1);
  });

  test('consecutiveFailures resets on success', () => {
    const sp = new SessionProgress();
    sp.recordToolResult('file_read', true);
    sp.recordToolResult('file_read', true);
    expect(sp.consecutiveFailures).toBe(2);

    sp.recordToolResult('file_read', false, 'Reading ok');
    expect(sp.consecutiveFailures).toBe(0);
  });

  test('recordTurn increments turnsWithoutProgress when no progress', () => {
    const sp = new SessionProgress();
    // No tool calls — no progress
    sp.recordTurn(false);
    expect(sp.turnsWithoutProgress).toBe(1);

    sp.recordTurn(false);
    expect(sp.turnsWithoutProgress).toBe(2);
  });

  test('recordTurn resets turnsWithoutProgress when progress made', () => {
    const sp = new SessionProgress();
    sp.recordTurn(false);
    sp.recordTurn(false);
    expect(sp.turnsWithoutProgress).toBe(2);

    // Progress: had tool calls AND consecutiveFailures === 0
    sp.recordTurn(true);
    expect(sp.turnsWithoutProgress).toBe(0);
  });

  test('recordTurn counts no progress when tools called but all failing', () => {
    const sp = new SessionProgress();
    sp.recordToolResult('file_read', true); // failure increments consecutiveFailures
    sp.recordTurn(true); // hadToolCalls=true but consecutiveFailures > 0
    expect(sp.turnsWithoutProgress).toBe(1);
  });

  test('getSystemHint returns null when everything is fine', () => {
    const sp = new SessionProgress();
    const hint = sp.getSystemHint(0.3, 8);
    expect(hint).toBeNull();
  });

  test('getSystemHint returns budget warning at 70%', () => {
    const sp = new SessionProgress();
    const hint = sp.getSystemHint(0.72, 5);
    expect(hint).not.toBeNull();
    expect(hint).toContain('BUDGET NOTICE');
    expect(hint).toContain('70%');
  });

  test('getSystemHint returns urgent warning at 85%', () => {
    const sp = new SessionProgress();
    const hint = sp.getSystemHint(0.90, 3);
    expect(hint).not.toBeNull();
    expect(hint).toContain('BUDGET WARNING');
    expect(hint).toContain('85%');
    expect(hint).toContain('Wrap up NOW');
  });

  test('getSystemHint returns turns warning when <=2 remaining', () => {
    const sp = new SessionProgress();
    const hint = sp.getSystemHint(0.4, 2);
    expect(hint).not.toBeNull();
    expect(hint).toContain('TURNS WARNING');
    expect(hint).toContain('2 turn(s)');
    expect(hint).toContain('attempt_completion');
  });

  test('getSystemHint returns guidance on 3+ consecutive failures', () => {
    const sp = new SessionProgress();
    sp.recordToolResult('file_read', true);
    sp.recordToolResult('file_read', true);
    sp.recordToolResult('file_read', true);

    const hint = sp.getSystemHint(0.3, 8);
    expect(hint).not.toBeNull();
    expect(hint).toContain('GUIDANCE');
    expect(hint).toContain('3 consecutive tool failures');
    expect(hint).toContain('different approach');
  });

  test('getSystemHint returns stall warning at 2 turns without progress', () => {
    const sp = new SessionProgress();
    sp.recordTurn(false);
    sp.recordTurn(false);

    const hint = sp.getSystemHint(0.3, 8);
    expect(hint).not.toBeNull();
    expect(hint).toContain('STALL WARNING');
    expect(hint).toContain('2 turns');
  });

  test('getSystemHint escalates to forced pivot at 3+ turns without progress', () => {
    const sp = new SessionProgress();
    sp.recordTurn(false);
    sp.recordTurn(false);
    sp.recordTurn(false);

    const hint = sp.getSystemHint(0.3, 8);
    expect(hint).not.toBeNull();
    // 3+ stalled turns escalates from warning to forced pivot
    expect(hint).toContain('FORCED PIVOT');
    expect(hint).toContain('3 turns');
  });

  test('checkDuplicate detects identical calls regardless of key order', () => {
    const sp = new SessionProgress();
    // First call — not a duplicate
    const first = sp.checkDuplicate('file_read', { file_path: '/a.ts', limit: 100 });
    expect(first).toBeNull();

    // Same params, different key order — MUST still be detected as duplicate
    const second = sp.checkDuplicate('file_read', { limit: 100, file_path: '/a.ts' });
    expect(second).not.toBeNull();
    expect(second).toContain('DUPLICATE WARNING');
  });

  test('checkDuplicate detects identical calls with nested objects in different key order', () => {
    const sp = new SessionProgress();
    sp.checkDuplicate('shell_exec', { cmd: 'ls', env: { HOME: '/', USER: 'x' } });
    const dup = sp.checkDuplicate('shell_exec', { cmd: 'ls', env: { USER: 'x', HOME: '/' } });
    expect(dup).not.toBeNull();
    expect(dup).toContain('DUPLICATE WARNING');
  });

  test('checkDuplicate does NOT flag different params as duplicates', () => {
    const sp = new SessionProgress();
    sp.checkDuplicate('file_read', { file_path: '/a.ts' });
    const different = sp.checkDuplicate('file_read', { file_path: '/b.ts' });
    expect(different).toBeNull();
  });

  test('getSystemHint combines multiple warnings', () => {
    const sp = new SessionProgress();
    // Trigger consecutive failures
    sp.recordToolResult('file_read', true);
    sp.recordToolResult('file_read', true);
    sp.recordToolResult('file_read', true);
    // Trigger stall
    sp.recordTurn(true); // hadToolCalls but consecutiveFailures > 0 → stall
    sp.recordTurn(true);
    sp.recordTurn(true);

    // Budget at 90%, only 1 turn remaining
    const hint = sp.getSystemHint(0.90, 1);
    expect(hint).not.toBeNull();
    // Should contain all four warnings — at 3 stalled turns, the stall
    // warning escalates to a forced pivot.
    expect(hint).toContain('BUDGET WARNING');
    expect(hint).toContain('TURNS WARNING');
    expect(hint).toContain('GUIDANCE');
    expect(hint).toContain('FORCED PIVOT');
  });
});

// ── buildSystemPrompt ───────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  test('code task includes reasoning framework', () => {
    const prompt = buildSystemPrompt(2, 'code');
    expect(prompt).toContain('Reasoning Framework');
    expect(prompt).toContain('Assess');
    expect(prompt).toContain('Identify gap');
    expect(prompt).toContain('Select action');
    expect(prompt).toContain('Execute');
    expect(prompt).toContain('Observe');
    expect(prompt).toContain('Decide');
    expect(prompt).toContain('Task Type: Code');
  });

  test('reasoning task includes research instructions', () => {
    const prompt = buildSystemPrompt(1, 'reasoning');
    expect(prompt).toContain('Task Type: Research / Reasoning');
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('Reasoning Framework');
  });

  test('both types mention attempt_completion', () => {
    const codePrompt = buildSystemPrompt(1, 'code');
    const reasoningPrompt = buildSystemPrompt(1, 'reasoning');
    expect(codePrompt).toContain('attempt_completion');
    expect(reasoningPrompt).toContain('attempt_completion');
  });

  test('both types mention budget awareness', () => {
    const codePrompt = buildSystemPrompt(1, 'code');
    const reasoningPrompt = buildSystemPrompt(1, 'reasoning');
    expect(codePrompt).toContain('BUDGET WARNING');
    expect(reasoningPrompt).toContain('BUDGET WARNING');
    expect(codePrompt).toContain('Budget Awareness');
    expect(reasoningPrompt).toContain('Budget Awareness');
  });
});

// ── buildInitUserMessage ────────────────────────────────────────────

describe('buildInitUserMessage', () => {
  test('includes acceptance criteria when provided', () => {
    const msg = buildInitUserMessage(
      'Implement feature X',
      {},
      undefined, // priorAttempts
      undefined, // understanding
      undefined, // conversationHistory
      undefined, // failedApproaches
      ['All tests pass', 'No type errors', 'Function exported'],
    );
    expect(msg).toContain('## Acceptance Criteria');
    expect(msg).toContain('- [ ] All tests pass');
    expect(msg).toContain('- [ ] No type errors');
    expect(msg).toContain('- [ ] Function exported');
  });

  test('includes failed approaches when provided', () => {
    const msg = buildInitUserMessage(
      'Fix the bug',
      {},
      undefined, // priorAttempts
      undefined, // understanding
      undefined, // conversationHistory
      [
        { approach: 'Used regex to parse HTML', oracleVerdict: 'AST oracle: invalid parse tree' },
        { approach: 'Monkey-patched the module', oracleVerdict: 'Type oracle: type mismatch' },
      ],
    );
    expect(msg).toContain('## Failed Approaches (DO NOT repeat)');
    expect(msg).toContain('Used regex to parse HTML');
    expect(msg).toContain('AST oracle: invalid parse tree');
    expect(msg).toContain('Monkey-patched the module');
    expect(msg).toContain('Type oracle: type mismatch');
  });

  test('renders success criteria from understanding', () => {
    const understanding = {
      semanticIntent: {
        goalSummary: 'Add sorting to the table component',
        primaryAction: 'implement',
        scope: 'table component',
        successCriteria: [
          'Table headers are clickable',
          'Data sorts ascending/descending on click',
          'Sort indicator icon visible',
        ],
      },
    };

    const msg = buildInitUserMessage(
      'Add sort to table',
      {},
      undefined,
      understanding,
    );
    expect(msg).toContain('## Success Criteria');
    expect(msg).toContain('You are done when ALL of these are met');
    expect(msg).toContain('- [ ] Table headers are clickable');
    expect(msg).toContain('- [ ] Data sorts ascending/descending on click');
    expect(msg).toContain('- [ ] Sort indicator icon visible');
  });

  test('renders perception as structured context, not raw JSON when possible', () => {
    const perception = {
      taskTarget: { file: 'src/components/table.ts', content: 'export class Table {}' },
      depCone: ['src/utils/sort.ts', 'src/types.ts'],
      diagnostics: [{ file: 'table.ts', line: 10, message: 'unused variable' }],
      worldFacts: [
        { key: 'framework', value: 'React', tier_reliability: 'deterministic' },
      ],
    };

    const msg = buildInitUserMessage('Fix table', perception);
    expect(msg).toContain('## Workspace Context');
    expect(msg).toContain('Target file: src/components/table.ts');
    expect(msg).toContain('export class Table {}');
    expect(msg).toContain('Dependencies: src/utils/sort.ts, src/types.ts');
    expect(msg).toContain('Diagnostics:');
    expect(msg).toContain('Known facts:');
    expect(msg).toContain('framework');
    // Structured rendering, not dumped as {"taskTarget":...}
    expect(msg).not.toContain('"taskTarget"');
  });

  test('falls back to raw JSON when perception has no recognized fields', () => {
    const perception = { customField: 'some value' };
    const msg = buildInitUserMessage('Do something', perception);
    expect(msg).toContain('## Workspace Context');
    // Falls back to JSON since no recognized fields were extracted
    expect(msg).toContain('"customField"');
  });

  test('prior attempts rendered as lessons with approach/result/lesson format', () => {
    const msg = buildInitUserMessage(
      'Refactor module',
      {},
      [
        { approach: 'Inline all functions', outcome: 'failed', failureReason: 'Circular dependency detected' },
        { approach: 'Extract to utils', outcome: 'partial', failureReason: 'Missing type exports' },
        { description: 'Try DI pattern', status: 'failed', error: 'Too many constructor params' },
      ],
    );
    expect(msg).toContain('## Prior Attempts (DO NOT repeat these)');

    // First attempt
    expect(msg).toContain('Approach: Inline all functions');
    expect(msg).toContain('Result: failed');
    expect(msg).toContain('Lesson: Circular dependency detected');

    // Second attempt
    expect(msg).toContain('Approach: Extract to utils');
    expect(msg).toContain('Result: partial');
    expect(msg).toContain('Lesson: Missing type exports');

    // Third attempt — uses fallback field names (description/status/error)
    expect(msg).toContain('Approach: Try DI pattern');
    expect(msg).toContain('Result: failed');
    expect(msg).toContain('Lesson: Too many constructor params');
  });

  test('renders resolved references from understanding entities', () => {
    const understanding = {
      semanticIntent: { goalSummary: 'Fix imports' },
      resolvedEntities: [
        { reference: 'the config file', resolvedPaths: ['src/config.ts'], resolution: 'exact' },
        { reference: 'utils', resolvedPaths: ['src/utils/index.ts', 'src/utils/helpers.ts'], resolution: 'fuzzy' },
      ],
    };

    const msg = buildInitUserMessage('Fix imports', {}, undefined, understanding);
    expect(msg).toContain('## Resolved References');
    expect(msg).toContain('"the config file" → src/config.ts (exact)');
    expect(msg).toContain('"utils" → src/utils/index.ts, src/utils/helpers.ts (fuzzy)');
  });

  test('omits optional sections when params not provided', () => {
    const msg = buildInitUserMessage('Simple task', {});
    expect(msg).toContain('## Goal');
    expect(msg).toContain('Simple task');
    expect(msg).not.toContain('## Acceptance Criteria');
    expect(msg).not.toContain('## Failed Approaches');
    expect(msg).not.toContain('## Prior Attempts');
    expect(msg).not.toContain('## Success Criteria');
    expect(msg).not.toContain('## Conversation History');
    expect(msg).not.toContain('## Resolved References');
  });
});

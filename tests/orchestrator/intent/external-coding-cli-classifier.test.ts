/**
 * External Coding CLI intent classifier — behavior tests.
 *
 * Verifies that NL "ask Claude Code CLI" requests in Thai and English are
 * classified as `agentic-workflow` external delegations, NOT shell_exec
 * commands. The shell metacharacter parser is intentionally strict; the
 * fix is in the routing layer, not the policy layer.
 */
import { describe, expect, it } from 'bun:test';
import { classifyExternalCodingCliIntent } from '../../../src/orchestrator/intent/external-coding-cli-classifier.ts';
import { parseShellCommand } from '../../../src/orchestrator/tools/shell-command-parser.ts';
import { evaluateCommand } from '../../../src/orchestrator/tools/shell-policy.ts';

describe('classifyExternalCodingCliIntent — positive matches', () => {
  it('matches the original failure case (Thai sai-ngan + backticked path)', () => {
    const out = classifyExternalCodingCliIntent(
      'สั่งงาน claude code cli ช่วยรัน verify flow เปิดบัญชีกองทุน `/Users/phumin.k/appl/Docs/s1_design_spec`',
    );
    expect(out.matched).toBe(true);
    expect(out.providerId).toBe('claude-code');
    expect(out.confidence).toBeGreaterThanOrEqual(0.85);
    expect(out.targetPaths).toContain('/Users/phumin.k/appl/Docs/s1_design_spec');
    expect(out.cwd).toBe('/Users/phumin.k/appl/Docs/s1_design_spec');
    // task text should NOT include the provider phrase
    expect(out.taskText.toLowerCase()).not.toContain('claude code cli');
    expect(out.taskText).toContain('verify flow');
  });

  it('matches English "delegate to Claude Code"', () => {
    const out = classifyExternalCodingCliIntent(
      'delegate to claude code cli to refactor src/foo.ts',
    );
    expect(out.matched).toBe(true);
    expect(out.providerId).toBe('claude-code');
    expect(out.confidence).toBeGreaterThanOrEqual(0.85);
    expect(out.taskText).toContain('refactor');
  });

  it('matches "ใช้ claude code ทำ X"', () => {
    const out = classifyExternalCodingCliIntent('ใช้ claude code ทำ unit test ให้หน่อย');
    expect(out.matched).toBe(true);
    expect(out.providerId).toBe('claude-code');
  });

  it('matches "ask claude code to run tests"', () => {
    const out = classifyExternalCodingCliIntent('ask claude code to run the tests');
    expect(out.matched).toBe(true);
    expect(out.providerId).toBe('claude-code');
  });

  it('detects gh copilot delegation', () => {
    const out = classifyExternalCodingCliIntent('use gh copilot to suggest a fix for build error');
    expect(out.matched).toBe(true);
    expect(out.providerId).toBe('github-copilot');
  });

  it('returns auto-provider for generic "external coding cli" mention', () => {
    const out = classifyExternalCodingCliIntent(
      'ลองใช้ external coding cli ช่วยอ่าน /tmp/spec.md',
    );
    expect(out.matched).toBe(true);
    expect(out.providerId).toBe('auto');
    expect(out.targetPaths).toContain('/tmp/spec.md');
  });

  it('detects interactive mode hint', () => {
    const out = classifyExternalCodingCliIntent(
      'use claude code in interactive mode to review my code',
    );
    expect(out.matched).toBe(true);
    expect(out.requestedMode).toBe('interactive');
  });

  it('detects headless mode hint', () => {
    const out = classifyExternalCodingCliIntent(
      'run claude code one-shot to generate a README',
    );
    expect(out.matched).toBe(true);
    expect(out.requestedMode).toBe('headless');
  });

  it('extracts multiple paths', () => {
    const out = classifyExternalCodingCliIntent(
      'ask claude code to compare `/a/b.ts` and `/a/c.ts`',
    );
    expect(out.matched).toBe(true);
    expect(out.targetPaths).toContain('/a/b.ts');
    expect(out.targetPaths).toContain('/a/c.ts');
  });
});

describe('classifyExternalCodingCliIntent — negative matches (suppressions)', () => {
  it('does NOT match conversational inquiry "what is Claude Code?"', () => {
    const out = classifyExternalCodingCliIntent('what is claude code?');
    expect(out.matched).toBe(false);
  });

  it('does NOT match Thai inquiry "claude code cli คืออะไร"', () => {
    const out = classifyExternalCodingCliIntent('claude code cli คืออะไร');
    expect(out.matched).toBe(false);
  });

  it('does NOT match "explain claude code"', () => {
    const out = classifyExternalCodingCliIntent('explain claude code');
    expect(out.matched).toBe(false);
  });

  it('does NOT match a generic shell command without a provider name', () => {
    const out = classifyExternalCodingCliIntent('ls -la /tmp');
    expect(out.matched).toBe(false);
  });

  it('does NOT match the bedtime-story request', () => {
    const out = classifyExternalCodingCliIntent('ช่วยเขียนนิยายก่อนนอนให้สัก 2 บท');
    expect(out.matched).toBe(false);
  });

  it('does NOT match a bare "claude" mention without delegation verb', () => {
    // No delegation verb in this English sentence.
    const out = classifyExternalCodingCliIntent('claude is a useful tool for engineers');
    expect(out.matched).toBe(false);
  });
});

describe('shell-policy contract preservation — A6', () => {
  it('still rejects an actual shell command containing backticks', () => {
    // The shell-policy must remain strict for genuine shell commands.
    // The fix is at the routing layer; this is a regression guard for
    // the policy layer.
    const cmd = 'echo `whoami`';
    const parsed = parseShellCommand(cmd);
    expect(parsed.hasMetacharacters).toBe(true);
    const policy = evaluateCommand(parsed);
    expect(policy.allowed).toBe(false);
    expect(policy.reason).toContain('dangerous metacharacter');
  });

  it('still rejects pipes / redirects', () => {
    const parsed = parseShellCommand('cat /etc/passwd | head -5');
    expect(parsed.hasMetacharacters).toBe(true);
    expect(evaluateCommand(parsed).allowed).toBe(false);
  });
});

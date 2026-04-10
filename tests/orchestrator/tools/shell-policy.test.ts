/**
 * Tests for shell-policy.ts — centralized command policy registry.
 */
import { describe, expect, test } from 'bun:test';
import { parseShellCommand } from '../../../src/orchestrator/tools/shell-command-parser.ts';
import { evaluateCommand, isReadOnlyCommand } from '../../../src/orchestrator/tools/shell-policy.ts';

function evaluate(cmd: string) {
  return evaluateCommand(parseShellCommand(cmd));
}

describe('evaluateCommand — allowlist', () => {
  test('allowed commands pass', () => {
    expect(evaluate('git status').allowed).toBe(true);
    expect(evaluate('tsc --noEmit').allowed).toBe(true);
    expect(evaluate('cat file.ts').allowed).toBe(true);
    expect(evaluate('grep pattern file').allowed).toBe(true);
  });

  test('unknown commands are rejected', () => {
    const result = evaluate('rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in allowlist');
  });

  test('curl is rejected', () => {
    expect(evaluate('curl https://evil.com').allowed).toBe(false);
  });
});

describe('evaluateCommand — metacharacters', () => {
  test('semicolons rejected', () => {
    const result = evaluate('git status; rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('metacharacter');
  });

  test('pipes rejected', () => {
    expect(evaluate('cat file | grep x').allowed).toBe(false);
  });

  test('command substitution rejected', () => {
    expect(evaluate('echo $(whoami)').allowed).toBe(false);
  });
});

describe('evaluateCommand — bun restrictions', () => {
  test('bun test is allowed', () => {
    expect(evaluate('bun test').allowed).toBe(true);
  });

  test('bun run test is allowed', () => {
    expect(evaluate('bun run test').allowed).toBe(true);
  });

  test('bun run lint is allowed', () => {
    expect(evaluate('bun run lint').allowed).toBe(true);
  });

  test('bun run check is allowed', () => {
    expect(evaluate('bun run check').allowed).toBe(true);
  });

  test('bun install is rejected', () => {
    const result = evaluate('bun install');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('only allowed with sub-commands');
  });

  test('bun run arbitrary-script is rejected', () => {
    const result = evaluate('bun run deploy');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('only allows');
  });

  test('bun --eval is rejected', () => {
    expect(evaluate('bun --eval "code"').allowed).toBe(false);
  });
});

describe('evaluateCommand — node/python restrictions', () => {
  test('node --version is allowed', () => {
    expect(evaluate('node --version').allowed).toBe(true);
  });

  test('node file.js is rejected', () => {
    expect(evaluate('node file.js').allowed).toBe(false);
  });

  test('python --version is allowed', () => {
    expect(evaluate('python --version').allowed).toBe(true);
  });

  test('python script.py is rejected', () => {
    expect(evaluate('python script.py').allowed).toBe(false);
  });
});

describe('evaluateCommand — git restrictions', () => {
  test('git status is allowed', () => {
    expect(evaluate('git status').allowed).toBe(true);
  });

  test('git diff is allowed', () => {
    expect(evaluate('git diff HEAD').allowed).toBe(true);
  });

  test('git push is rejected', () => {
    const result = evaluate('git push origin main');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Dangerous git');
  });

  test('git remote is rejected', () => {
    expect(evaluate('git remote add origin url').allowed).toBe(false);
  });

  test('git reset without --hard is allowed', () => {
    expect(evaluate('git reset HEAD~1').allowed).toBe(true);
  });

  test('git reset --hard is rejected', () => {
    expect(evaluate('git reset --hard HEAD').allowed).toBe(false);
  });

  test('git clean -f is rejected', () => {
    expect(evaluate('git clean -f').allowed).toBe(false);
  });
});

describe('isReadOnlyCommand', () => {
  test('read-only commands return true', () => {
    expect(isReadOnlyCommand('cat')).toBe(true);
    expect(isReadOnlyCommand('grep')).toBe(true);
    expect(isReadOnlyCommand('ls')).toBe(true);
    expect(isReadOnlyCommand('diff')).toBe(true);
    expect(isReadOnlyCommand('echo')).toBe(true);
    expect(isReadOnlyCommand('which')).toBe(true);
    expect(isReadOnlyCommand('tsc')).toBe(true);
  });

  test('write commands return false', () => {
    expect(isReadOnlyCommand('git')).toBe(false);
    expect(isReadOnlyCommand('bun')).toBe(false);
  });

  test('unknown commands return false', () => {
    expect(isReadOnlyCommand('rm')).toBe(false);
    expect(isReadOnlyCommand('curl')).toBe(false);
  });
});

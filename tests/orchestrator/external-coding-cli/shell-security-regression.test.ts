/**
 * Shell-security regression — the External Coding CLI fix MUST NOT relax
 * shell metacharacter policy.
 *
 * Two invariants:
 *   1. Real shell commands containing backticks / pipes / `$()` / `;` /
 *      redirects MUST still be rejected by `evaluateCommand` with the
 *      "dangerous metacharacter" reason. The fix is a routing change
 *      upstream of shell_exec — the shell layer itself is unchanged.
 *   2. Filesystem-inspect intents that DON'T mention an external coding
 *      CLI provider must still be classified as `direct-tool` shell_exec
 *      and produce a safe `ls`/`cat` command.
 */
import { describe, expect, test } from 'bun:test';
import { classifyDirectTool } from '../../../src/orchestrator/tools/direct-tool-resolver.ts';
import { parseShellCommand } from '../../../src/orchestrator/tools/shell-command-parser.ts';
import { evaluateCommand } from '../../../src/orchestrator/tools/shell-policy.ts';
import { classifyExternalCodingCliIntent } from '../../../src/orchestrator/intent/external-coding-cli-classifier.ts';

describe('shell-policy regression — metacharacters STILL rejected after ECC fix', () => {
  test.each([
    ['echo `whoami`', 'backtick command substitution'],
    ['ls | grep foo', 'pipe'],
    ['cat $(pwd)', 'dollar-paren command substitution'],
    ['git status; rm -rf /', 'semicolon chain'],
    ['cat file > /tmp/out', 'redirect'],
    ['cat < /etc/passwd', 'reverse redirect'],
    ['true && rm file', 'AND chain'],
    ['false || rm file', 'OR chain'],
    ['echo {a,b,c}', 'brace expansion'],
    ['echo ${VAR}', 'parameter expansion'],
  ])('rejects "%s" (%s)', (cmd, _label) => {
    const verdict = evaluateCommand(parseShellCommand(cmd));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('metacharacter');
  });
});

describe('direct-tool fallback — filesystem-inspect WITHOUT provider mention', () => {
  test('Thai "ดูไฟล์ใน /tmp" routes to direct-tool ls (NOT ECC)', () => {
    // No coding-cli provider mention → ECC classifier MUST decline.
    const cli = classifyExternalCodingCliIntent('ดูไฟล์ใน /tmp/foo');
    expect(cli.matched).toBe(false);
    // Direct-tool classifier should produce a safe ls command.
    const dt = classifyDirectTool('ดูไฟล์ใน /tmp/foo');
    expect(dt).not.toBeNull();
    expect(dt?.type).toBe('shell_exec');
    expect(dt?.command).toContain('ls -la');
    expect(dt?.command).toContain('/tmp/foo');
    // And the resulting command must be allowed by shell-policy.
    if (dt?.command) {
      expect(evaluateCommand(parseShellCommand(dt.command)).allowed).toBe(true);
    }
  });

  test('English "list /tmp/foo" routes to direct-tool ls (NOT ECC)', () => {
    const cli = classifyExternalCodingCliIntent('list /tmp/foo');
    expect(cli.matched).toBe(false);
    const dt = classifyDirectTool('list /tmp/foo');
    expect(dt?.type).toBe('shell_exec');
    expect(dt?.command).toContain('ls -la');
  });

  test('"cat /tmp/foo.txt" routes to direct-tool cat (NOT ECC)', () => {
    const cli = classifyExternalCodingCliIntent('cat /tmp/foo.txt');
    expect(cli.matched).toBe(false);
    const dt = classifyDirectTool('cat /tmp/foo.txt');
    expect(dt?.type).toBe('shell_exec');
    expect(dt?.command).toContain('cat');
    expect(dt?.command).toContain('/tmp/foo.txt');
  });
});

describe('app-launch fallback — direct-tool behaviour preserved', () => {
  test('Thai "เปิดแอพ chrome" still classifies as app_launch (NOT ECC)', () => {
    const cli = classifyExternalCodingCliIntent('เปิดแอพ chrome');
    expect(cli.matched).toBe(false);
    const dt = classifyDirectTool('เปิดแอพ chrome');
    expect(dt?.type).toBe('app_launch');
    expect(dt?.target).toBe('chrome');
  });

  test('English "open vscode" still classifies as app_launch (NOT ECC)', () => {
    const cli = classifyExternalCodingCliIntent('open vscode');
    expect(cli.matched).toBe(false);
    const dt = classifyDirectTool('open vscode');
    expect(dt?.type).toBe('app_launch');
    expect(dt?.target).toBe('vscode');
  });

  test('URL open still classifies as url_open (NOT ECC)', () => {
    const cli = classifyExternalCodingCliIntent('open https://example.com');
    expect(cli.matched).toBe(false);
    const dt = classifyDirectTool('open https://example.com');
    expect(dt?.type).toBe('url_open');
  });
});

describe('ECC classifier — does NOT match generic shell intents', () => {
  test('"run ls -la" without provider mention does not trigger ECC', () => {
    const cli = classifyExternalCodingCliIntent('run ls -la /tmp');
    expect(cli.matched).toBe(false);
  });

  test('"ช่วยรัน verify flow" without provider mention does not trigger ECC', () => {
    const cli = classifyExternalCodingCliIntent(
      'ช่วยรัน verify flow `/tmp/spec`',
    );
    // Has a backticked path AND a delegation-shaped verb — but no provider
    // mention. ECC must decline; the prompt then routes through normal
    // resolution (which would either ask for clarification or surface
    // shell-policy rejection if it lands on shell_exec).
    expect(cli.matched).toBe(false);
  });
});

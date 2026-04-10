/**
 * Tests for shell-command-parser.ts — structured shell tokenizer.
 */
import { describe, expect, test } from 'bun:test';
import { parseShellCommand } from '../../../src/orchestrator/tools/shell-command-parser.ts';

describe('parseShellCommand', () => {
  test('basic command', () => {
    const parsed = parseShellCommand('git status');
    expect(parsed.executable).toBe('git');
    expect(parsed.subcommand).toBe('status');
    expect(parsed.args).toEqual([]);
    expect(parsed.hasMetacharacters).toBe(false);
  });

  test('command with args', () => {
    const parsed = parseShellCommand('git commit -m "message"');
    expect(parsed.executable).toBe('git');
    expect(parsed.subcommand).toBe('commit');
    expect(parsed.args).toEqual(['-m', '"message"']);
  });

  test('single command (no subcommand)', () => {
    const parsed = parseShellCommand('ls');
    expect(parsed.executable).toBe('ls');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.args).toEqual([]);
  });

  test('leading/trailing whitespace', () => {
    const parsed = parseShellCommand('  git status  ');
    expect(parsed.executable).toBe('git');
    expect(parsed.subcommand).toBe('status');
  });

  test('tabs between tokens', () => {
    const parsed = parseShellCommand('git\tstatus');
    expect(parsed.executable).toBe('git');
    expect(parsed.subcommand).toBe('status');
  });

  test('multiple spaces between tokens', () => {
    const parsed = parseShellCommand('git    status   --short');
    expect(parsed.executable).toBe('git');
    expect(parsed.subcommand).toBe('status');
    expect(parsed.args).toEqual(['--short']);
  });

  test('detects semicolon metacharacter', () => {
    const parsed = parseShellCommand('git status; rm -rf /');
    expect(parsed.hasMetacharacters).toBe(true);
  });

  test('detects pipe metacharacter', () => {
    const parsed = parseShellCommand('cat file | grep pattern');
    expect(parsed.hasMetacharacters).toBe(true);
  });

  test('detects command substitution ($)', () => {
    const parsed = parseShellCommand('echo $(whoami)');
    expect(parsed.hasMetacharacters).toBe(true);
  });

  test('detects backtick substitution', () => {
    const parsed = parseShellCommand('echo `whoami`');
    expect(parsed.hasMetacharacters).toBe(true);
  });

  test('detects newline injection', () => {
    const parsed = parseShellCommand('git status\nrm -rf /');
    expect(parsed.hasMetacharacters).toBe(true);
  });

  test('detects backslash escape', () => {
    const parsed = parseShellCommand('git status\\nrm -rf /');
    expect(parsed.hasMetacharacters).toBe(true);
  });

  test('safe command has no metacharacters', () => {
    const parsed = parseShellCommand('bun run test');
    expect(parsed.hasMetacharacters).toBe(false);
  });

  test('empty string', () => {
    const parsed = parseShellCommand('');
    expect(parsed.executable).toBe('');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.args).toEqual([]);
  });

  test('preserves raw input', () => {
    const raw = '  git  status  --short  ';
    const parsed = parseShellCommand(raw);
    expect(parsed.raw).toBe(raw);
  });
});

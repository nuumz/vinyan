/**
 * Phase 7d-2: Tests for slash-command expander. Covers: recognition,
 * argument substitution, unknown command handling, non-command
 * passthrough, edge cases in whitespace/casing.
 */

import { describe, expect, test } from 'bun:test';
import { expandSlashCommand } from '../../../src/orchestrator/commands/command-expander.ts';
import type { SlashCommandRegistry } from '../../../src/orchestrator/commands/command-loader.ts';
import type { SlashCommand } from '../../../src/orchestrator/commands/command-schema.ts';

function registry(cmds: SlashCommand[]): SlashCommandRegistry {
  const map = new Map<string, SlashCommand>();
  for (const c of cmds) map.set(c.name, c);
  return { commands: map, errors: [] };
}

function cmd(name: string, body: string, description = ''): SlashCommand {
  return { name, description, argumentHint: '', body };
}

describe('expandSlashCommand', () => {
  test('non-slash message → not_a_command', () => {
    const reg = registry([cmd('commit', 'Please commit')]);
    const result = expandSlashCommand('hello world', reg);
    expect(result.kind).toBe('not_a_command');
  });

  test('empty message → not_a_command', () => {
    const reg = registry([cmd('commit', 'Please commit')]);
    const result = expandSlashCommand('', reg);
    expect(result.kind).toBe('not_a_command');
  });

  test('bare slash → not_a_command', () => {
    const reg = registry([cmd('commit', 'Please commit')]);
    const result = expandSlashCommand('/', reg);
    expect(result.kind).toBe('not_a_command');
  });

  test('known command with no args expands body unchanged if no placeholder', () => {
    const reg = registry([cmd('commit', 'Please commit the staged changes.')]);
    const result = expandSlashCommand('/commit', reg);
    expect(result.kind).toBe('expanded');
    if (result.kind === 'expanded') {
      expect(result.name).toBe('commit');
      expect(result.prompt).toBe('Please commit the staged changes.');
      expect(result.args).toBe('');
    }
  });

  test('known command substitutes $ARGUMENTS with trailing text', () => {
    const reg = registry([cmd('commit', 'Please commit. Scope: $ARGUMENTS')]);
    const result = expandSlashCommand('/commit docs typo', reg);
    expect(result.kind).toBe('expanded');
    if (result.kind === 'expanded') {
      expect(result.prompt).toBe('Please commit. Scope: docs typo');
      expect(result.args).toBe('docs typo');
    }
  });

  test('$ARGUMENTS appearing multiple times is replaced everywhere', () => {
    const reg = registry([cmd('label', 'Label: $ARGUMENTS / Also: $ARGUMENTS')]);
    const result = expandSlashCommand('/label important', reg);
    expect(result.kind).toBe('expanded');
    if (result.kind === 'expanded') {
      expect(result.prompt).toBe('Label: important / Also: important');
    }
  });

  test('$ARGUMENTS with no args substitutes empty string', () => {
    const reg = registry([cmd('commit', 'Scope: $ARGUMENTS done')]);
    const result = expandSlashCommand('/commit', reg);
    expect(result.kind).toBe('expanded');
    if (result.kind === 'expanded') {
      expect(result.prompt).toBe('Scope:  done');
    }
  });

  test('unknown command → unknown_command with the attempted name', () => {
    const reg = registry([cmd('commit', 'body')]);
    const result = expandSlashCommand('/nope extra args', reg);
    expect(result.kind).toBe('unknown_command');
    if (result.kind === 'unknown_command') {
      expect(result.name).toBe('nope');
    }
  });

  test('case-insensitive command lookup', () => {
    const reg = registry([cmd('commit', 'body')]);
    const result = expandSlashCommand('/COMMIT', reg);
    expect(result.kind).toBe('expanded');
  });

  test('leading/trailing whitespace around message is ignored', () => {
    const reg = registry([cmd('commit', 'Args: $ARGUMENTS')]);
    const result = expandSlashCommand('   /commit   foo   ', reg);
    expect(result.kind).toBe('expanded');
    if (result.kind === 'expanded') {
      expect(result.prompt).toBe('Args: foo');
    }
  });

  test('command with multi-word args preserves internal spaces', () => {
    const reg = registry([cmd('note', 'Note: $ARGUMENTS')]);
    const result = expandSlashCommand('/note fix the auth bug', reg);
    expect(result.kind).toBe('expanded');
    if (result.kind === 'expanded') {
      expect(result.args).toBe('fix the auth bug');
      expect(result.prompt).toBe('Note: fix the auth bug');
    }
  });

  test('empty registry → unknown_command for any slash input', () => {
    const reg = registry([]);
    const result = expandSlashCommand('/commit', reg);
    expect(result.kind).toBe('unknown_command');
  });
});

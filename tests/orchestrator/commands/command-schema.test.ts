/**
 * Phase 7d-2: Tests for slash-command schema + frontmatter parser.
 * Covers: file with and without frontmatter, empty body rejection,
 * malformed frontmatter, name validation, quoted values, comments.
 */

import { describe, expect, test } from 'bun:test';
import { parseSlashCommand, SlashCommandSchema } from '../../../src/orchestrator/commands/command-schema.ts';

describe('parseSlashCommand', () => {
  test('file with frontmatter and body parses cleanly', () => {
    const raw = `---
description: Create a conventional git commit
argumentHint: [scope]
---
Please create a git commit. Scope: $ARGUMENTS
`;
    const cmd = parseSlashCommand('commit', raw);
    expect(cmd.name).toBe('commit');
    expect(cmd.description).toBe('Create a conventional git commit');
    expect(cmd.argumentHint).toBe('[scope]');
    expect(cmd.body).toContain('$ARGUMENTS');
  });

  test('file with no frontmatter uses whole text as body', () => {
    const raw = 'Just a prompt body, no frontmatter here.\nLine two.';
    const cmd = parseSlashCommand('plain', raw);
    expect(cmd.description).toBe('');
    expect(cmd.argumentHint).toBe('');
    expect(cmd.body).toBe('Just a prompt body, no frontmatter here.\nLine two.');
  });

  test('empty body is rejected', () => {
    const raw = `---
description: Empty command
---

`;
    expect(() => parseSlashCommand('empty', raw)).toThrow();
  });

  test('frontmatter with quoted values strips quotes', () => {
    const raw = `---
description: "A command with: a colon in quotes"
---
body here
`;
    const cmd = parseSlashCommand('quoted', raw);
    expect(cmd.description).toBe('A command with: a colon in quotes');
  });

  test('frontmatter comments (lines starting with #) are ignored', () => {
    const raw = `---
# this is a comment
description: Real description
# another comment
---
body
`;
    const cmd = parseSlashCommand('commented', raw);
    expect(cmd.description).toBe('Real description');
  });

  test('frontmatter supports argument-hint (dashed) as alias for argumentHint', () => {
    const raw = `---
argument-hint: <pr-number>
---
body
`;
    const cmd = parseSlashCommand('aliased', raw);
    expect(cmd.argumentHint).toBe('<pr-number>');
  });

  test('frontmatter line without colon throws', () => {
    const raw = `---
this is not valid
---
body
`;
    expect(() => parseSlashCommand('bad', raw)).toThrow(/missing ':'/);
  });

  test('CRLF line endings are handled', () => {
    const raw = '---\r\ndescription: Windows file\r\n---\r\nbody line\r\n';
    const cmd = parseSlashCommand('crlf', raw);
    expect(cmd.description).toBe('Windows file');
    expect(cmd.body).toContain('body line');
  });

  test('name must be lowercase alphanumeric with -/_', () => {
    expect(() => SlashCommandSchema.parse({ name: 'BadName', body: 'x' })).toThrow();
    expect(() => SlashCommandSchema.parse({ name: '1starts-with-digit', body: 'x' })).toThrow();
    expect(() => SlashCommandSchema.parse({ name: 'has space', body: 'x' })).toThrow();
    expect(() => SlashCommandSchema.parse({ name: 'ok_name-1', body: 'x' })).not.toThrow();
  });

  test('file with only frontmatter (no body) is rejected', () => {
    const raw = `---
description: No body at all
---`;
    expect(() => parseSlashCommand('nobody', raw)).toThrow();
  });

  test('--- that is not at the start of file is part of body', () => {
    const raw = 'Leading text\n---\ndescription: fake\n---\nbody';
    const cmd = parseSlashCommand('notfront', raw);
    // Should treat the whole thing as body.
    expect(cmd.description).toBe('');
    expect(cmd.body).toContain('Leading text');
    expect(cmd.body).toContain('description: fake');
  });
});

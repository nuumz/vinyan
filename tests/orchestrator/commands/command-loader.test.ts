/**
 * Phase 7d-2: Tests for slash-command loader. Covers directory
 * discovery, case-insensitive names, skip-on-bad-file, per-workspace
 * caching.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearSlashCommandCache, loadSlashCommands } from '../../../src/orchestrator/commands/command-loader.ts';

function writeCommand(workspace: string, filename: string, content: string): void {
  const dir = join(workspace, '.vinyan', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

describe('loadSlashCommands', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-cmd-loader-'));
    clearSlashCommandCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearSlashCommandCache();
  });

  test('missing .vinyan/commands directory → empty registry', () => {
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(0);
    expect(reg.errors).toEqual([]);
  });

  test('empty .vinyan/commands directory → empty registry', () => {
    mkdirSync(join(tempDir, '.vinyan', 'commands'), { recursive: true });
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(0);
  });

  test('loads a single valid command', () => {
    writeCommand(
      tempDir,
      'commit.md',
      `---
description: Create a commit
---
Please create a git commit. Args: $ARGUMENTS
`,
    );
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(1);
    const commit = reg.commands.get('commit');
    expect(commit).toBeDefined();
    expect(commit!.description).toBe('Create a commit');
    expect(commit!.body).toContain('$ARGUMENTS');
  });

  test('loads multiple commands', () => {
    writeCommand(tempDir, 'commit.md', 'Commit body');
    writeCommand(tempDir, 'review.md', 'Review body');
    writeCommand(tempDir, 'plan.md', 'Plan body');
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(3);
    expect(reg.commands.has('commit')).toBe(true);
    expect(reg.commands.has('review')).toBe(true);
    expect(reg.commands.has('plan')).toBe(true);
  });

  test('non-.md files are ignored', () => {
    writeCommand(tempDir, 'commit.md', 'Commit body');
    writeCommand(tempDir, 'README.txt', 'ignored');
    writeCommand(tempDir, 'notes', 'ignored');
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(1);
    expect(reg.commands.has('commit')).toBe(true);
  });

  test('filenames are lowercased', () => {
    writeCommand(tempDir, 'Commit.md', 'Body');
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.has('commit')).toBe(true);
  });

  test('bad file is skipped and recorded in errors, good files still load', () => {
    writeCommand(tempDir, 'good.md', 'Good body');
    writeCommand(
      tempDir,
      'bad.md',
      `---
this is not a valid frontmatter line
---
body
`,
    );
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(1);
    expect(reg.commands.has('good')).toBe(true);
    expect(reg.errors).toHaveLength(1);
    expect(reg.errors[0]!.file).toBe('bad.md');
  });

  test('empty body command is recorded as error', () => {
    writeCommand(tempDir, 'empty.md', '---\ndescription: empty\n---\n');
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.size).toBe(0);
    expect(reg.errors).toHaveLength(1);
    expect(reg.errors[0]!.file).toBe('empty.md');
  });

  test('registry is cached per workspace', () => {
    writeCommand(tempDir, 'a.md', 'First body');
    const first = loadSlashCommands(tempDir);
    // Overwrite — cached registry should not reflect the change.
    writeCommand(tempDir, 'a.md', 'Second body');
    const second = loadSlashCommands(tempDir);
    expect(second.commands.get('a')!.body).toBe('First body');
    expect(first).toBe(second);
  });

  test('clearSlashCommandCache forces a reload', () => {
    writeCommand(tempDir, 'a.md', 'First body');
    loadSlashCommands(tempDir);
    writeCommand(tempDir, 'a.md', 'Second body');
    clearSlashCommandCache();
    const reg = loadSlashCommands(tempDir);
    expect(reg.commands.get('a')!.body).toBe('Second body');
  });
});

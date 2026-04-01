import { describe, expect, test } from 'bun:test';
import { isMutatingTool } from '../../src/gate/tool-classifier.ts';

describe('isMutatingTool', () => {
  test('known mutating tools → true', () => {
    const mutating = [
      'write_file',
      'create_file',
      'replace_in_file',
      'insert_in_file',
      'delete_file',
      'rename_file',
      'run_terminal_command',
      'apply_diff',
    ];
    for (const tool of mutating) {
      expect(isMutatingTool(tool)).toBe(true);
    }
  });

  test('known read-only tools → false', () => {
    const readonly = ['read_file', 'search_files', 'list_directory', 'grep_search', 'get_diagnostics'];
    for (const tool of readonly) {
      expect(isMutatingTool(tool)).toBe(false);
    }
  });

  test('unknown tool → true (A6 conservative)', () => {
    expect(isMutatingTool('some_new_tool')).toBe(true);
    expect(isMutatingTool('')).toBe(true);
  });
});

import { describe, expect, test } from 'bun:test';
import { classifyMutation } from '../../../src/oracle/commonsense/mutation-classifier.ts';
import {
  extractApplicationContext,
  selectMicrotheory,
} from '../../../src/oracle/commonsense/microtheory-selector.ts';
import type { HypothesisTuple } from '../../../src/core/types.ts';

describe('classifyMutation', () => {
  test('read-only tools', () => {
    expect(classifyMutation('read_file')).toBe('read-only');
    expect(classifyMutation('list_files')).toBe('read-only');
    expect(classifyMutation('grep')).toBe('read-only');
    expect(classifyMutation('GREP')).toBe('read-only'); // case-insensitive
  });

  test('destructive tools', () => {
    expect(classifyMutation('delete_file')).toBe('mutation-destructive');
    expect(classifyMutation('rm')).toBe('mutation-destructive');
    expect(classifyMutation('truncate')).toBe('mutation-destructive');
  });

  test('additive tools', () => {
    expect(classifyMutation('write_file')).toBe('mutation-additive');
    expect(classifyMutation('edit_file')).toBe('mutation-additive');
    expect(classifyMutation('create_file')).toBe('mutation-additive');
  });

  test('shell / unknown tools → universal (action depends on args)', () => {
    expect(classifyMutation('bash')).toBe('universal');
    expect(classifyMutation('execute_command')).toBe('universal');
    expect(classifyMutation('mystery_tool')).toBe('universal');
  });

  test('extracts first token from full command line', () => {
    expect(classifyMutation('rm -rf /tmp')).toBe('mutation-destructive');
    expect(classifyMutation('write_file src/foo.ts')).toBe('mutation-additive');
    expect(classifyMutation('git push --force')).toBe('universal'); // git not classified
  });

  test('empty/null tool → universal', () => {
    expect(classifyMutation('')).toBe('universal');
    expect(classifyMutation(undefined)).toBe('universal');
    expect(classifyMutation(null)).toBe('universal');
  });
});

describe('extractApplicationContext', () => {
  function makeHypothesis(overrides: Partial<HypothesisTuple> = {}): HypothesisTuple {
    return {
      target: 'src/foo.ts',
      pattern: 'commonsense-check',
      workspace: '/tmp/ws',
      context: {},
      ...overrides,
    };
  }

  test('extracts target as path and derives extension', () => {
    const ctx = extractApplicationContext(makeHypothesis({ target: 'src/auth.ts' }));
    expect(ctx.path).toBe('src/auth.ts');
    expect(ctx.file_extension).toBe('ts');
  });

  test('extracts tool from context', () => {
    const ctx = extractApplicationContext(
      makeHypothesis({ context: { tool: 'edit_file' } }),
    );
    expect(ctx.command).toBe('edit_file');
  });

  test('extracts verb from understanding.actionVerb', () => {
    const ctx = extractApplicationContext(
      makeHypothesis({
        context: { understanding: { actionVerb: 'add' } },
      }),
    );
    expect(ctx.verb).toBe('add');
  });

  test('handles missing fields gracefully', () => {
    const ctx = extractApplicationContext({
      target: '',
      pattern: 'x',
      workspace: '/tmp/w',
    });
    expect(ctx.path).toBeUndefined();
    expect(ctx.command).toBeUndefined();
    expect(ctx.verb).toBeUndefined();
    expect(ctx.file_extension).toBeUndefined();
  });

  test('extracts compound TypeScript extensions', () => {
    expect(
      extractApplicationContext(makeHypothesis({ target: 'src/foo.tsx' })).file_extension,
    ).toBe('tsx');
    expect(
      extractApplicationContext(makeHypothesis({ target: 'src/foo.mts' })).file_extension,
    ).toBe('mts');
  });
});

describe('selectMicrotheory — language axis', () => {
  test('TypeScript files → typescript-strict', () => {
    expect(selectMicrotheory({ file_extension: 'ts' }).language).toBe('typescript-strict');
    expect(selectMicrotheory({ file_extension: 'tsx' }).language).toBe('typescript-strict');
  });

  test('Python files → python-typed', () => {
    expect(selectMicrotheory({ file_extension: 'py' }).language).toBe('python-typed');
  });

  test('shell files', () => {
    expect(selectMicrotheory({ file_extension: 'sh' }).language).toBe('shell-bash');
    expect(selectMicrotheory({ file_extension: 'bash' }).language).toBe('shell-bash');
    expect(selectMicrotheory({ file_extension: 'zsh' }).language).toBe('shell-zsh');
  });

  test('unknown / missing extension → universal', () => {
    expect(selectMicrotheory({ file_extension: 'unknown' }).language).toBe('universal');
    expect(selectMicrotheory({}).language).toBe('universal');
  });
});

describe('selectMicrotheory — domain axis', () => {
  test('paths inside .git/ → git-workflow', () => {
    expect(selectMicrotheory({ path: 'project/.git/config' }).domain).toBe('git-workflow');
  });

  test('terraform paths → infra-terraform', () => {
    expect(selectMicrotheory({ path: 'infra/main.tf' }).domain).toBe('infra-terraform');
    expect(selectMicrotheory({ path: 'terraform/cluster.tf' }).domain).toBe('infra-terraform');
  });

  test('migration paths → data-pipeline', () => {
    expect(selectMicrotheory({ path: 'src/db/migrations/_squashed/010_x.ts' }).domain).toBe(
      'data-pipeline',
    );
  });

  test('REST/api paths → web-rest', () => {
    expect(selectMicrotheory({ path: 'src/api/users.ts' }).domain).toBe('web-rest');
    expect(selectMicrotheory({ path: 'app/routes/index.ts' }).domain).toBe('web-rest');
  });

  test('git command → git-workflow', () => {
    expect(selectMicrotheory({ command: 'git push --force' }).domain).toBe('git-workflow');
  });

  test('plain file path → filesystem (catch-all)', () => {
    expect(selectMicrotheory({ path: 'README.md' }).domain).toBe('filesystem');
  });

  test('no path no command → universal', () => {
    expect(selectMicrotheory({}).domain).toBe('universal');
  });
});

describe('selectMicrotheory — three-axis composition', () => {
  test('full TS-strict / filesystem / additive', () => {
    const m = selectMicrotheory({
      file_extension: 'ts',
      path: 'src/foo.ts',
      command: 'write_file',
    });
    expect(m).toEqual({
      language: 'typescript-strict',
      domain: 'filesystem',
      action: 'mutation-additive',
    });
  });

  test('shell-bash / git-workflow / universal action', () => {
    const m = selectMicrotheory({
      command: 'git push --force',
    });
    // No file extension → language=universal
    expect(m.language).toBe('universal');
    expect(m.domain).toBe('git-workflow');
    // git command's action depends on args → universal (registry pattern eval narrows)
    expect(m.action).toBe('universal');
  });
});

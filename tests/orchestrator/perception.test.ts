import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PerceptionAssemblerImpl } from '../../src/orchestrator/perception.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-perception-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  // Create a small dependency graph: bar imports foo, baz imports bar
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
  writeFileSync(join(tempDir, 'src', 'bar.ts'), 'import { x } from "./foo.ts";\nexport const y = x + 1;\n');
  writeFileSync(join(tempDir, 'src', 'baz.ts'), 'import { y } from "./bar.ts";\nexport const z = y + 1;\n');
  writeFileSync(join(tempDir, 'src', 'bar.test.ts'), 'import { y } from "./bar.ts";\nconsole.log(y);\n');
  writeFileSync(join(tempDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-1',
    source: 'cli',
    goal: 'Fix bug in foo',
    taskType: 'code',
    budget: { maxTokens: 50_000, maxDurationMs: 60_000, maxRetries: 3 },
    ...overrides,
  };
}

describe('PerceptionAssemblerImpl', () => {
  test('no target files → empty dependency cone', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput(), 0);
    expect(result.dependencyCone.directImporters).toEqual([]);
    expect(result.dependencyCone.directImportees).toEqual([]);
    expect(result.dependencyCone.transitiveBlastRadius).toBe(0);
  });

  test('taskTarget reflects input goal and file', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput({ targetFiles: ['src/foo.ts'] }), 1);
    expect(result.taskTarget.file).toBe('src/foo.ts');
    expect(result.taskTarget.description).toBe('Fix bug in foo');
  });

  test('runtime includes node version, os, and available tools', async () => {
    const assembler = new PerceptionAssemblerImpl({
      workspace: tempDir,
      availableTools: ['file_read', 'file_write'],
    });
    const result = await assembler.assemble(makeInput(), 0);
    expect(result.runtime.nodeVersion).toBe(process.version);
    expect(result.runtime.os).toBe(process.platform);
    expect(result.runtime.availableTools).toEqual(['file_read', 'file_write']);
  });

  test('default availableTools includes all 8 built-in tools', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput(), 0);
    expect(result.runtime.availableTools).toHaveLength(8);
    expect(result.runtime.availableTools).toContain('file_read');
    expect(result.runtime.availableTools).toContain('shell_exec');
  });

  test('with target file → builds dependency cone', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput({ targetFiles: ['src/foo.ts'] }), 1);
    // bar.ts imports foo.ts → bar is a direct importer of foo
    expect(result.dependencyCone.directImporters).toContain('src/bar.ts');
    expect(result.dependencyCone.transitiveBlastRadius).toBeGreaterThanOrEqual(1);
  });

  test('L0/L1 excludes transitiveImporters and affectedTestFiles', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput({ targetFiles: ['src/foo.ts'] }), 1);
    expect(result.dependencyCone.transitiveImporters).toBeUndefined();
    expect(result.dependencyCone.affectedTestFiles).toBeUndefined();
  });

  test('L2+ includes transitiveImporters and affectedTestFiles', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput({ targetFiles: ['src/foo.ts'] }), 2);
    expect(result.dependencyCone.transitiveImporters).toBeDefined();
    expect(result.dependencyCone.affectedTestFiles).toBeDefined();
    // bar.test.ts imports bar.ts which imports foo.ts → affected test
    expect(result.dependencyCone.affectedTestFiles!.some((f) => f.includes('test'))).toBe(true);
  });

  test('without WorldGraph → verifiedFacts is empty', async () => {
    const assembler = new PerceptionAssemblerImpl({ workspace: tempDir });
    const result = await assembler.assemble(makeInput({ targetFiles: ['src/foo.ts'] }), 1);
    expect(result.verifiedFacts).toEqual([]);
  });
});

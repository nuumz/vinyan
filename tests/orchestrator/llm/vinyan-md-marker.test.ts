/**
 * VINYAN.md / CLAUDE.md memory mechanism — marker test.
 *
 * The hybrid skill redesign plan included a verification step: confirm that
 * project-level user instructions actually reach the LLM prompt. Path traced:
 *
 *   instruction-hierarchy.discoverSources()  ← reads VINYAN.md / CLAUDE.md / etc.
 *     ↓
 *   instruction-loader.loadInstructionMemoryForTask()
 *     ↓
 *   shared-prompt-sections.renderInstructionHierarchy()  ← rendered as markdown
 *     ↓
 *   prompt-section-registry: 'instructions' section
 *     ↓
 *   buildSystemPrompt → LLM
 *
 * This test is the integrity check at the loader → renderer boundary. It
 * doesn't replace the prompt-builder integration test (handled by the existing
 * prompt-section-registry suite) — its job is to give us a fast, focused alarm
 * if a future refactor breaks the path between disk and rendered prompt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderInstructionHierarchy } from '../../../src/orchestrator/llm/shared-prompt-sections.ts';
import {
  clearInstructionCache,
  loadInstructionMemoryForTask,
} from '../../../src/orchestrator/llm/instruction-loader.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-md-marker-'));
  clearInstructionCache();
});

afterEach(() => {
  clearInstructionCache();
  rmSync(workspace, { recursive: true, force: true });
});

describe('VINYAN.md mechanism reaches the LLM prompt', () => {
  test('VINYAN.md content surfaces verbatim in rendered hierarchy', () => {
    const marker = `MEMORY-MARKER-${crypto.randomUUID()}`;
    writeFileSync(join(workspace, 'VINYAN.md'), `# Project rules\n\n${marker}\n`);

    const mem = loadInstructionMemoryForTask({ workspace });
    expect(mem).not.toBeNull();
    const rendered = renderInstructionHierarchy(mem);
    expect(rendered).not.toBeNull();
    expect(rendered).toContain(marker);
    expect(rendered).toContain('[PROJECT INSTRUCTIONS]');
  });

  test('CLAUDE.md content also reaches rendered hierarchy (Claude Code interop)', () => {
    const marker = `CLAUDE-MD-${crypto.randomUUID()}`;
    writeFileSync(join(workspace, 'CLAUDE.md'), `${marker}\n`);

    const mem = loadInstructionMemoryForTask({ workspace });
    const rendered = renderInstructionHierarchy(mem);
    expect(rendered).toContain(marker);
  });

  test('multiple sources concatenate in precedence order', () => {
    const v = `VINYAN-${crypto.randomUUID()}`;
    const c = `CLAUDE-${crypto.randomUUID()}`;
    writeFileSync(join(workspace, 'VINYAN.md'), v);
    writeFileSync(join(workspace, 'CLAUDE.md'), c);

    const mem = loadInstructionMemoryForTask({ workspace });
    const rendered = renderInstructionHierarchy(mem);
    expect(rendered).toContain(v);
    expect(rendered).toContain(c);
    // VINYAN.md is first in PROJECT_TIER_CANDIDATES → should appear before CLAUDE.md
    expect(rendered!.indexOf(v)).toBeLessThan(rendered!.indexOf(c));
  });

  test('scoped rules from .vinyan/rules/ surface in rendered hierarchy', () => {
    mkdirSync(join(workspace, '.vinyan', 'rules'), { recursive: true });
    const ruleMarker = `SCOPED-${crypto.randomUUID()}`;
    writeFileSync(
      join(workspace, '.vinyan', 'rules', 'security.md'),
      `# Security rules\n\n${ruleMarker}\n`,
    );

    const mem = loadInstructionMemoryForTask({ workspace });
    const rendered = renderInstructionHierarchy(mem);
    expect(rendered).toContain(ruleMarker);
  });

  test('empty workspace → null (renderer returns null gracefully)', () => {
    const mem = loadInstructionMemoryForTask({ workspace });
    expect(mem).toBeNull();
    const rendered = renderInstructionHierarchy(mem);
    expect(rendered).toBeNull();
  });
});

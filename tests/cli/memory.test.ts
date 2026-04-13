/**
 * CLI tests for `vinyan memory <list|show|approve|reject>`.
 *
 * Strategy: call the handler functions directly via `runMemoryCommand` and
 * capture console output. `process.exit` is stubbed with a throwing helper
 * so tests can assert on exit codes without the test runner actually exiting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMemoryCommand } from '../../src/cli/memory.ts';
import {
  LEARNED_FILE_REL,
  PENDING_DIR_REL,
  REJECTED_DIR_REL,
  serializeProposal,
  writeProposal,
  type MemoryProposal,
} from '../../src/orchestrator/memory/memory-proposals.ts';

// ── Fixtures ────────────────────────────────────────────────────────

function makeValidProposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    slug: 'prefer-bun-test',
    proposedBy: 'worker-1',
    sessionId: 'session-abc',
    category: 'convention',
    tier: 'heuristic',
    confidence: 0.85,
    applyTo: ['tests/**/*.test.ts'],
    description: 'Use bun:test for all test files.',
    body: '## Rule\n\nUse bun:test.',
    evidence: [
      { filePath: 'tests/foo.test.ts', note: 'existing test uses bun:test' },
    ],
    ...overrides,
  };
}

// ── Exit + console capture ─────────────────────────────────────────

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run a CLI function while capturing stdout (console.log) and stderr
 * (process.stderr.write + console.error). `process.exit` is replaced with
 * a thrower so we can collect the exit code and still resume the test.
 */
async function capture(fn: () => Promise<void>): Promise<CaptureResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const origLog = console.log;
  const origErr = console.error;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((a) => String(a)).join(' '));
  };
  // Cast via unknown — process.stderr.write has overloaded signatures.
  (process.stderr.write as unknown as (chunk: string) => boolean) = (chunk: string) => {
    stderr.push(String(chunk).replace(/\n$/, ''));
    return true;
  };
  // process.exit has `never` return type — stub it with a throw.
  process.exit = ((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never;

  let exitCode: number | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof ExitError) {
      exitCode = e.code;
    } else {
      throw e;
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    (process.stderr.write as unknown) = origStderrWrite;
    process.exit = origExit;
  }

  return {
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    exitCode,
  };
}

// ── Workspace fixture ───────────────────────────────────────────────

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-cli-memory-'));
});
afterEach(() => {
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

// ── list ────────────────────────────────────────────────────────────

describe('vinyan memory list', () => {
  test('prints "No pending memory proposals." when none exist', async () => {
    const r = await capture(() => runMemoryCommand(['list', '--workspace', workspace]));
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('No pending memory proposals');
  });

  test('lists one pending proposal with its metadata', async () => {
    writeProposal(workspace, makeValidProposal());
    const r = await capture(() => runMemoryCommand(['list', '--workspace', workspace]));
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('prefer-bun-test');
    expect(r.stdout).toContain('category:');
    expect(r.stdout).toContain('convention');
    expect(r.stdout).toContain('confidence:');
    expect(r.stdout).toContain('0.85');
    expect(r.stdout).toContain('Use bun:test for all test files.');
  });

  test('lists multiple pending proposals', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'rule-a' }));
    await new Promise((r) => setTimeout(r, 5));
    writeProposal(workspace, makeValidProposal({ slug: 'rule-b' }));

    const r = await capture(() => runMemoryCommand(['list', '--workspace', workspace]));
    expect(r.stdout).toContain('rule-a');
    expect(r.stdout).toContain('rule-b');
    expect(r.stdout).toContain('Pending proposals (2)');
  });
});

// ── show ────────────────────────────────────────────────────────────

describe('vinyan memory show', () => {
  test('prints the full proposal content', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'show-me' }));
    const r = await capture(() =>
      runMemoryCommand(['show', 'show-me', '--workspace', workspace]),
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('show-me');
    expect(r.stdout).toContain('category: convention');
    expect(r.stdout).toContain('## Rule');
  });

  test('exits 2 when no handle is supplied', async () => {
    const r = await capture(() => runMemoryCommand(['show', '--workspace', workspace]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('requires a slug');
  });

  test('exits 2 when handle does not match any pending file', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'exists' }));
    const r = await capture(() =>
      runMemoryCommand(['show', 'ghost', '--workspace', workspace]),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('no pending proposal matching');
  });
});

// ── approve ─────────────────────────────────────────────────────────

describe('vinyan memory approve', () => {
  test('approves a proposal and appends it to learned.md', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'approve-me' }));
    const r = await capture(() =>
      runMemoryCommand(['approve', 'approve-me', '--workspace', workspace, '--reviewer', 'alice']),
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('Approved');

    const learnedPath = join(workspace, LEARNED_FILE_REL);
    expect(existsSync(learnedPath)).toBe(true);
    const learned = readFileSync(learnedPath, 'utf-8');
    expect(learned).toContain('approve-me (convention)');
    expect(learned).toContain('approvedBy=alice');
  });

  test('exits 2 if --reviewer is missing', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'need-reviewer' }));
    const r = await capture(() =>
      runMemoryCommand(['approve', 'need-reviewer', '--workspace', workspace]),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--reviewer');
    // Audit trail note should hint at A1 compliance.
    expect(r.stderr.toLowerCase()).toContain('human');
    // Nothing written to learned.md.
    expect(existsSync(join(workspace, LEARNED_FILE_REL))).toBe(false);
    // Pending file still present.
    expect(existsSync(join(workspace, PENDING_DIR_REL))).toBe(true);
  });

  test('exits 2 if handle is missing', async () => {
    const r = await capture(() =>
      runMemoryCommand(['approve', '--workspace', workspace, '--reviewer', 'alice']),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('requires a slug');
  });

  test('exits 2 when slug is ambiguous and prints the candidates', async () => {
    // Phase 6 blocks duplicate slugs at writeProposal time, so we construct
    // the ambiguity through a side channel (direct disk write) — this is the
    // realistic scenario the CLI's resolver must still handle (manual edit,
    // race on concurrent writes, or a stale file left over from a crashed
    // approval).
    const pendingDir = join(workspace, PENDING_DIR_REL);
    mkdirSync(pendingDir, { recursive: true });
    const proposal = makeValidProposal({ slug: 'twin' });
    writeFileSync(
      join(pendingDir, '2026-01-01_00-00-00-000Z__twin.md'),
      serializeProposal(proposal),
    );
    writeFileSync(
      join(pendingDir, '2026-01-01_00-00-00-001Z__twin.md'),
      serializeProposal(proposal),
    );

    const r = await capture(() =>
      runMemoryCommand(['approve', 'twin', '--workspace', workspace, '--reviewer', 'alice']),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('ambiguous');
    expect(r.stderr).toContain('full filename');
  });

  test('accepts reviewer value even when positional comes AFTER the flags', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'flag-order' }));
    const r = await capture(() =>
      runMemoryCommand(['approve', '--reviewer', 'alice', '--workspace', workspace, 'flag-order']),
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('Approved');
  });
});

// ── reject ──────────────────────────────────────────────────────────

describe('vinyan memory reject', () => {
  test('rejects a proposal and archives it to rejected/', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'reject-me' }));
    const r = await capture(() =>
      runMemoryCommand([
        'reject',
        'reject-me',
        '--workspace',
        workspace,
        '--reviewer',
        'alice',
        '--reason',
        'not a general rule',
      ]),
    );
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain('Rejected');

    // Archive directory exists and contains the file.
    expect(existsSync(join(workspace, REJECTED_DIR_REL))).toBe(true);
    // learned.md NOT created.
    expect(existsSync(join(workspace, LEARNED_FILE_REL))).toBe(false);
  });

  test('exits 2 if --reviewer is missing', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'need-reviewer' }));
    const r = await capture(() =>
      runMemoryCommand([
        'reject',
        'need-reviewer',
        '--workspace',
        workspace,
        '--reason',
        'no',
      ]),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--reviewer');
  });

  test('exits 2 if --reason is missing', async () => {
    writeProposal(workspace, makeValidProposal({ slug: 'need-reason' }));
    const r = await capture(() =>
      runMemoryCommand([
        'reject',
        'need-reason',
        '--workspace',
        workspace,
        '--reviewer',
        'alice',
      ]),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('--reason');
  });
});

// ── dispatcher ──────────────────────────────────────────────────────

describe('runMemoryCommand dispatcher', () => {
  test('exits 1 with usage on unknown subcommand', async () => {
    const r = await capture(() => runMemoryCommand(['banana']));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage: vinyan memory');
    expect(r.stderr).toContain('list');
    expect(r.stderr).toContain('approve');
    expect(r.stderr).toContain('reject');
  });

  test('exits 1 with usage when no subcommand provided', async () => {
    const r = await capture(() => runMemoryCommand([]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage: vinyan memory');
  });
});

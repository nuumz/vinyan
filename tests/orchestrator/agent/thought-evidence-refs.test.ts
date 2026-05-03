/**
 * A4 evidenceRefs at thought emit — pure-helper + integration tests.
 *
 * Two layers:
 *   1. `buildThoughtEvidenceRefs` pure unit — dedup, schema-shape filter,
 *      cap, empty-input contract.
 *   2. `runAgentLoop` integration — drive a thought emit (pre-tool +
 *      reflect) with a seeded perception that carries `verifiedFacts`,
 *      and assert the captured `audit:entry` row's wrapper carries
 *      `evidenceRefs: [{type:'file', path, sha256}, ...]`.
 *
 * The empty-input case asserts the array is `[]` (not undefined), since
 * the emit-site contract is "always pass an array" so consumers never
 * need to handle the `undefined === legacy row` ambiguity for new emits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry, EvidenceRef } from '../../../src/core/audit.ts';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { type AgentLoopDeps, runAgentLoop } from '../../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../../src/orchestrator/agent/agent-session.ts';
import {
  buildThoughtEvidenceRefs,
  MAX_THOUGHT_FILE_EVIDENCE,
} from '../../../src/orchestrator/agent/thought-evidence-refs.ts';
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';

const SHA = (n: number) => `${'a'.repeat(63)}${(n % 10).toString()}`;

// ── Pure helper ──────────────────────────────────────────────────────

describe('buildThoughtEvidenceRefs', () => {
  it('returns empty array (NOT undefined) when perception is undefined', () => {
    const refs = buildThoughtEvidenceRefs(undefined);
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBe(0);
  });

  it('returns empty array when verifiedFacts is empty', () => {
    const refs = buildThoughtEvidenceRefs({
      taskTarget: { file: 'src/foo.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    });
    expect(refs).toEqual([]);
  });

  it('emits one file ref per unique target with valid sha256', () => {
    const refs = buildThoughtEvidenceRefs({
      taskTarget: { file: 'src/foo.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [
        {
          target: 'src/foo.ts',
          pattern: 'function-exists',
          verified_at: 1,
          hash: SHA(1),
          confidence: 1,
          oracleName: 'ast',
        },
        {
          target: 'src/bar.ts',
          pattern: 'function-exists',
          verified_at: 1,
          hash: SHA(2),
          confidence: 1,
          oracleName: 'ast',
        },
      ],
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    });
    expect(refs).toHaveLength(2);
    const foo = refs.find((r): r is Extract<EvidenceRef, { type: 'file' }> => r.type === 'file' && r.path === 'src/foo.ts');
    expect(foo).toBeDefined();
    expect(foo!.sha256).toBe(SHA(1));
  });

  it('dedupes verifiedFacts entries that share the same target (first-write-wins)', () => {
    const refs = buildThoughtEvidenceRefs({
      taskTarget: { file: 'src/foo.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [
        { target: 'src/foo.ts', pattern: 'fn-exists', verified_at: 1, hash: SHA(1), confidence: 1, oracleName: 'ast' },
        { target: 'src/foo.ts', pattern: 'import-exists', verified_at: 1, hash: SHA(2), confidence: 1, oracleName: 'ast' },
      ],
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    });
    expect(refs).toHaveLength(1);
    if (refs[0]!.type !== 'file') throw new Error('expected file ref');
    expect(refs[0]!.path).toBe('src/foo.ts');
    expect(refs[0]!.sha256).toBe(SHA(1));
  });

  it('drops facts whose hash is malformed (not 64 lowercase hex chars)', () => {
    const refs = buildThoughtEvidenceRefs({
      taskTarget: { file: 'src/foo.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [
        { target: 'src/good.ts', pattern: 'p', verified_at: 1, hash: SHA(1), confidence: 1, oracleName: 'ast' },
        { target: 'src/bad.ts', pattern: 'p', verified_at: 1, hash: 'NOT-A-HASH', confidence: 1, oracleName: 'ast' },
      ],
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    });
    expect(refs).toHaveLength(1);
    if (refs[0]!.type !== 'file') throw new Error('expected file ref');
    expect(refs[0]!.path).toBe('src/good.ts');
  });

  it('caps output at MAX_THOUGHT_FILE_EVIDENCE', () => {
    const facts = [];
    for (let i = 0; i < MAX_THOUGHT_FILE_EVIDENCE + 5; i++) {
      facts.push({
        target: `src/f${i}.ts`,
        pattern: 'p',
        verified_at: 1,
        hash: SHA(i),
        confidence: 1,
        oracleName: 'ast',
      });
    }
    const refs = buildThoughtEvidenceRefs({
      taskTarget: { file: 'src/f0.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: facts,
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    });
    expect(refs).toHaveLength(MAX_THOUGHT_FILE_EVIDENCE);
  });

  it('merges liveFileHashes — adds files not present in perception', () => {
    const perception: PerceptualHierarchy = {
      taskTarget: { file: 'src/foo.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [
        { target: 'src/foo.ts', pattern: 'p', verified_at: 1, hash: SHA(1), confidence: 1, oracleName: 'ast' },
      ],
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    } as unknown as PerceptualHierarchy;
    const live = new Map<string, string>([
      ['src/bar.ts', SHA(2)],  // newly read by worker, NOT in perception
    ]);
    const refs = buildThoughtEvidenceRefs(perception, live);
    expect(refs).toHaveLength(2);
    const paths = refs.map((r) => (r as Extract<EvidenceRef, { type: 'file' }>).path).sort();
    expect(paths).toEqual(['src/bar.ts', 'src/foo.ts']);
  });

  it('liveFileHashes overrides perception on the same path (last-observation-wins)', () => {
    const perception: PerceptualHierarchy = {
      taskTarget: { file: 'src/foo.ts', description: 'x' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [
        { target: 'src/foo.ts', pattern: 'p', verified_at: 1, hash: SHA(1), confidence: 1, oracleName: 'ast' },
      ],
      runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
    } as unknown as PerceptualHierarchy;
    const live = new Map<string, string>([
      ['src/foo.ts', SHA(9)],  // worker re-read after a write; new hash
    ]);
    const refs = buildThoughtEvidenceRefs(perception, live);
    expect(refs).toHaveLength(1);
    if (refs[0]!.type !== 'file') throw new Error('expected file');
    expect(refs[0]!.path).toBe('src/foo.ts');
    expect(refs[0]!.sha256).toBe(SHA(9)); // live hash wins, perception shadowed
  });

  it('drops liveFileHashes entries with malformed sha256', () => {
    const live = new Map<string, string>([
      ['src/good.ts', SHA(1)],
      ['src/bad.ts', 'NOT-A-HASH'],
    ]);
    const refs = buildThoughtEvidenceRefs(undefined, live);
    expect(refs).toHaveLength(1);
    if (refs[0]!.type !== 'file') throw new Error('expected file');
    expect(refs[0]!.path).toBe('src/good.ts');
  });
});

// ── Integration: runAgentLoop end-to-end thought emit ────────────────

class MockAgentSession implements IAgentSession {
  private turns: WorkerTurn[];
  private idx = 0;
  sent: OrchestratorTurn[] = [];
  state: SessionState = 'INIT';
  readonly pid = 99999;
  closed = false;
  closedReason?: TerminateReason;
  drained = false;
  constructor(turns: WorkerTurn[]) {
    this.turns = turns;
  }
  async send(turn: OrchestratorTurn): Promise<void> {
    this.sent.push(turn);
    this.state = 'WAITING_FOR_WORKER';
  }
  async receive(_t: number): Promise<WorkerTurn | null> {
    const t = this.turns[this.idx++] ?? null;
    if (t) this.state = 'WAITING_FOR_ORCHESTRATOR';
    return t;
  }
  async close(reason: TerminateReason): Promise<void> {
    this.closed = true;
    this.closedReason = reason;
    this.state = 'CLOSED';
  }
  async drainAndClose(): Promise<void> {
    this.drained = true;
    this.state = 'CLOSED';
  }
  get sessionState(): SessionState {
    return this.state;
  }
}

function makeInput(): TaskInput {
  return {
    id: 'task-evref-1',
    source: 'test',
    goal: 'evidenceRefs A4 backfill',
    targetFiles: ['src/foo.ts'],
    budget: { maxTokens: 10_000, maxDurationMs: 30_000, maxRetries: 1 },
  } as unknown as TaskInput;
}

function makeRouting(): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    workerId: 'worker-evref',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] } as unknown as WorkingMemoryState;
}

function defaultExecutor() {
  return {
    execute: async (call: ToolCall): Promise<ToolResult> => ({
      callId: call.id,
      tool: call.tool,
      status: 'success',
      output: 'ok',
      durationMs: 1,
    }),
  };
}

function makePerceptionWithFacts(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [
      { target: 'src/foo.ts', pattern: 'fn', verified_at: 1, hash: SHA(1), confidence: 1, oracleName: 'ast' },
      { target: 'src/bar.ts', pattern: 'fn', verified_at: 1, hash: SHA(2), confidence: 1, oracleName: 'ast' },
    ],
    runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
  } as unknown as PerceptualHierarchy;
}

function makePerceptionEmpty(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
  } as unknown as PerceptualHierarchy;
}

let workspace: string;

function makeDeps(session: MockAgentSession, bus: VinyanBus): AgentLoopDeps {
  return {
    workspace,
    contextWindow: 128_000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: defaultExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
    bus,
  };
}

function captureAudit(bus: VinyanBus): AuditEntry[] {
  const out: AuditEntry[] = [];
  bus.on('audit:entry', (e) => out.push(e));
  return out;
}

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-evref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('runAgentLoop — A4 evidenceRefs on thought emits', () => {
  it('pre-tool thought carries evidenceRefs from perception.verifiedFacts', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'I need to read src/foo.ts to understand the structure',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        tokensConsumed: 10,
      },
      { type: 'done', turnId: 't2', proposedContent: 'ok', tokensConsumed: 5 },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerceptionWithFacts(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts).toHaveLength(1);
    const refs = thoughts[0]!.evidenceRefs ?? [];
    expect(refs).toHaveLength(2);
    const foo = refs.find((r): r is Extract<EvidenceRef, { type: 'file' }> => r.type === 'file' && r.path === 'src/foo.ts');
    expect(foo).toBeDefined();
    expect(foo!.sha256).toBe(SHA(1));
    const bar = refs.find((r): r is Extract<EvidenceRef, { type: 'file' }> => r.type === 'file' && r.path === 'src/bar.ts');
    expect(bar).toBeDefined();
    expect(bar!.sha256).toBe(SHA(2));
  });

  it('pre-tool thought carries empty evidenceRefs array (not undefined) when perception has no verifiedFacts', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'Reasoning without file evidence in scope',
        calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/foo.ts' } }],
        tokensConsumed: 10,
      },
      { type: 'done', turnId: 't2', proposedContent: 'ok', tokensConsumed: 5 },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerceptionEmpty(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]!.evidenceRefs).toBeDefined();
    expect(thoughts[0]!.evidenceRefs).toEqual([]);
  });

  it('thought emitted AFTER a successful read_file tool carries the live file hash in evidenceRefs', async () => {
    const { writeFileSync } = await import('node:fs');
    const livePath = join(workspace, 'live-evidence-target.ts');
    const liveContent = 'export const live = "evidence";\n';
    writeFileSync(livePath, liveContent);
    const expectedHash = await import('node:crypto').then((c) =>
      c.createHash('sha256').update(liveContent).digest('hex'),
    );

    // Two-turn worker: first turn reads the file (live hash captured),
    // second turn emits a thought (should reference the live hash).
    const turns: WorkerTurn[] = [
      {
        type: 'tool_calls',
        turnId: 't1',
        rationale: 'I need to inspect the file before changing it',
        calls: [{ id: 'c1', tool: 'read_file', parameters: { path: livePath } }],
        tokensConsumed: 10,
      },
      {
        type: 'tool_calls',
        turnId: 't2',
        rationale: 'Based on the file content I now plan the edit',
        calls: [{ id: 'c2', tool: 'list_dir', parameters: { path: workspace } }],
        tokensConsumed: 10,
      },
      { type: 'done', turnId: 't3', proposedContent: 'ok', tokensConsumed: 5 },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    // Custom executor: the default mock returns 'ok' for every call,
    // which is fine — the live hash comes from the FILE on disk, not
    // from the tool output.
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerceptionEmpty(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    // Two thoughts: t1 (pre first read) and t2 (after read; should
    // include live hash). Find the one whose content mentions the
    // post-read reasoning.
    const postReadThought = thoughts.find((t) => {
      if (t.kind !== 'thought') return false;
      return typeof t.content === 'string' && t.content.includes('Based on the file content');
    });
    expect(postReadThought).toBeDefined();
    const refs = postReadThought!.evidenceRefs ?? [];
    const liveRef = refs.find(
      (r): r is Extract<EvidenceRef, { type: 'file' }> => r.type === 'file' && r.path === livePath,
    );
    expect(liveRef).toBeDefined();
    expect(liveRef!.sha256).toBe(expectedHash);
  });

  it('reflect thought (uncertain terminal) carries evidenceRefs from perception', async () => {
    const turns: WorkerTurn[] = [
      {
        type: 'uncertain',
        turnId: 't1',
        reason: "I am uncertain whether to refactor src/foo.ts because callers may rely on the current API",
        uncertainties: ['unverified-callers'],
        tokensConsumed: 30,
      },
    ];
    const bus = createBus();
    const audits = captureAudit(bus);
    const deps = makeDeps(new MockAgentSession(turns), bus);

    await runAgentLoop(makeInput(), makePerceptionWithFacts(), makeMemory(), undefined, makeRouting(), deps);

    const thoughts = audits.filter((e) => e.kind === 'thought');
    expect(thoughts).toHaveLength(1);
    if (thoughts[0]!.kind !== 'thought') throw new Error('expected thought');
    expect(thoughts[0]!.trigger).toBe('reflect');
    const refs = thoughts[0]!.evidenceRefs ?? [];
    expect(refs.length).toBeGreaterThan(0);
    const foo = refs.find((r): r is Extract<EvidenceRef, { type: 'file' }> => r.type === 'file' && r.path === 'src/foo.ts');
    expect(foo).toBeDefined();
  });
});

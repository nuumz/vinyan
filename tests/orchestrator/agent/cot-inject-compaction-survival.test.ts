/**
 * Task 4 — L2 transcript compaction survival.
 *
 * Two layers:
 *   1. Pure partitioner — assert that the new
 *      `__preserveOnCompaction` flag classifies a turn as evidence
 *      (preserve channel) and that `buildCompactedTranscript` keeps
 *      it verbatim while still collapsing adjacent narrative.
 *   2. End-to-end — drive `runAgentLoop` with `input.cotInjectionPayload`
 *      set; force compaction by stuffing the worker queue with enough
 *      narrative turns to cross the pressure ratio; assert the
 *      compacted transcript STILL contains the inject payload (string
 *      match on a stable token from the inject body).
 *
 * Negative test: a run with NO `cotInjectionPayload` must not emit
 * the synthetic marker turn — the new code path is conditional.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus, type VinyanBus } from '../../../src/core/bus.ts';
import { type AgentLoopDeps, runAgentLoop } from '../../../src/orchestrator/agent/agent-loop.ts';
import type { IAgentSession, SessionState } from '../../../src/orchestrator/agent/agent-session.ts';
import {
  buildCompactedTranscript,
  COMPACTION_PRESERVE_FLAG,
  isEvidenceTurn,
  partitionTranscript,
} from '../../../src/orchestrator/agent/transcript-compactor.ts';
import type { OrchestratorTurn, TerminateReason, WorkerTurn } from '../../../src/orchestrator/protocol.ts';
import type {
  PerceptualHierarchy,
  RoutingDecision,
  TaskInput,
  ToolCall,
  ToolResult,
  WorkingMemoryState,
} from '../../../src/orchestrator/types.ts';

// ── Layer 1 — partitioner pure tests ──────────────────────────────────

describe('transcript-compactor — preserve channel (Strategy a)', () => {
  it('isEvidenceTurn returns true for any turn carrying __preserveOnCompaction:true', () => {
    expect(isEvidenceTurn({ type: 'whatever', [COMPACTION_PRESERVE_FLAG]: true })).toBe(true);
    expect(isEvidenceTurn({ type: 'done', [COMPACTION_PRESERVE_FLAG]: true })).toBe(true);
  });

  it('isEvidenceTurn returns false for a narrative turn without the flag (existing behavior)', () => {
    expect(isEvidenceTurn({ type: 'done' })).toBe(false);
    expect(isEvidenceTurn({ type: 'uncertain' })).toBe(false);
  });

  it('isEvidenceTurn keeps tool_calls and tool_results as evidence (no regression)', () => {
    expect(isEvidenceTurn({ type: 'tool_calls' })).toBe(true);
    expect(isEvidenceTurn({ type: 'tool_results' })).toBe(true);
  });

  it('partitionTranscript counts a preserve-flagged turn as evidence (skips it from narrative tally)', () => {
    const partition = partitionTranscript([
      { type: 'cot_inject_marker', turnId: 'a', content: 'inject A', [COMPACTION_PRESERVE_FLAG]: true, tokensConsumed: 50 },
      { type: 'done', turnId: 'b', tokensConsumed: 30 },
    ]);
    expect(partition.compactedNarrativeTurns).toBe(1);
    expect(partition.tokensSaved).toBe(30);
    const flagged = partition.evidenceTurns.find((t) => t.turnId === 'a');
    expect(flagged?.isEvidence).toBe(true);
  });

  it('buildCompactedTranscript keeps a preserve-flagged turn AND collapses narrative around it', () => {
    const summary = '[Compacted: 2 narrative turns]';
    const out = buildCompactedTranscript(
      [
        { type: 'done', turnId: '1', content: 'narrative-A' },
        { type: 'cot_inject_marker', turnId: 'i', content: 'INJECT-PAYLOAD-XYZ', [COMPACTION_PRESERVE_FLAG]: true },
        { type: 'uncertain', turnId: '2', content: 'narrative-B' },
      ],
      summary,
    );
    // Expected: one summary entry, the preserve-flagged turn (verbatim).
    const summaryEntries = out.filter((t) => t.type === 'compacted_summary');
    expect(summaryEntries).toHaveLength(1);
    const inject = out.find((t) => t.type === 'cot_inject_marker');
    expect(inject).toBeDefined();
    expect((inject as { content?: string }).content).toBe('INJECT-PAYLOAD-XYZ');
  });
});

// ── Layer 2 — runAgentLoop integration ────────────────────────────────

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

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/foo.ts', description: 'target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { nodeVersion: 'v0', os: 'darwin', availableTools: [] },
  } as unknown as PerceptualHierarchy;
}

function makeMemory(): WorkingMemoryState {
  return { failedApproaches: [], activeHypotheses: [], unresolvedUncertainties: [], scopedFacts: [] } as unknown as WorkingMemoryState;
}

function makeRouting(opts?: { budgetTokens?: number }): RoutingDecision {
  return {
    level: 2,
    model: 'test-model',
    workerId: 'worker-cot',
    budgetTokens: opts?.budgetTokens ?? 10_000,
    latencyBudgetMs: 30_000,
  } as RoutingDecision;
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

let workspace: string;

function makeDeps(session: MockAgentSession, bus: VinyanBus): AgentLoopDeps {
  return {
    workspace,
    contextWindow: 1000,
    agentWorkerEntryPath: '/dev/null',
    toolExecutor: defaultExecutor(),
    compressPerception: (p) => p,
    createSession: () => session,
    bus,
  };
}

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-cot-compact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('runAgentLoop — cotInjectionPayload pushes preserve-flagged transcript turn', () => {
  it('pushes a cot_inject_marker turn (preserve-flagged) when input.cotInjectionPayload is set', async () => {
    const turns: WorkerTurn[] = [
      { type: 'done', turnId: 't1', proposedContent: 'ok', tokensConsumed: 10 },
    ];
    const bus = createBus();
    const deps = makeDeps(new MockAgentSession(turns), bus);

    const result = await runAgentLoop(
      {
        id: 'task-cot-marker',
        source: 'test',
        goal: 'do it',
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 1000, maxDurationMs: 30_000, maxRetries: 1 },
        cotInjectionPayload: 'STABLE-INJECT-TOKEN',
      } as unknown as TaskInput,
      makePerception(),
      makeMemory(),
      undefined,
      makeRouting(),
      deps,
    );
    const marker = result.transcript.find((t) => t.type === ('cot_inject_marker' as never));
    expect(marker).toBeDefined();
    expect((marker as unknown as { content?: string }).content).toBe('STABLE-INJECT-TOKEN');
    expect((marker as unknown as Record<string, unknown>)[COMPACTION_PRESERVE_FLAG]).toBe(true);
  });

  it('does NOT push a cot_inject_marker when input.cotInjectionPayload is absent (negative test)', async () => {
    const turns: WorkerTurn[] = [
      { type: 'done', turnId: 't1', proposedContent: 'ok', tokensConsumed: 10 },
    ];
    const bus = createBus();
    const deps = makeDeps(new MockAgentSession(turns), bus);
    const result = await runAgentLoop(
      {
        id: 'task-no-cot',
        source: 'test',
        goal: 'do it',
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 1000, maxDurationMs: 30_000, maxRetries: 1 },
      } as unknown as TaskInput,
      makePerception(),
      makeMemory(),
      undefined,
      makeRouting(),
      deps,
    );
    const marker = result.transcript.find((t) => t.type === ('cot_inject_marker' as never));
    expect(marker).toBeUndefined();
  });

  it('the inject payload survives transcript compaction (≥3 narrative turns, pressure-driven compact)', async () => {
    // Build enough narrative turns to (a) hit transcript.length > 5
    // and (b) push pressureRatio > 0.5 with the contextWindow:1000.
    // tokensConsumed:200 × 3 = 600 + initial pre-marker tokens ⇒ ratio
    // crosses 0.5 well before the loop terminates.
    // Compaction fires inside agent-loop when BOTH:
    //   (a) `pressureRatio = tokensConsumed / budget.maxTokens > 0.5`
    //   (b) `transcript.length > 5`
    // 6 tool_calls turns × 100 tokens = 600 / 1000 = 0.6 > 0.5; the
    // 6th tool_call boundary is where the partition+compact path runs.
    const turns: WorkerTurn[] = [
      { type: 'tool_calls', turnId: 't1', rationale: 'a', calls: [{ id: 'c1', tool: 'file_read', parameters: { path: 'src/a.ts' } }], tokensConsumed: 100 },
      { type: 'tool_calls', turnId: 't2', rationale: 'b', calls: [{ id: 'c2', tool: 'file_read', parameters: { path: 'src/b.ts' } }], tokensConsumed: 100 },
      { type: 'tool_calls', turnId: 't3', rationale: 'c', calls: [{ id: 'c3', tool: 'file_read', parameters: { path: 'src/c.ts' } }], tokensConsumed: 100 },
      { type: 'tool_calls', turnId: 't4', rationale: 'd', calls: [{ id: 'c4', tool: 'file_read', parameters: { path: 'src/d.ts' } }], tokensConsumed: 100 },
      { type: 'tool_calls', turnId: 't5', rationale: 'e', calls: [{ id: 'c5', tool: 'file_read', parameters: { path: 'src/e.ts' } }], tokensConsumed: 100 },
      { type: 'tool_calls', turnId: 't6', rationale: 'compaction-trigger', calls: [{ id: 'c6', tool: 'file_read', parameters: { path: 'src/f.ts' } }], tokensConsumed: 100 },
      { type: 'done', turnId: 't7', proposedContent: 'fix proposed', tokensConsumed: 10 },
    ];
    const bus = createBus();
    let compactionFired = false;
    bus.on('agent:transcript_compaction', () => {
      compactionFired = true;
    });
    const deps = makeDeps(new MockAgentSession(turns), bus);
    const result = await runAgentLoop(
      {
        id: 'task-cot-3rounds',
        source: 'test',
        goal: 'survive compaction',
        targetFiles: ['src/foo.ts'],
        budget: { maxTokens: 1000, maxDurationMs: 30_000, maxRetries: 1 },
        cotInjectionPayload: 'COT-PAYLOAD-MUST-SURVIVE-COMPACTION',
      } as unknown as TaskInput,
      makePerception(),
      makeMemory(),
      undefined,
      // Tight budget so cumulative 200×3 = 600 tokens crosses
      // pressureRatio > 0.5 (600/1000) before the loop ends, triggering
      // the partition+compact path.
      makeRouting({ budgetTokens: 1000 }),
      deps,
    );
    expect(compactionFired).toBe(true);
    // The inject marker must still be present in the post-compaction
    // transcript — string-match on the stable token from the body.
    const transcriptJson = JSON.stringify(result.transcript);
    expect(transcriptJson).toContain('COT-PAYLOAD-MUST-SURVIVE-COMPACTION');
  });
});

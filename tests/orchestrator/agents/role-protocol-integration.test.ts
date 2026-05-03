/**
 * Phase A2.5 integration test: `role-protocol-integration.ts` glue.
 *
 * Exercises the end-to-end seam from RoleProtocolDriver through the
 * canonical adapters into a stubbed `workerPool.dispatch`-shaped
 * callback and a real `RoleProtocolRunStore`. Proves:
 *
 *   1. Per-step dispatch receives the step's `promptPrepend` via
 *      `TaskInput.systemPromptAugmentation`
 *   2. Per-step `id` is suffixed with the step id (no collision with
 *      the parent task's ledger entries)
 *   3. Gather-step's `proposedContent` JSON parses into
 *      `evidence.hashes`
 *   4. Synthesize-step's `proposedContent` becomes
 *      `evidence.synthesisText`
 *   5. The source-citation oracle reads gather hashes + synthesize text
 *      and gates verify-citations correctly
 *   6. RoleProtocolRunStore receives one row per step (right outcomes,
 *      attempts, oracle verdicts)
 *   7. aggregateRunToWorkerResult surfaces synthesisText as
 *      `proposedContent` for the user-facing answer
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { RoleProtocolRunStore } from '../../../src/db/role-protocol-run-store.ts';
import { RoleProtocolDriver } from '../../../src/orchestrator/agents/role-protocol-driver.ts';
import {
  aggregateRunToWorkerResult,
  buildDispatchUnderlying,
  extractStepEvidence,
  persistRunResult,
} from '../../../src/orchestrator/agents/role-protocol-integration.ts';
import {
  RESEARCHER_INVESTIGATE_ID,
  registerBuiltinProtocols,
  researcherInvestigate,
} from '../../../src/orchestrator/agents/role-protocols/builtin/researcher-investigate.ts';
import { buildBuiltinOracleEvaluator } from '../../../src/orchestrator/agents/role-protocols/oracle-evaluator.ts';
import { clearDynamicRoleProtocols } from '../../../src/orchestrator/agents/role-protocols/registry.ts';
import type { WorkerResult } from '../../../src/orchestrator/phases/types.ts';
import type { AgentSpec, TaskInput } from '../../../src/orchestrator/types.ts';

function researcherPersona(): AgentSpec {
  return {
    id: 'researcher',
    name: 'Researcher',
    description: 'integration test',
    role: 'researcher',
    roleProtocolId: RESEARCHER_INVESTIGATE_ID,
  };
}

function parentTask(): TaskInput {
  return {
    id: 'task-int-1',
    source: 'cli',
    goal: 'Research X',
    taskType: 'reasoning',
    budget: { maxDurationMs: 60000, maxTokens: 10000, maxRetries: 0 },
  };
}

const GOOD_SYNTHESIS = [
  '# Findings',
  '',
  'Most browsers ship JavaScript engines.[^a]',
  'Engines have evolved toward JIT compilation.[^b]',
  'Memory pressure remains the primary mobile constraint. [hash:hash-c]',
  '',
  '[^a]: hash-a',
  '[^b]: hash-b',
].join('\n');

const HASHES_JSON = '{"hashes":["hash-a","hash-b","hash-c"]}';

/**
 * Build a fake `perStepDispatch` that returns canned WorkerResult per
 * step kind. Records every input it receives so the test can assert
 * on systemPromptAugmentation + per-step id suffixing.
 */
function fakePerStepDispatch(synthesisText: string) {
  const calls: TaskInput[] = [];
  const dispatch = async (input: TaskInput): Promise<WorkerResult> => {
    calls.push(input);
    const stepKind = input.id.endsWith('-discover')
      ? 'discover'
      : input.id.endsWith('-gather')
        ? 'gather'
        : input.id.endsWith('-compare-extract')
          ? 'compare-extract'
          : input.id.endsWith('-synthesize')
            ? 'synthesize'
            : 'verify-citations';
    let content: string;
    switch (stepKind) {
      case 'discover':
        content = '- source-1\n- source-2\n- source-3';
        break;
      case 'gather':
        content = `Fetched all sources. ${HASHES_JSON}`;
        break;
      case 'compare-extract':
        content = '- claim 1 (source-1)\n- claim 2 (source-2)';
        break;
      case 'synthesize':
        content = synthesisText;
        break;
      default:
        content = '(verify step)';
    }
    return {
      mutations: [],
      proposedToolCalls: [],
      tokensConsumed: 100,
      durationMs: 5,
      proposedContent: content,
    };
  };
  return { dispatch, calls };
}

let db: Database;
let store: RoleProtocolRunStore;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new RoleProtocolRunStore(db);
  registerBuiltinProtocols();
});

afterEach(() => {
  clearDynamicRoleProtocols();
});

describe('role-protocol-integration: end-to-end with researcher.investigate', () => {
  test('happy path — every step succeeds, oracle passes, audit table populated', async () => {
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });
    const parent = parentTask();
    const { dispatch, calls } = fakePerStepDispatch(GOOD_SYNTHESIS);
    const dispatchUnderlying = buildDispatchUnderlying(parent, { perStepDispatch: dispatch });

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: researcherPersona(),
      dispatch: dispatchUnderlying,
      oracleEvaluator: evaluator,
    });

    // All 5 steps succeed (or driver exited early after step 5 hit oracle-pass + step-count).
    expect(result.outcome).toBe('success');
    for (const step of result.steps) expect(step.outcome).toBe('success');

    // 1. Each per-step dispatch received the step's promptPrepend
    expect(calls).toHaveLength(result.steps.length);
    expect(calls[0]?.systemPromptAugmentation).toContain('DISCOVER');
    expect(calls[1]?.systemPromptAugmentation).toContain('GATHER');
    expect(calls[3]?.systemPromptAugmentation).toContain('SYNTHESIZE');

    // 2. Each per-step task id was suffixed with the step id
    expect(calls.map((c) => c.id)).toEqual([
      'task-int-1-discover',
      'task-int-1-gather',
      'task-int-1-compare-extract',
      'task-int-1-synthesize',
      'task-int-1-verify-citations',
    ]);

    // 3. Gather step extracted hashes from JSON in proposedContent
    const gatherStep = result.steps.find((s) => s.stepId === 'gather');
    expect(gatherStep?.evidence).toEqual({ hashes: ['hash-a', 'hash-b', 'hash-c'] });

    // 4. Synthesize step's evidence carries the prose body
    const synthesizeStep = result.steps.find((s) => s.stepId === 'synthesize');
    expect(synthesizeStep?.evidence).toEqual({ synthesisText: GOOD_SYNTHESIS });

    // 5. Verify-citations passed (every claim cites a gathered hash)
    const verifyStep = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyStep?.oracleVerdicts).toEqual({ 'source-citation': true });

    // 6. Persist + read back: every step has a row in role_protocol_run
    persistRunResult({ store, taskId: parent.id, personaId: 'researcher' }, result);
    const rows = store.listForTask(parent.id);
    expect(rows.map((r) => r.stepId)).toEqual(result.steps.map((s) => s.stepId));
    for (const row of rows) expect(row.outcome).toBe('success');

    // 7. Aggregator surfaces synthesisText as the user-facing answer
    const wr = aggregateRunToWorkerResult(result);
    expect(wr.proposedContent).toBe(GOOD_SYNTHESIS);
    expect(wr.tokensConsumed).toBe(100 * result.steps.length);
  });

  test('uncited claim → verify-citations oracle-blocked; aggregate surfaces failure summary', async () => {
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });
    const parent = parentTask();
    const badSynthesis = 'A bald claim with no citation.';
    const { dispatch } = fakePerStepDispatch(badSynthesis);
    const dispatchUnderlying = buildDispatchUnderlying(parent, { perStepDispatch: dispatch });

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: researcherPersona(),
      dispatch: dispatchUnderlying,
      oracleEvaluator: evaluator,
    });

    const verifyStep = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyStep?.outcome).toBe('oracle-blocked');
    expect(verifyStep?.attempts).toBe(2); // retryMax=1 + initial = 2
    expect(result.outcome).toBe('partial');

    persistRunResult({ store, taskId: parent.id, personaId: 'researcher' }, result);
    const rows = store.listForTask(parent.id);
    const verifyRow = rows.find((r) => r.stepId === 'verify-citations');
    expect(verifyRow?.outcome).toBe('oracle-blocked');
    expect(verifyRow?.oracleVerdicts).toEqual({ 'source-citation': false });

    const wr = aggregateRunToWorkerResult(result);
    // When the synthesize step succeeded, the aggregator surfaces its text
    // so the user sees the work — even though citations were blocked. The
    // failure surfaces via the role_protocol_run audit row above. This is
    // the honest user experience: "here's the synthesis I produced; the
    // citation check did not pass — see the audit log for details."
    expect(wr.proposedContent).toBe(badSynthesis);
  });

  test('malformed gather output → empty hashes → every citation flagged unknown → blocked', async () => {
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });
    const parent = parentTask();
    // Patch the dispatcher: return bad JSON for the gather step.
    // Step id is suffixed onto the parent task id by buildDispatchUnderlying,
    // so `task-int-1-gather` → check via endsWith for robustness against
    // parent ids that themselves contain dashes.
    const dispatch = async (input: TaskInput): Promise<WorkerResult> => {
      let content = '(other step)';
      if (input.id.endsWith('-gather')) content = 'Fetched: <invalid json here>';
      else if (input.id.endsWith('-synthesize')) content = GOOD_SYNTHESIS;
      return { mutations: [], proposedToolCalls: [], tokensConsumed: 50, durationMs: 3, proposedContent: content };
    };
    const dispatchUnderlying = buildDispatchUnderlying(parent, { perStepDispatch: dispatch });

    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: researcherPersona(),
      dispatch: dispatchUnderlying,
      oracleEvaluator: evaluator,
    });

    const gatherStep = result.steps.find((s) => s.stepId === 'gather');
    // Permissive parser → empty hashes
    expect(gatherStep?.evidence).toEqual({ hashes: [] });

    // Verify-citations blocked because every citation resolves outside
    // the empty gathered set.
    const verifyStep = result.steps.find((s) => s.stepId === 'verify-citations');
    expect(verifyStep?.outcome).toBe('oracle-blocked');
  });
});

describe('extractStepEvidence — direct unit coverage', () => {
  test('synthesize: returns the verbatim body as synthesisText', () => {
    expect(extractStepEvidence('synthesize', 'hello body')).toEqual({ synthesisText: 'hello body' });
  });

  test('gather: parses {"hashes":[...]} JSON anywhere in the body', () => {
    const body = 'Some prose. {"hashes":["a","b"]} More prose.';
    expect(extractStepEvidence('gather', body)).toEqual({ hashes: ['a', 'b'] });
  });

  test('gather: returns empty hashes on malformed JSON', () => {
    expect(extractStepEvidence('gather', 'no json here')).toEqual({ hashes: [] });
  });

  test('gather: filters out non-string hash entries (defensive)', () => {
    const body = '{"hashes":["a", 123, null, "b"]}';
    expect(extractStepEvidence('gather', body)).toEqual({ hashes: ['a', 'b'] });
  });

  test('verify: captures the body as verifyNote when content present', () => {
    expect(extractStepEvidence('verify', 'inspector notes')).toEqual({ verifyNote: 'inspector notes' });
  });

  test('discover/analyze/etc: returns undefined evidence', () => {
    expect(extractStepEvidence('discover', 'list of sources')).toBeUndefined();
    expect(extractStepEvidence('analyze', 'analysis')).toBeUndefined();
  });

  test('empty body: returns undefined', () => {
    expect(extractStepEvidence('synthesize', undefined)).toBeUndefined();
    expect(extractStepEvidence('gather', '')).toBeUndefined();
  });
});

describe('aggregateRunToWorkerResult — direct unit coverage', () => {
  test('successful run with synthesize: proposedContent === synthesisText', async () => {
    const driver = new RoleProtocolDriver();
    const evaluator = buildBuiltinOracleEvaluator({ onWarn: () => {} });
    const parent = parentTask();
    const { dispatch } = fakePerStepDispatch(GOOD_SYNTHESIS);
    const dispatchUnderlying = buildDispatchUnderlying(parent, { perStepDispatch: dispatch });
    const result = await driver.run({
      protocol: researcherInvestigate,
      persona: researcherPersona(),
      dispatch: dispatchUnderlying,
      oracleEvaluator: evaluator,
    });
    const wr = aggregateRunToWorkerResult(result);
    expect(wr.proposedContent).toBe(GOOD_SYNTHESIS);
    expect(wr.mutations).toEqual([]);
    expect(wr.proposedToolCalls).toEqual([]);
  });
});

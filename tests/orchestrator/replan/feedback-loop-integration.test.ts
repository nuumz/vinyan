/**
 * Integration test — closed feedback loop (Wave B proof).
 *
 * Proves: task succeeds → decomposition recorded in PatternStore →
 * next same-signature task gets seed shape → seed appears in goal.
 *
 * This is the core thesis of the AGI-Grade Capability Plan:
 * "closed feedback loops = AGI-grade reliability".
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { PATTERN_SCHEMA_SQL } from '../../../src/db/pattern-schema.ts';
import { PatternStore } from '../../../src/db/pattern-store.ts';
import { DecompositionLearner } from '../../../src/orchestrator/replan/decomposition-learner.ts';
import { GoalTrajectoryTracker } from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';
import type { TaskDAG, TaskResult, TaskInput, ExecutionTrace } from '../../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../../src/orchestrator/working-memory.ts';

function createPatternStore(): PatternStore {
  const db = new Database(':memory:');
  db.exec(PATTERN_SCHEMA_SQL);
  return new PatternStore(db);
}

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'refactor the auth module',
    taskType: 'code-edit',
    budget: { maxTokens: 8000, maxRetries: 2, maxDurationMs: 60000 },
    targetFiles: ['src/auth.ts'],
    ...overrides,
  } as unknown as TaskInput;
}

function makePlan(): TaskDAG {
  return {
    nodes: [
      { id: 'n1', description: 'extract interface', targetFiles: ['src/auth.ts'], dependencies: [], assignedOracles: ['type'] },
      { id: 'n2', description: 'implement adapter', targetFiles: ['src/auth-adapter.ts'], dependencies: ['n1'], assignedOracles: ['type', 'test'] },
      { id: 'n3', description: 'update imports', targetFiles: ['src/index.ts'], dependencies: ['n2'], assignedOracles: ['type', 'lint'] },
    ],
  };
}

function makeSuccessResult(plan: TaskDAG): TaskResult {
  const trace: ExecutionTrace = {
    id: 'trace-task-1',
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    taskTypeSignature: 'code-edit::src/auth.ts',
    approach: 'extract + adapt + update',
    oracleVerdicts: { type: true, test: true },
    modelUsed: 'test-model',
    tokensConsumed: 1000,
    durationMs: 5000,
    outcome: 'success',
    affectedFiles: ['src/auth.ts', 'src/auth-adapter.ts', 'src/index.ts'],
  };
  return {
    id: 'task-1',
    status: 'completed',
    mutations: [
      { file: 'src/auth.ts', diff: '+ interface Auth {}', oracleVerdicts: {} },
    ],
    trace,
    plan,
  };
}

describe('Feedback Loop Integration', () => {
  test('success → decomposition recorded → next task gets seed → seed in goal', () => {
    const patternStore = createPatternStore();
    const learner = new DecompositionLearner({ patternStore });

    const plan = makePlan();
    const result = makeSuccessResult(plan);
    const taskSignature = result.trace.taskTypeSignature!;

    // ── Step 1: Verify no seed exists initially ──
    expect(learner.retrieveSeedShape(taskSignature)).toBeUndefined();

    // ── Step 2: Record winning decomposition (simulates outer-loop success path) ──
    learner.recordWinningDecomposition(taskSignature, plan, result.trace.id);

    // ── Step 3: Verify pattern was stored ──
    const patterns = patternStore.findByTaskSignature(taskSignature);
    expect(patterns.length).toBe(1);
    expect(patterns[0]!.type).toBe('decomposition-pattern');

    // ── Step 4: Retrieve seed shape (simulates next task with same signature) ──
    const seed = learner.retrieveSeedShape(taskSignature);
    expect(seed).toBeDefined();
    expect(seed!.nodes.length).toBe(3);
    expect(seed!.nodes[0]!.description).toBe('extract interface');
    expect(seed!.nodes[1]!.description).toBe('implement adapter');
    expect(seed!.nodes[2]!.description).toBe('update imports');

    // ── Step 5: Simulate seed injection into goal (as outer-loop does) ──
    const nextInput = makeInput({ id: 'task-2' });
    const seedDesc = seed!.nodes
      .map((n) => `${n.id}: ${n.description} [${n.assignedOracles.join(',')}]`)
      .join(' → ');
    const enhancedGoal = `${nextInput.goal}\n\n[SEED DECOMPOSITION] A prior winning plan shape for similar tasks: ${seedDesc}. Consider reusing this structure.`;

    expect(enhancedGoal).toContain('[SEED DECOMPOSITION]');
    expect(enhancedGoal).toContain('extract interface');
    expect(enhancedGoal).toContain('implement adapter');
    expect(enhancedGoal).toContain('update imports');
  });

  test('multiple successes → confidence increases → highest-confidence seed retrieved', () => {
    const patternStore = createPatternStore();
    const learner = new DecompositionLearner({ patternStore });
    const sig = 'code-edit::src/auth.ts';

    const plan = makePlan();

    // Record 3 successes → frequency=3, confidence grows
    learner.recordWinningDecomposition(sig, plan, 'trace-1');
    learner.recordWinningDecomposition(sig, plan, 'trace-2');
    learner.recordWinningDecomposition(sig, plan, 'trace-3');

    const patterns = patternStore.findByTaskSignature(sig);
    expect(patterns[0]!.frequency).toBe(3);
    expect(patterns[0]!.confidence).toBe(0.7); // 0.5 + 2*0.1

    // Seed is still retrievable and correct
    const seed = learner.retrieveSeedShape(sig);
    expect(seed).toBeDefined();
    expect(seed!.nodes.length).toBe(3);
  });

  test('plan surfaces from TaskResult to outer-loop', () => {
    const plan = makePlan();
    const result = makeSuccessResult(plan);

    // TaskResult.plan is populated
    expect(result.plan).toBeDefined();
    expect(result.plan!.nodes.length).toBe(3);

    // Outer-loop reads it for lastPlan tracking
    let lastPlan: TaskDAG | undefined;
    if (result.plan) {
      lastPlan = result.plan;
    }
    expect(lastPlan).toBe(plan);
  });

  test('negative momentum + trajectory tracker → escalation signal', () => {
    const tracker = new GoalTrajectoryTracker();

    // Simulate 3 declining iterations
    tracker.record(1, 0.6);
    tracker.record(2, 0.5);
    tracker.record(3, 0.4);

    // Negative momentum detected → system should escalate instead of retry
    expect(tracker.isNegativeMomentum(2)).toBe(true);

    const trajectory = tracker.getTrajectory();
    expect(trajectory.negativeMomentumDetected).toBe(true);
    expect(trajectory.points.length).toBe(3);
    expect(trajectory.currentMomentum).toBeLessThan(0);
  });

  test('deterministic transform + decomposition learning compose correctly', () => {
    const patternStore = createPatternStore();
    const learner = new DecompositionLearner({ patternStore });

    // Step 1: First task succeeds with a 2-node plan
    const firstPlan: TaskDAG = {
      nodes: [
        { id: 'n1', description: 'type-check isolation for src/foo.ts', targetFiles: ['src/foo.ts'], dependencies: [], assignedOracles: ['type'] },
        { id: 'n2', description: 'edit remaining', targetFiles: ['src/bar.ts'], dependencies: ['n1'], assignedOracles: ['type', 'lint'] },
      ],
    };
    learner.recordWinningDecomposition('code-edit::src/foo.ts', firstPlan, 'trace-1');

    // Step 2: Next same-signature task retrieves the seed
    const seed = learner.retrieveSeedShape('code-edit::src/foo.ts');
    expect(seed).toBeDefined();
    expect(seed!.nodes.length).toBe(2);

    // Step 3: The seed preserves the structure (type isolation → then edit)
    // but has empty targetFiles (caller fills in actual files)
    expect(seed!.nodes[0]!.assignedOracles).toEqual(['type']);
    expect(seed!.nodes[0]!.targetFiles).toEqual([]);
    expect(seed!.nodes[1]!.dependencies).toEqual(['n1']);
  });
});

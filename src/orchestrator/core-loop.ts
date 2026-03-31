/**
 * Orchestrator Core Loop — the central nervous system of Vinyan Phase 1.
 *
 * 6-step lifecycle: Perceive → Predict → Plan → Generate → Verify → Learn
 * Nested loops: outer = routing level escalation, inner = retry within level.
 *
 * Source of truth: vinyan-tdd.md §16.2
 * Axioms: A3 (deterministic governance), A6 (zero-trust execution)
 *
 * STATUS: Phase 1 complete — all dependencies implemented (CalibratedSelfModel,
 * TaskDecomposerImpl, WorkerPoolImpl, OracleGateAdapter, TraceCollectorImpl).
 */
import type {
  TaskInput,
  TaskResult,
  RoutingLevel,
  RoutingDecision,
  PerceptualHierarchy,
  WorkingMemoryState,
  ExecutionTrace,
  TaskDAG,
  SelfModelPrediction,
  PredictionError,
  CachedSkill,
  ToolCall,
} from "./types.ts";
import { WorkingMemory } from "./working-memory.ts";
import type { VinyanBus } from "../core/bus.ts";
import { computeQualityScore, buildComplexityContext } from "../gate/quality-score.ts";
import { commitArtifacts } from "./worker/artifact-commit.ts";

// ---------------------------------------------------------------------------
// Dependency interfaces (injected — each implemented in its own module)
// ---------------------------------------------------------------------------

export interface PerceptionAssembler {
  assemble(input: TaskInput, level: RoutingLevel): Promise<PerceptualHierarchy>;
}

export interface RiskRouter {
  assessInitialLevel(input: TaskInput): Promise<RoutingDecision>;
}

export interface SelfModel {
  predict(
    input: TaskInput,
    perception: PerceptualHierarchy,
  ): Promise<SelfModelPrediction>;
  calibrate?(prediction: SelfModelPrediction, trace: ExecutionTrace): PredictionError | void;
}

export interface TaskDecomposer {
  decompose(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
  ): Promise<TaskDAG>;
}

export interface WorkerPool {
  dispatch(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    plan: TaskDAG | undefined,
    routing: RoutingDecision,
  ): Promise<WorkerResult>;
}

export interface OracleGate {
  verify(
    mutations: Array<{ file: string; content: string }>,
    workspace: string,
  ): Promise<VerificationResult>;
}

export interface TraceCollector {
  record(trace: ExecutionTrace): Promise<void>;
  /** Optional: returns total trace count for data-gated features. */
  getTraceCount?(): number;
}

// ---------------------------------------------------------------------------
// Internal result types
// ---------------------------------------------------------------------------

interface WorkerResult {
  mutations: Array<{
    file: string;
    content: string;
    diff: string;
    explanation: string;
  }>;
  proposedToolCalls: ToolCall[];
  tokensConsumed: number;
  duration_ms: number;
}

interface VerificationResult {
  passed: boolean;
  verdicts: Record<string, import("../core/types.ts").OracleVerdict>;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  perception: PerceptionAssembler;
  riskRouter: RiskRouter;
  selfModel: SelfModel;
  decomposer: TaskDecomposer;
  workerPool: WorkerPool;
  oracleGate: OracleGate;
  traceCollector: TraceCollector;
  bus?: VinyanBus;
  /** Workspace root — needed for commitArtifacts after oracle verification. */
  workspace?: string;
  // Phase 2 — optional, activated by factory when DB is available
  skillManager?: import("./skill-manager.ts").SkillManager;
  shadowRunner?: import("./shadow-runner.ts").ShadowRunner;
  ruleStore?: import("../db/rule-store.ts").RuleStore;
  toolExecutor?: import("./tools/tool-executor.ts").ToolExecutor;
  // Phase 4 — optional, activated by factory when worker profiles are available
  workerSelector?: import("./worker-selector.ts").WorkerSelector;
  workerStore?: import("../db/worker-store.ts").WorkerStore;
  workerLifecycle?: import("./worker-lifecycle.ts").WorkerLifecycle;
  /** WorldGraph for committing verified facts (A4: content-addressed truth). */
  worldGraph?: import("../world-graph/world-graph.ts").WorldGraph;
  /** CriticEngine — L2+ semantic verification (§17.6). Skip gracefully if absent. */
  criticEngine?: import("./critic/critic-engine.ts").CriticEngine;
  /** TestGenerator — L2+ generative verification (§17.7). Skip gracefully if absent. */
  testGenerator?: import("./test-gen/test-generator.ts").TestGenerator;
  /** Epsilon-greedy exploration rate (default 0.05). Set to 0 in tests for determinism. */
  explorationEpsilon?: number;
}

const MAX_ROUTING_LEVEL: RoutingLevel = 3;

/**
 * Execute a task through the full Orchestrator lifecycle.
 *
 * Outer loop: escalate routing level on repeated failure (L0 → L1 → L2 → L3 → human)
 * Inner loop: retry within routing level (up to budget.maxRetries)
 *
 * This is the single function that transforms Vinyan from a verification library
 * into an autonomous agent. Everything flows through here.
 */
export async function executeTask(
  input: TaskInput,
  deps: OrchestratorDeps,
): Promise<TaskResult> {
  const workingMemory = new WorkingMemory();
  const startTime = Date.now();

  // Outer loop: routing level escalation
  let routing = await deps.riskRouter.assessInitialLevel(input);

  // ── Evolution Rules (Phase 2.6) — apply before main loop ─────────
  if (deps.ruleStore) {
    const fp = (input.targetFiles ?? []).sort().join(",") || "*";
    const matchingRules = deps.ruleStore.findMatching({ filePattern: fp });
    if (matchingRules.length > 0) {
      const { resolveRuleConflicts } = await import("../evolution/rule-resolver.ts");
      const { checkSafetyInvariants } = await import("../evolution/safety-invariants.ts");
      const winners = resolveRuleConflicts(matchingRules);
      for (const rule of winners) {
        if (!checkSafetyInvariants(rule).safe) continue;
        if (rule.action === "escalate" && typeof rule.parameters.toLevel === "number") {
          const newLevel = rule.parameters.toLevel as RoutingLevel;
          if (newLevel > routing.level) routing = { ...routing, level: newLevel };
        }
        if (rule.action === "require-oracle" && typeof rule.parameters.oracleName === "string") {
          routing = { ...routing, mandatoryOracles: [...(routing.mandatoryOracles ?? []), rule.parameters.oracleName] };
        }
        if (rule.action === "prefer-model" && typeof rule.parameters.preferredModel === "string") {
          routing = { ...routing, model: rule.parameters.preferredModel };
        }
        if (rule.action === "adjust-threshold" && typeof rule.parameters.riskThreshold === "number") {
          routing = { ...routing, riskThresholdOverride: rule.parameters.riskThreshold };
        }
        if (rule.action === "assign-worker" && typeof rule.parameters.workerId === "string") {
          routing = { ...routing, workerId: rule.parameters.workerId };
        }
      }
      deps.bus?.emit("evolution:rulesApplied", { taskId: input.id, rules: winners });
    }
  }

  // PH3.6: Epsilon-greedy exploration — with probability ε, route UP one level (never down)
  const EPSILON = deps.explorationEpsilon ?? 0.05;
  let explorationFlag = false;
  if (routing.level < MAX_ROUTING_LEVEL && Math.random() < EPSILON) {
    const fromLevel = routing.level;
    routing = { ...routing, level: (routing.level + 1) as RoutingLevel };
    explorationFlag = true;
    deps.bus?.emit("task:explore", { taskId: input.id, fromLevel, toLevel: routing.level });
  }

  deps.bus?.emit("task:start", { input, routing });

  // Hoist for audit trail on timeout/escalation traces (Gap #2)
  let lastWorkerSelection: import("./types.ts").WorkerSelectionResult | undefined;

  while (routing.level <= MAX_ROUTING_LEVEL) {
    // Track matched skill for feedback loop (H4) — resets on level escalation
    let matchedSkill: CachedSkill | null = null;

    // Inner loop: retry within current routing level
    for (let retry = 0; retry < input.budget.maxRetries; retry++) {
      // ── Wall-clock timeout check ──────────────────────────────────
      if (Date.now() - startTime > input.budget.maxDurationMs) {
        const timeoutTrace: ExecutionTrace = {
          id: `trace-${input.id}-timeout`,
          taskId: input.id,
          worker_id: routing.workerId ?? routing.model ?? "unknown",
          timestamp: Date.now(),
          routingLevel: routing.level,
          approach: "wall-clock-timeout",
          oracleVerdicts: {},
          model_used: routing.model ?? "none",
          tokens_consumed: 0,
          duration_ms: Date.now() - startTime,
          outcome: "timeout",
          failure_reason: `Wall-clock timeout exceeded: ${input.budget.maxDurationMs}ms`,
          affected_files: input.targetFiles ?? [],
          workerSelectionAudit: lastWorkerSelection,
        };
        await deps.traceCollector.record(timeoutTrace);
        deps.bus?.emit("trace:record", { trace: timeoutTrace });
        deps.bus?.emit("task:timeout", {
          taskId: input.id,
          elapsed_ms: Date.now() - startTime,
          budget_ms: input.budget.maxDurationMs,
        });
        const timeoutResult: TaskResult = {
          id: input.id,
          status: "failed",
          mutations: [],
          trace: timeoutTrace,
        };
        deps.bus?.emit("task:complete", { result: timeoutResult });
        return timeoutResult;
      }

      // ── L0 Skill Shortcut (Phase 2.5) ──────────────────────────────
      if (deps.skillManager && routing.level <= 1) {
        const fp = (input.targetFiles ?? []).sort().join(",") || "*";
        const taskSig = `${input.goal.slice(0, 50)}::${fp}`;
        const skill = deps.skillManager.match(taskSig);
        if (skill) {
          const check = deps.skillManager.verify(skill);
          if (check.valid) {
            matchedSkill = skill;
            // Inject proven approach as hypothesis — influences LLM generation
            // while still going through full oracle verification (A6 zero-trust)
            workingMemory.addHypothesis(
              `Proven approach: ${skill.approach}`,
              skill.successRate,
              "cached-skill",
            );
            deps.bus?.emit("skill:match", { taskId: input.id, skill });
          } else {
            deps.bus?.emit("skill:miss", { taskId: input.id, taskSignature: taskSig });
          }
        }
      }

      // ── Step 1: PERCEIVE ──────────────────────────────────────────
      const perception = await deps.perception.assemble(input, routing.level);

      // ── Step 2: PREDICT (L2+ only) ───────────────────────────────
      let prediction: SelfModelPrediction | undefined;
      if (routing.level >= 2) {
        prediction = await deps.selfModel.predict(input, perception);
        deps.bus?.emit("selfmodel:predict", { prediction });

        // S1: Cold-start safeguard — enforce minimum routing level
        if (prediction.forceMinLevel != null && routing.level < prediction.forceMinLevel) {
          routing = { ...routing, level: prediction.forceMinLevel as RoutingLevel };
        }
      }

      // ── Step 2½: SELECT WORKER (Phase 4) ──────────────────────────
      let workerSelection: import("./types.ts").WorkerSelectionResult | undefined;
      if (deps.workerSelector && !routing.workerId) {
        const { computeFingerprint } = await import("./task-fingerprint.ts");
        const fingerprint = computeFingerprint(input, perception, {
          traceCount: deps.traceCollector.getTraceCount?.() ?? 0,
        });
        const selection = deps.workerSelector.selectWorker(
          fingerprint, routing.level,
          { maxTokens: input.budget.maxTokens, timeoutMs: input.budget.maxDurationMs },
          undefined, input.id,
        );
        workerSelection = selection;
        lastWorkerSelection = selection;

        // A2: Fleet-level uncertainty — all workers below capability threshold
        if (selection.isUncertain) {
          const uncertainTrace: ExecutionTrace = {
            id: `trace-${input.id}-uncertain`,
            taskId: input.id,
            worker_id: "none",
            timestamp: Date.now(),
            routingLevel: routing.level,
            approach: "fleet-uncertain",
            oracleVerdicts: {},
            model_used: "none",
            tokens_consumed: 0,
            duration_ms: Date.now() - startTime,
            outcome: "failure",
            failure_reason: `All workers below capability threshold (max: ${selection.maxCapability?.toFixed(2)}) — abstaining per A2`,
            affected_files: input.targetFiles ?? [],
            workerSelectionAudit: selection,
          };
          await deps.traceCollector.record(uncertainTrace);
          deps.bus?.emit("trace:record", { trace: uncertainTrace });
          const uncertainResult: TaskResult = {
            id: input.id,
            status: "uncertain",
            mutations: [],
            trace: uncertainTrace,
            notes: ["All workers below capability threshold — abstaining per A2"],
          };
          deps.bus?.emit("task:complete", { result: uncertainResult });
          return uncertainResult;
        }

        if (selection.selectedWorkerId) {
          routing = { ...routing, workerId: selection.selectedWorkerId };
        }
      }

      // ── Step 3: PLAN (L2+ only) ──────────────────────────────────
      let plan: TaskDAG | undefined;
      if (routing.level >= 2) {
        plan = await deps.decomposer.decompose(
          input,
          perception,
          workingMemory.getSnapshot(),
        );
        if (plan.isFallback) {
          deps.bus?.emit("decomposer:fallback", { taskId: input.id });
        }
      }

      // ── Step 4: GENERATE (dispatch to worker) ────────────────────
      deps.bus?.emit("worker:dispatch", { taskId: input.id, routing });
      const dispatchStart = Date.now();
      let workerResult;
      try {
        workerResult = await deps.workerPool.dispatch(
          input,
          perception,
          workingMemory.getSnapshot(),
          plan,
          routing,
        );
        deps.bus?.emit("worker:complete", {
          taskId: input.id,
          output: workerResult as unknown as import("./types.ts").WorkerOutput,
          duration_ms: Date.now() - dispatchStart,
        });
      } catch (dispatchErr) {
        deps.bus?.emit("worker:error", {
          taskId: input.id,
          error: String(dispatchErr),
          routing,
        });
        throw dispatchErr;
      }

      // ── Step 4½a: EXECUTE read-only tool calls (safe pre-verification) ──
      let mutatingToolCalls: import("./types.ts").ToolCall[] = [];
      if (deps.toolExecutor && workerResult.proposedToolCalls.length > 0) {
        const toolContext = {
          workspace: deps.workspace ?? process.cwd(),
          allowedPaths: input.targetFiles ?? [],
          routingLevel: routing.level,
        } as import("./tools/tool-interface.ts").ToolContext;

        const { readOnly, mutating } = deps.toolExecutor.partitionBySideEffect(
          workerResult.proposedToolCalls,
        );
        mutatingToolCalls = mutating;

        // Execute read-only tools immediately (no side effects)
        if (readOnly.length > 0) {
          const readOnlyResults = await deps.toolExecutor.executeProposedTools(readOnly, toolContext);
          deps.bus?.emit("tools:executed", { taskId: input.id, results: readOnlyResults });
        }
      }

      // ── Step 5: VERIFY (oracle gate) ─────────────────────────────
      const verification = await deps.oracleGate.verify(
        workerResult.mutations.map((m) => ({
          file: m.file,
          content: m.content,
        })),
        input.targetFiles?.[0] ?? ".",
      );

      // ── Emit per-oracle verdicts ──────────────────────────────────
      const passedOracles: string[] = [];
      const failedOracles: string[] = [];
      for (const [oracleName, verdict] of Object.entries(verification.verdicts)) {
        deps.bus?.emit("oracle:verdict", { taskId: input.id, oracleName, verdict });
        if (verdict.verified) passedOracles.push(oracleName);
        else failedOracles.push(oracleName);
      }
      // ── Contradiction detection (A1: surface epistemic disagreements) ──
      if (passedOracles.length > 0 && failedOracles.length > 0) {
        deps.bus?.emit("oracle:contradiction", {
          taskId: input.id,
          passed: passedOracles,
          failed: failedOracles,
        });
      }

      // ── Compute QualityScore from available data (A7: gradient signal) ──
      const testVerdictKey = Object.keys(verification.verdicts).find(k => k.startsWith("test"));
      const testContext = testVerdictKey
        ? { testsExist: true, testsPassed: verification.verdicts[testVerdictKey]!.verified }
        : undefined;
      const complexityCtx = buildComplexityContext(
        workerResult.mutations.map(m => ({ file: m.file, content: m.content })),
        deps.workspace ?? process.cwd(),
      );
      const qualityScore = computeQualityScore(
        verification.verdicts,
        workerResult.duration_ms,
        routing.latencyBudget_ms,
        complexityCtx,
        testContext,
      );

      // ── Step 6: LEARN ────────────────────────────────────────────
      // Compute task type signature for Sleep Cycle grouping
      const filePattern = (input.targetFiles ?? []).sort().join(",") || "*";
      const taskTypeSignature = `${input.goal.slice(0, 50)}::${filePattern}`;

      const trace: ExecutionTrace = {
        id: `trace-${input.id}-${routing.level}-${retry}-${Math.random().toString(36).slice(2, 6)}`,
        taskId: input.id,
        worker_id: routing.workerId ?? routing.model ?? "unknown",
        timestamp: Date.now(),
        routingLevel: routing.level,
        task_type_signature: taskTypeSignature,
        approach: workerResult.mutations
          .map((m) => m.explanation)
          .join("; "),
        oracleVerdicts: Object.fromEntries(
          Object.entries(verification.verdicts).map(([k, v]) => [
            k,
            v.verified,
          ]),
        ),
        model_used: routing.model ?? "none",
        tokens_consumed: workerResult.tokensConsumed,
        duration_ms: workerResult.duration_ms,
        outcome: verification.passed ? "success" : "failure",
        failure_reason: verification.passed ? undefined : verification.reason,
        affected_files: workerResult.mutations.map((m) => m.file),
        qualityScore,
        prediction,
        exploration: explorationFlag || undefined,
        workerSelectionAudit: workerSelection,
      };

      // Calibrate self-model BEFORE recording — so predictionError is included in single insert
      if (prediction && deps.selfModel.calibrate) {
        try {
          const predictionError = deps.selfModel.calibrate(prediction, trace);
          if (predictionError) {
            trace.predictionError = predictionError;
          }
        } catch (calibErr) {
          deps.bus?.emit("selfmodel:calibration_error", {
            taskId: input.id,
            error: calibErr instanceof Error ? calibErr.message : String(calibErr),
          });
        }
      }

      // Record trace once — after calibration so predictionError is persisted
      await deps.traceCollector.record(trace);
      deps.bus?.emit("trace:record", { trace });

      // ── Step 5½: EXECUTE mutating tools ONLY after verification ──
      if (verification.passed && deps.toolExecutor && mutatingToolCalls.length > 0) {
        const toolContext = {
          workspace: deps.workspace ?? process.cwd(),
          allowedPaths: input.targetFiles ?? [],
          routingLevel: routing.level,
        } as import("./tools/tool-interface.ts").ToolContext;

        const mutatingResults = await deps.toolExecutor.executeProposedTools(mutatingToolCalls, toolContext);
        deps.bus?.emit("tools:executed", { taskId: input.id, results: mutatingResults });

        // Merge file-write tool results back into mutations
        for (const tr of mutatingResults) {
          if (tr.status === "success" && tr.output && typeof tr.output === "object") {
            const out = tr.output as { file?: string; content?: string };
            if (out.file && out.content) {
              const existing = workerResult.mutations.find(m => m.file === out.file);
              if (!existing) {
                workerResult.mutations.push({
                  file: out.file,
                  content: out.content,
                  diff: "",
                  explanation: `Tool ${tr.tool} output`,
                });
              }
            }
          }
        }
      }

      // ── SUCCESS → return result ──────────────────────────────────
      if (verification.passed) {
        // ── I10: Probation workers cannot commit — shadow-only ──────
        if (deps.workerStore && routing.workerId) {
          const workerProfile = deps.workerStore.findById(routing.workerId);
          if (workerProfile?.status === "probation") {
            // Enqueue as shadow for evaluation, do NOT commit
            if (deps.shadowRunner) {
              const job = deps.shadowRunner.enqueue(
                input.id,
                workerResult.mutations.map(m => ({ file: m.file, content: m.content })),
              );
              deps.bus?.emit("shadow:enqueue", { job });

              // PH4.2: Shadow validation with alternative worker for comparison (20% sample)
              if (deps.workerLifecycle?.shouldShadowForProbation(input.id, routing.workerId!)) {
                deps.shadowRunner.runAlternativeWorker(
                  input.id,
                  workerResult.mutations.map(m => ({ file: m.file, content: m.content })),
                  routing.workerId!,
                ).then(result => {
                  deps.bus?.emit("shadow:complete", {
                    job: { id: "", taskId: input.id, status: "done" as const, enqueuedAt: 0, retryCount: 0, maxRetries: 1 },
                    result,
                  });
                }).catch(() => { /* fire-and-forget — A6 compliance */ });
              }
            }
            const probationResult: TaskResult = {
              id: input.id,
              status: "completed",
              mutations: [],
              trace: { ...trace, outcome: "success" as const },
              notes: ["probation-shadow-only: I10 — probation worker result not committed"],
            };
            deps.bus?.emit("task:complete", { result: probationResult });
            return probationResult;
          }
        }

        // ── Commit verified mutations to workspace ──────────────────
        let commitResult: { applied: string[]; rejected: Array<{ path: string; reason: string }> } | undefined;
        if (deps.workspace && workerResult.mutations.length > 0) {
          commitResult = commitArtifacts(
            deps.workspace,
            workerResult.mutations.map(m => ({ path: m.file, content: m.content })),
          );
          if (commitResult.rejected.length > 0) {
            deps.bus?.emit("commit:rejected", {
              taskId: input.id,
              rejected: commitResult.rejected,
            });
          }
        }

        // ── A4: Commit verified oracle verdicts as World Graph facts ────
        if (deps.worldGraph && deps.workspace && commitResult && commitResult.applied.length > 0) {
          try {
            for (const file of commitResult.applied) {
              const absPath = require("path").resolve(deps.workspace, file);
              const hash = deps.worldGraph.computeFileHash(absPath);
              deps.worldGraph.storeFact({
                target: file,
                pattern: "oracle-verified",
                evidence: Object.entries(verification.verdicts).map(([oracle, passed]) => ({
                  file,
                  line: 0,
                  snippet: `${oracle}: ${passed ? "pass" : "fail"}`,
                })),
                oracle_name: "orchestrator",
                source_file: file,
                file_hash: hash,
                verified_at: Date.now(),
                session_id: input.id,
                confidence: 1.0,
              });
            }
          } catch {
            // WorldGraph fact commitment is best-effort — does not block task completion
          }
        }

        // Filter mutations to only those actually committed (A6: rejected paths excluded)
        const appliedSet = commitResult
          ? new Set(commitResult.applied)
          : new Set(workerResult.mutations.map(m => m.file));
        const appliedMutations = workerResult.mutations.filter(m => appliedSet.has(m.file));
        const allRejected = commitResult && commitResult.applied.length === 0 && commitResult.rejected.length > 0;

        const successResult: TaskResult = {
          id: input.id,
          status: allRejected ? "failed" : "completed",
          mutations: appliedMutations.map((m) => ({
            file: m.file,
            diff: m.diff,
            oracleVerdicts: verification.verdicts,
          })),
          trace,
          qualityScore,
          notes: commitResult?.rejected.length
            ? [`Rejected files: ${commitResult.rejected.map(r => `${r.path} (${r.reason})`).join(", ")}`]
            : undefined,
        };
        // ── Shadow Enqueue (Phase 2.2) — A6 crash-safety ──────────
        if (deps.shadowRunner && routing.level >= 2) {
          const job = deps.shadowRunner.enqueue(
            input.id,
            workerResult.mutations.map(m => ({ file: m.file, content: m.content })),
          );
          trace.validation_depth = "structural";
          deps.bus?.emit("shadow:enqueue", { job });
          // Fire-and-forget: process shadow job in background
          deps.shadowRunner.processNext().then(result => {
            if (result) {
              deps.bus?.emit("shadow:complete", { job, result });
            }
          }).catch(err => {
            deps.bus?.emit("shadow:failed", { job, error: String(err) });
          });
        }

        // ── Skill outcome: success (H4) ──────────────────────────────
        if (matchedSkill && deps.skillManager) {
          deps.skillManager.recordOutcome(matchedSkill, true);
          deps.bus?.emit("skill:outcome", { taskId: input.id, skill: matchedSkill, success: true });
        }

        deps.bus?.emit("task:complete", { result: successResult });
        return successResult;
      }

      // ── FAILURE → record in working memory, retry ────────────────
      workingMemory.recordFailedApproach(
        trace.approach,
        verification.reason ?? "unknown",
      );

      // ── Skill outcome: failure (H4) ──────────────────────────────
      if (matchedSkill && deps.skillManager) {
        deps.skillManager.recordOutcome(matchedSkill, false);
        deps.bus?.emit("skill:outcome", { taskId: input.id, skill: matchedSkill, success: false });
        matchedSkill = null; // don't record again on retry
      }
    }

    // ── RETRY EXHAUSTED → escalate routing level ─────────────────
    const nextLevel = (routing.level + 1) as RoutingLevel;
    if (nextLevel > MAX_ROUTING_LEVEL) break;

    deps.bus?.emit("task:escalate", {
      taskId: input.id,
      fromLevel: routing.level,
      toLevel: nextLevel,
      reason: `Exhausted ${input.budget.maxRetries} retries at L${routing.level}`,
    });

    routing = await deps.riskRouter.assessInitialLevel({
      ...input,
      // Force minimum routing level to next level
      constraints: [
        ...(input.constraints ?? []),
        `MIN_ROUTING_LEVEL:${nextLevel}`,
      ],
    });
  }

  // ── ALL LEVELS EXHAUSTED → escalate to human ───────────────────
  const escalationTrace: ExecutionTrace = {
    id: `trace-${input.id}-escalation`,
    taskId: input.id,
    worker_id: routing.workerId ?? routing.model ?? "unknown",
    timestamp: Date.now(),
    routingLevel: MAX_ROUTING_LEVEL,
    approach: "all-levels-exhausted",
    oracleVerdicts: {},
    model_used: routing.model ?? "none",
    tokens_consumed: 0,
    duration_ms: Date.now() - startTime,
    outcome: "escalated",
    failure_reason: `Failed after ${workingMemory.getSnapshot().failedApproaches.length} attempts across all routing levels`,
    affected_files: input.targetFiles ?? [],
    workerSelectionAudit: lastWorkerSelection,
  };

  await deps.traceCollector.record(escalationTrace);
  deps.bus?.emit("trace:record", { trace: escalationTrace });

  const escalationResult: TaskResult = {
    id: input.id,
    status: "escalated",
    mutations: [],
    trace: escalationTrace,
    escalationReason: `Task could not be completed after exhausting all routing levels (L0-L3). ${workingMemory.getSnapshot().failedApproaches.length} failed approaches recorded.`,
  };
  deps.bus?.emit("task:complete", { result: escalationResult });
  return escalationResult;
}

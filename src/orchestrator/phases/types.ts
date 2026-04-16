/**
 * Phase extraction types for the Orchestrator Core Loop.
 *
 * Each lifecycle phase (Perceive → Predict → Plan → Generate → Verify → Learn)
 * returns a PhaseOutcome that the coordinator interprets.
 */

import type { AgentContract } from '../../core/agent-contract.ts';
import type { VinyanBus } from '../../core/bus.ts';
import type { OracleVerdict, QualityScore } from '../../core/types.ts';
import type { EpistemicGateDecision } from '../../gate/epistemic-decision.ts';
import type { OrchestratorDeps } from '../core-loop.ts';
import type { DAGExecutionResult } from '../dag-executor.ts';
import type { OutcomePrediction } from '../forward-predictor-types.ts';
import type { ConfidenceDecision } from '../pipeline-confidence.ts';
import type {
  CachedSkill,
  ConversationEntry,
  ExecutionTrace,
  PerceptualHierarchy,
  RoutingDecision,
  RoutingLevel,
  SelfModelPrediction,
  SemanticTaskUnderstanding,
  TaskDAG,
  TaskInput,
  TaskResult,
  ToolCall,
  VerificationHint,
  WorkerSelectionResult,
  WorkingMemoryState,
} from '../types.ts';
import type { WorkerLoopResult } from '../worker/agent-loop.ts';
import type { WorkingMemory } from '../working-memory.ts';

// ---------------------------------------------------------------------------
// Shared phase context
// ---------------------------------------------------------------------------

/** Immutable context shared across all phases within an iteration. */
export interface PhaseContext {
  readonly input: TaskInput;
  readonly deps: OrchestratorDeps;
  readonly startTime: number;
  readonly workingMemory: WorkingMemory;
  readonly explorationFlag: boolean;
  /** Conversation history from prior turns (loaded when sessionId present). */
  readonly conversationHistory?: ConversationEntry[];
}

// ---------------------------------------------------------------------------
// Phase outcome — discriminated union for control flow signals
// ---------------------------------------------------------------------------

/** Phase completed normally with a result. */
export interface PhaseContinue<T> {
  readonly action: 'continue';
  readonly value: T;
}

/** Phase requests inner loop retry (equivalent to `continue` in the retry loop). */
export interface PhaseRetry {
  readonly action: 'retry';
}

/** Phase requests outer loop escalation (equivalent to `continue routingLoop`). */
export interface PhaseEscalate {
  readonly action: 'escalate';
  readonly routing: RoutingDecision;
}

/** Phase requests early return with a TaskResult. */
export interface PhaseReturn {
  readonly action: 'return';
  readonly result: TaskResult;
}

/** Phase requests re-throw of an error. */
export interface PhaseThrow {
  readonly action: 'throw';
  readonly error: unknown;
}

export type PhaseOutcome<T> = PhaseContinue<T> | PhaseRetry | PhaseEscalate | PhaseReturn | PhaseThrow;

// Constructors
export const Phase = {
  continue: <T>(value: T): PhaseContinue<T> => ({ action: 'continue', value }),
  retry: (): PhaseRetry => ({ action: 'retry' }),
  escalate: (routing: RoutingDecision): PhaseEscalate => ({ action: 'escalate', routing }),
  return: (result: TaskResult): PhaseReturn => ({ action: 'return', result }),
  throw: (error: unknown): PhaseThrow => ({ action: 'throw', error }),
} as const;

// ---------------------------------------------------------------------------
// Phase-specific result types
// ---------------------------------------------------------------------------

export interface PerceiveResult {
  perception: PerceptualHierarchy;
  understanding: SemanticTaskUnderstanding;
}

export interface PredictResult {
  prediction?: SelfModelPrediction;
  predictionConfidence?: number;
  metaPredictionConfidence?: number;
  forwardPrediction?: OutcomePrediction;
  routing: RoutingDecision;
  workerSelection?: WorkerSelectionResult;
}

export interface PlanResult {
  plan?: TaskDAG;
  /**
   * Wave 5.2: optional input with the DAG's preamble merged into
   * `constraints`. Present only when `plan.preamble` was non-empty.
   * The core-loop swaps `ctx.input` for this enhanced clone so the
   * caller's original TaskInput is never mutated. When absent, the
   * existing `ctx.input` is used unchanged.
   */
  enhancedInput?: TaskInput;
}

export interface GenerateResult {
  workerResult: WorkerResult;
  isAgenticResult: boolean;
  lastAgentResult: WorkerLoopResult | null;
  dagResult: DAGExecutionResult | null;
  mutatingToolCalls: ToolCall[];
  totalTokensConsumed: number;
  /** R2: when the task was dispatched through a Room, carries the roomId for
   *  trace enrichment. Phase-verify appends `'room:{roomId}'` to the trace's
   *  frameworkMarkers so Sleep Cycle and dashboards can correlate. */
  roomId?: string;
}

export interface VerifyResult {
  verification: VerificationResult;
  passedOracles: string[];
  failedOracles: string[];
  verificationConfidence: number;
  qualityScore: QualityScore;
  pipelineConf?: { composite: number; formula: string };
  confidenceDecision?: ConfidenceDecision;
  shouldCommit: boolean;
  activeHint?: VerificationHint;
  oracleFailurePattern?: string;
  trace: ExecutionTrace;
}

export interface LearnResult {
  trace: ExecutionTrace;
}

// ---------------------------------------------------------------------------
// Internal result types (re-exported from core-loop for phase access)
// ---------------------------------------------------------------------------

export interface WorkerResult {
  mutations: Array<{
    file: string;
    content: string;
    diff: string;
    explanation: string;
  }>;
  proposedToolCalls: ToolCall[];
  uncertainties?: string[];
  tokensConsumed: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  thinkingTokensUsed?: number;
  thinking?: string;
  durationMs: number;
  proposedContent?: string;
  nonRetryableError?: string;
  /**
   * Agent Conversation: propagated from WorkerLoopResult when the agent
   * called attempt_completion with needsUserInput=true. The core loop reads
   * this flag to short-circuit into a TaskResult with status='input-required'.
   */
  needsUserInput?: boolean;
}

export interface VerificationResult {
  passed: boolean;
  verdicts: Record<string, OracleVerdict>;
  reason?: string;
  epistemicDecision?: EpistemicGateDecision;
  aggregateConfidence?: number;
  caveats?: string[];
}

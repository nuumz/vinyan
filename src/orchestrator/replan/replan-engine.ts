/**
 * Replan Engine — Wave 2. Generates structurally different alternative plans
 * when the goal-satisfaction outer loop reports unmet goal.
 *
 * A1: LLM produces candidate DAGs; the engine's rule-based gates
 * (novelty hash, trigram similarity, budget cap, maxReplans) decide accept/reject.
 * A3: every stopping criterion is a pure function of numeric inputs — no LLM in governance.
 * A7: honest null on exhaustion so the outer loop can escalate.
 */
import { createHash } from 'node:crypto';
import type { VinyanBus } from '../../core/bus.ts';
import type { PerceptionAssembler, TaskDecomposer } from '../core-loop.ts';
import type { GoalSatisfaction } from '../goal-satisfaction/goal-evaluator.ts';
import type { RoutingLevel, TaskDAG, TaskInput, TaskResult, WorkingMemoryState } from '../types.ts';
import type { FailureContext } from './replan-prompt.ts';

export interface ReplanEngineConfig {
  enabled: boolean;
  /** Max replan attempts before honest escalation. Default 2. */
  maxReplans: number;
  /** Replan token spend as fraction of remaining task budget. Default 0.20. */
  tokenSpendCapFraction: number;
  /** Upper bound on trigram similarity between new and prior approach text. Default 0.85. */
  trigramSimilarityMax: number;
}

export const DEFAULT_REPLAN_CONFIG: ReplanEngineConfig = {
  enabled: false,
  maxReplans: 2,
  tokenSpendCapFraction: 0.2,
  trigramSimilarityMax: 0.85,
};

export interface ReplanContext {
  previousInput: TaskInput;
  previousPlan?: TaskDAG;
  previousResult: TaskResult;
  failedApproaches: WorkingMemoryState['failedApproaches'];
  goalSatisfaction: GoalSatisfaction;
  iteration: number;
  priorPlanSignatures: string[];
  tokensSpentOnReplanning: number;
  remainingTaskBudgetTokens: number;
}

export interface ReplanOutcome {
  input: TaskInput;
  plan: TaskDAG;
  planSignature: string;
  tokensUsed: number;
}

export interface ReplanEngine {
  generateAlternative(ctx: ReplanContext): Promise<ReplanOutcome | null>;
}

export interface ReplanEngineDeps {
  decomposer: TaskDecomposer;
  perception: PerceptionAssembler;
  bus?: VinyanBus;
}

export class DefaultReplanEngine implements ReplanEngine {
  constructor(
    private readonly deps: ReplanEngineDeps,
    private readonly cfg: ReplanEngineConfig,
  ) {}

  async generateAlternative(ctx: ReplanContext): Promise<ReplanOutcome | null> {
    const taskId = ctx.previousInput.id;

    // ── Rule gate 1: max replans ────────────────────────────────
    if (ctx.iteration >= this.cfg.maxReplans) {
      this.emitReject(taskId, ctx.iteration, 'max-replans');
      return null;
    }

    // ── Rule gate 2: budget cap (pre-LLM, cheap) ────────────────
    if (ctx.remainingTaskBudgetTokens > 0) {
      const fraction = ctx.tokensSpentOnReplanning / ctx.remainingTaskBudgetTokens;
      if (fraction >= this.cfg.tokenSpendCapFraction) {
        this.emitReject(taskId, ctx.iteration, 'budget-cap');
        return null;
      }
    }

    // ── Decomposer must support replan (stub path safety) ──────
    if (typeof this.deps.decomposer.replan !== 'function') {
      this.emitReject(taskId, ctx.iteration, 'decomposer-no-replan');
      return null;
    }

    // ── Perception (L1 heuristic — cheap, self-contained) ──────
    let perception: Awaited<ReturnType<PerceptionAssembler['assemble']>>;
    try {
      perception = await this.deps.perception.assemble(ctx.previousInput, 1 as RoutingLevel);
    } catch {
      this.emitReject(taskId, ctx.iteration, 'perception-failed');
      return null;
    }

    // ── Build failure context + invoke decomposer.replan ──────
    const failure: FailureContext = {
      failedApproaches: ctx.failedApproaches,
      goalSatisfaction: ctx.goalSatisfaction,
      previousPlanDescription: describePriorResult(ctx.previousResult),
      iteration: ctx.iteration,
    };

    const memory: WorkingMemoryState = {
      failedApproaches: ctx.failedApproaches,
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    };

    let newDag: TaskDAG;
    try {
      newDag = await this.deps.decomposer.replan(ctx.previousInput, perception, memory, failure);
    } catch {
      this.emitReject(taskId, ctx.iteration, 'decomposer-failed');
      return null;
    }

    if (newDag.isFallback) {
      this.emitReject(taskId, ctx.iteration, 'decomposer-fallback');
      return null;
    }

    // ── Rule gate 3: plan signature novelty ───────────────────
    const newSig = computePlanSignature(newDag);
    if (ctx.priorPlanSignatures.includes(newSig)) {
      this.emitReject(taskId, ctx.iteration, 'duplicate-signature');
      return null;
    }

    // ── Rule gate 4: trigram similarity vs failed approaches ──
    const newApproachText = dagApproachText(newDag);
    for (const prior of ctx.failedApproaches) {
      const sim = trigramSimilarity(newApproachText, prior.approach);
      if (sim >= this.cfg.trigramSimilarityMax) {
        this.emitReject(taskId, ctx.iteration, 'high-similarity');
        return null;
      }
    }

    // ── Accepted ──────────────────────────────────────────────
    this.deps.bus?.emit('replan:accepted', {
      taskId,
      iteration: ctx.iteration,
      planSignature: newSig,
    });

    return {
      input: ctx.previousInput,
      plan: newDag,
      planSignature: newSig,
      tokensUsed: 0,
    };
  }

  private emitReject(taskId: string, iteration: number, reason: string): void {
    this.deps.bus?.emit('replan:rejected', { taskId, iteration, reason });
  }
}

export function computePlanSignature(dag: TaskDAG): string {
  const parts = dag.nodes
    .map((n) => `${n.id}::${[...n.targetFiles].sort().join(',')}`)
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export function dagApproachText(dag: TaskDAG): string {
  return dag.nodes.map((n) => n.description).join(' | ');
}

export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const normalized = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length < 3) return new Set(normalized ? [normalized] : []);
  const out = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    out.add(normalized.slice(i, i + 3));
  }
  return out;
}

function describePriorResult(result: TaskResult): string {
  const hints: string[] = [];
  if (result.trace?.approach) hints.push(`approach=${result.trace.approach}`);
  for (const m of result.mutations) hints.push(`edit ${m.file}`);
  return hints.join('; ') || 'unknown prior plan';
}

/**
 * Goal Evaluator — deterministic-only goal satisfaction scoring.
 *
 * Wave 1 MVP: reuses the existing goal-alignment-verifier (C1-C4) and adds
 * an acceptance-criteria coverage check (C5). LLM stage is a TODO hook for
 * Wave 1b — the MVP never populates it.
 *
 * A1: generation and verification are different components.
 * A3: no LLM in the evaluator — all checks are rule-based.
 */
import type { HypothesisTuple, OracleVerdict } from '../../core/types.ts';
import { verify as goalAlignmentVerify } from '../../oracle/goal-alignment/goal-alignment-verifier.ts';
import type { TaskInput, TaskResult, TaskUnderstanding } from '../types.ts';
import type { WorkingMemory } from '../working-memory.ts';

export interface GoalBlocker {
  category: string;
  detail: string;
  resolvable: boolean;
}

export interface GoalSatisfaction {
  score: number;
  basis: 'deterministic' | 'llm' | 'llm-gated-off';
  blockers: GoalBlocker[];
  passedChecks: string[];
  failedChecks: string[];
}

export interface GoalEvaluationContext {
  input: TaskInput;
  result: TaskResult;
  oracleVerdicts: OracleVerdict[];
  workingMemory: WorkingMemory;
  understanding?: TaskUnderstanding;
}

/** Optional LLM stage hook — Wave 1b wires this. MVP leaves it undefined. */
export interface LLMGoalChecker {
  check(ctx: GoalEvaluationContext): Promise<{
    score: number;
    blockers: GoalBlocker[];
    passedChecks: string[];
    failedChecks: string[];
  }>;
}

export interface GoalEvaluator {
  evaluate(ctx: GoalEvaluationContext): Promise<GoalSatisfaction>;
}

/**
 * Default deterministic evaluator — wraps goal-alignment-verifier (C1-C4)
 * and layers acceptance-criteria coverage (C5) on top.
 */
export class DefaultGoalEvaluator implements GoalEvaluator {
  private readonly llmChecker?: LLMGoalChecker;

  constructor(options?: { llmChecker?: LLMGoalChecker }) {
    this.llmChecker = options?.llmChecker;
  }

  async evaluate(ctx: GoalEvaluationContext): Promise<GoalSatisfaction> {
    const passedChecks: string[] = [];
    const failedChecks: string[] = [];
    const blockers: GoalBlocker[] = [];

    // ── C1-C4: reuse goal-alignment-verifier ──────────────────────────
    const alignment = this.runAlignmentChecks(ctx);
    for (const name of alignment.passedChecks) passedChecks.push(name);
    for (const name of alignment.failedChecks) failedChecks.push(name);
    for (const blocker of alignment.blockers) blockers.push(blocker);

    // ── Oracle contradiction detection ────────────────────────────────
    const contradictions = this.detectOracleContradictions(ctx.oracleVerdicts);
    if (contradictions.length > 0) {
      failedChecks.push('oracle-consistency');
      for (const c of contradictions) {
        blockers.push({ category: 'oracle-contradiction', detail: c, resolvable: true });
      }
    } else {
      passedChecks.push('oracle-consistency');
    }

    // ── C5: acceptance-criteria coverage ──────────────────────────────
    const coverage = this.checkAcceptanceCriteriaCoverage(ctx);
    for (const name of coverage.passedChecks) passedChecks.push(name);
    for (const name of coverage.failedChecks) failedChecks.push(name);
    for (const blocker of coverage.blockers) blockers.push(blocker);

    // ── Aggregate score ───────────────────────────────────────────────
    const total = passedChecks.length + failedChecks.length;
    const score = total === 0 ? 0 : passedChecks.length / total;

    // Wave 1b will wire llmChecker here — MVP leaves it as a TODO.
    const basis: GoalSatisfaction['basis'] = this.llmChecker ? 'llm' : 'deterministic';

    return { score, basis, blockers, passedChecks, failedChecks };
  }

  private runAlignmentChecks(ctx: GoalEvaluationContext): {
    passedChecks: string[];
    failedChecks: string[];
    blockers: GoalBlocker[];
  } {
    const passedChecks: string[] = [];
    const failedChecks: string[] = [];
    const blockers: GoalBlocker[] = [];

    const understanding = ctx.understanding;
    if (!understanding) {
      return { passedChecks, failedChecks, blockers };
    }

    // Build one HypothesisTuple per mutation, or a synthetic one for non-mutation tasks.
    const mutations = ctx.result.mutations;
    const tuples: HypothesisTuple[] = mutations.length > 0
      ? mutations.map((m) => ({
          target: m.file,
          pattern: 'goal-alignment',
          context: { content: this.extractMutationContent(m, ctx) },
          workspace: '.',
        }))
      : [{
          target: ctx.input.targetFiles?.[0] ?? ctx.input.id,
          pattern: 'goal-alignment',
          context: ctx.result.answer ? { content: ctx.result.answer } : {},
          workspace: '.',
        }];

    // Aggregate: a check passes overall only if it passes for every tuple.
    const perCheckPass: Record<string, boolean> = {};
    const perCheckReasons: Record<string, string[]> = {};

    for (const tuple of tuples) {
      const response = goalAlignmentVerify(tuple, understanding, ctx.input.targetFiles);
      if (response.type === 'abstained') {
        continue;
      }
      const verdict: OracleVerdict = response;
      for (const ev of verdict.evidence) {
        const checkName = this.extractCheckName(ev.snippet);
        if (!checkName) continue;
        if (perCheckPass[checkName] === undefined) perCheckPass[checkName] = true;
      }
      if (!verdict.verified && verdict.reason) {
        // Parse reasons back out — multiple checks may have failed
        const reasons = verdict.reason.split(';').map((r) => r.trim()).filter(Boolean);
        for (const reason of reasons) {
          const checkName = this.mapReasonToCheck(reason);
          perCheckPass[checkName] = false;
          (perCheckReasons[checkName] ??= []).push(reason);
        }
      }
    }

    // Ensure all four alignment checks show up in the score regardless of outcome.
    const alignmentChecks = ['mutation-expectation', 'target-symbol', 'action-verb', 'file-scope'];
    for (const name of alignmentChecks) {
      const passed = perCheckPass[name] !== false;
      if (passed) {
        passedChecks.push(name);
      } else {
        failedChecks.push(name);
        const reasons = perCheckReasons[name] ?? ['goal alignment check failed'];
        blockers.push({
          category: name,
          detail: reasons.join('; '),
          resolvable: name !== 'mutation-expectation',
        });
      }
    }

    return { passedChecks, failedChecks, blockers };
  }

  private extractMutationContent(
    mutation: TaskResult['mutations'][number],
    ctx: GoalEvaluationContext,
  ): string {
    // Prefer worker-proposed content when available; diff is a fallback signal.
    if (ctx.result.answer) return ctx.result.answer;
    return mutation.diff;
  }

  private extractCheckName(snippet: string): string | null {
    const known = ['mutation-expectation', 'target-symbol', 'action-verb', 'file-scope'];
    for (const name of known) {
      if (snippet.toLowerCase().includes(name.replace(/-/g, ' '))) return name;
    }
    return null;
  }

  private mapReasonToCheck(reason: string): string {
    const lower = reason.toLowerCase();
    if (lower.includes('mutation')) return 'mutation-expectation';
    if (lower.includes('symbol')) return 'target-symbol';
    if (lower.includes('verb') || lower.includes('creation')) return 'action-verb';
    if (lower.includes('scope') || lower.includes('outside expected')) return 'file-scope';
    return 'alignment';
  }

  private detectOracleContradictions(verdicts: OracleVerdict[]): string[] {
    const passed: string[] = [];
    const failed: string[] = [];
    for (const v of verdicts) {
      const name = v.oracleName ?? 'unknown';
      if (v.verified) passed.push(name);
      else failed.push(name);
    }
    if (passed.length > 0 && failed.length > 0) {
      return [`passed=[${passed.join(',')}] failed=[${failed.join(',')}]`];
    }
    return [];
  }

  private checkAcceptanceCriteriaCoverage(ctx: GoalEvaluationContext): {
    passedChecks: string[];
    failedChecks: string[];
    blockers: GoalBlocker[];
  } {
    const passedChecks: string[] = [];
    const failedChecks: string[] = [];
    const blockers: GoalBlocker[] = [];

    const criteria = ctx.input.acceptanceCriteria;
    if (!criteria || criteria.length === 0) {
      return { passedChecks, failedChecks, blockers };
    }

    const corpus = this.buildEvidenceCorpus(ctx);

    for (const criterion of criteria) {
      const tokens = this.tokenize(criterion);
      if (tokens.length === 0) {
        passedChecks.push(`acceptance:${criterion}`);
        continue;
      }
      const hitCount = tokens.filter((t) => corpus.includes(t)).length;
      const ratio = hitCount / tokens.length;
      if (ratio >= 0.5) {
        passedChecks.push(`acceptance:${criterion}`);
      } else {
        failedChecks.push(`acceptance:${criterion}`);
        blockers.push({
          category: 'acceptance-criteria',
          detail: `Criterion not satisfied: "${criterion}" (coverage ${Math.round(ratio * 100)}%)`,
          resolvable: true,
        });
      }
    }

    return { passedChecks, failedChecks, blockers };
  }

  private buildEvidenceCorpus(ctx: GoalEvaluationContext): string {
    const parts: string[] = [];
    if (ctx.result.answer) parts.push(ctx.result.answer);
    for (const m of ctx.result.mutations) {
      parts.push(m.file);
      if (m.diff) parts.push(m.diff);
    }
    // World-graph / working-memory scoped facts contribute too.
    const snapshot = ctx.workingMemory.getSnapshot();
    for (const fact of snapshot.scopedFacts ?? []) {
      parts.push(`${fact.target} ${fact.pattern}`);
    }
    return parts.join(' ').toLowerCase();
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3);
  }
}

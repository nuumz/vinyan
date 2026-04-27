/**
 * AgentRouter — deterministic, rule-first specialist selection.
 *
 * Decision order:
 *   1. CLI override (`input.agentId` set by `--agent <id>`) → 'override'
 *   2. Rule-based scoring over AgentSpec.routingHints
 *      - top score ≥ 0.4 AND margin-over-runner-up ≥ 0.15 → 'rule-match'
 *   3. LLM fallback (intent-resolver's agent catalog path) → 'llm'
 *   4. Registry default → 'default'
 *
 * A3 compliance: steps 1/2/4 are pure functions of deterministic inputs.
 * Only step 3 invokes an LLM — and its result is validated against the
 * registry before use (no hallucinated agent ids).
 *
 * The router produces a DECISION (agentId + reason + score) but does NOT
 * invoke the LLM itself — it returns a sentinel signalling "needs LLM" so
 * the caller (core-loop) can orchestrate the intent resolver call that's
 * already happening.
 */

import type { AgentRegistry } from './agents/registry.ts';
import { analyzeRequirements } from './capabilities/capability-analyzer.ts';
import { analyzeFit } from './capabilities/capability-router.ts';
import type { CapabilityGapAnalysis, CapabilityRequirement, PerceptualHierarchy, TaskInput } from './types.ts';

export type AgentRouteReason = 'override' | 'rule-match' | 'needs-llm' | 'default';

export interface AgentRouteDecision {
  agentId: string;
  reason: AgentRouteReason;
  /** Composite weighted fit score from capability evaluation. 0 for override/default/needs-llm. */
  score: number;
  /** Runner-up for observability (rule-match path only). */
  runnerUp?: { agentId: string; score: number };
  /** Capability gap analysis attached when the router actually scored agents. */
  capabilityAnalysis?: CapabilityGapAnalysis;
}

export interface AgentRouter {
  /**
   * Select a specialist for this task.
   *
   * `routingLevel` is an optional hint. When provided, agents whose
   * `routingHints.minLevel` exceeds the task's routing level are excluded
   * from the rule-match candidate set — e.g., `system-designer` (minLevel:1)
   * is not considered for reflex-tier L0 tasks. When the hint is absent the
   * router keeps pre-multi-agent behaviour (minLevel ignored) so callers
   * that don't know the routing level yet still get a deterministic choice.
   */
  route(input: TaskInput, perception?: PerceptualHierarchy, routingLevel?: number): AgentRouteDecision;
}

/** Thresholds for rule-based selection. Tuned for 4 built-ins. */
const RULE_MIN_SCORE = 0.4;
const RULE_MIN_MARGIN = 0.15;

export interface DefaultAgentRouterDeps {
  registry: AgentRegistry;
}

export function createAgentRouter(deps: DefaultAgentRouterDeps): AgentRouter {
  return {
    route(input, perception, routingLevel) {
      const registry = deps.registry;

      // Step 1: CLI override — user selected the specialist explicitly
      if (input.agentId && registry.has(input.agentId)) {
        return { agentId: input.agentId, reason: 'override', score: 0 };
      }

      // Step 2a: legacy creative-team rule routing. Kept transitional so we
      // do not break creative tests during the capability-first migration.
      // This is INPUT routing on raw goal text BEFORE the LLM runs — allowed
      // by `.github/instructions/no-llm-output-postfilter.instructions.md`.
      const creativeAgentId = matchCreativeSpecialist(input.goal, input);
      if (creativeAgentId && registry.has(creativeAgentId)) {
        return { agentId: creativeAgentId, reason: 'rule-match', score: 1 };
      }

      // Step 2b: capability-first scoring. Replaces the legacy extension /
      // framework / domain weighted scorer — agents now compete on declared
      // CapabilityClaims that the capability-analyzer can match against
      // task requirements derived from the fingerprint.
      const allAgents = registry.listAgents();
      const agents =
        typeof routingLevel === 'number'
          ? allAgents.filter((a) => {
              const min = a.routingHints?.minLevel;
              return min === undefined || routingLevel >= min;
            })
          : allAgents;

      const requirements: CapabilityRequirement[] = analyzeRequirements({
        task: input,
        perception,
      });
      const analysis = analyzeFit(input.id, agents, requirements);
      const top = analysis.candidates[0];
      const runner = analysis.candidates[1];

      if (top && top.fitScore >= RULE_MIN_SCORE) {
        const margin = top.fitScore - (runner?.fitScore ?? 0);
        if (margin >= RULE_MIN_MARGIN) {
          return {
            agentId: top.agentId,
            reason: 'rule-match',
            score: top.fitScore,
            runnerUp: runner ? { agentId: runner.agentId, score: runner.fitScore } : undefined,
            capabilityAnalysis: analysis,
          };
        }
      }

      // Step 3: ambiguous — caller should invoke the LLM intent resolver
      // (the resolver will emit agentId in its response, core-loop wires it in).
      // We return the default as a placeholder, but mark `reason: 'needs-llm'`
      // so the caller knows to defer the final decision to the classifier.
      return {
        agentId: registry.defaultAgent().id,
        reason: 'needs-llm',
        score: top?.fitScore ?? 0,
        runnerUp: runner ? { agentId: runner.agentId, score: runner.fitScore } : undefined,
        capabilityAnalysis: analysis,
      };
    },
  };
}

// ── Legacy creative-specialist rule routing ────────────────────────
// Pre-LLM input routing on raw goal text. Stays in place during the
// capability-first migration — its replacement is structured capability
// requirements emitted by the LLM intent resolver, which will route via
// the same `analyzeFit` path once those plumbing pieces land.

const CODE_CONTEXT_RE =
  /\b(code|coding|bug|refactor|compile|typescript|javascript|python|api|schema|database|test suite)\b|โค้ด|บั๊ก|รีแฟกเตอร์/i;
const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cs|cpp|c|h|sql|vue|svelte|astro)$/i;
const CREATIVE_CONTEXT_RE =
  /นิยาย|เว็บตูน|เรื่องสั้น|เรื่องยาว|หนังสือ|พล็อต|ตัวละคร|ฉาก|ตอนที่|บทที่|แต่งเรื่อง|novel|fiction|story|webtoon|book|plot|character|chapter|scene|screenplay|script/i;

function matchCreativeSpecialist(goal: string, input: Pick<TaskInput, 'taskType' | 'targetFiles'>): string | null {
  const targetFiles = input.targetFiles ?? [];
  if (targetFiles.some((file) => CODE_FILE_RE.test(file))) return null;
  if (
    input.taskType === 'code' &&
    targetFiles.length > 0 &&
    targetFiles.every((file) => !/\.(md|txt|rst)$/i.test(file))
  ) {
    return null;
  }

  const lower = goal.toLowerCase();
  if (!CREATIVE_CONTEXT_RE.test(lower) || CODE_CONTEXT_RE.test(lower)) return null;

  if (/บรรณาธิการ|แก้สำนวน|ปรับสำนวน|proofread|edit|line edit|copyedit/i.test(lower)) return 'editor';
  if (/วิจารณ์|รีวิว|ประเมิน|review|critic|critique|publish-readiness/i.test(lower)) return 'critic';
  if (/พล็อต|ไอเดีย|premise|plot|logline|twist|ตัวละคร/i.test(lower)) return 'plot-architect';
  if (/วางแผน|กลยุทธ|กลยุทธ์|โครงเรื่อง|outline|strategy|structure|episode plan/i.test(lower)) {
    return 'story-strategist';
  }
  if (/ฉาก|บทที่|ตอนที่|chapter|scene|dialogue|draft this|rewrite this/i.test(lower)) return 'novelist';

  return 'creative-director';
}

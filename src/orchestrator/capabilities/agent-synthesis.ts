/**
 * Agent synthesis — task-scoped construction of an AgentSpec when no
 * existing agent fits the requirement set.
 *
 * Vinyan axioms in play:
 *   - A1 (gen ≠ verify): synthesis is a *generator*. The capability router
 *     still verifies the resulting agent's fit deterministically.
 *   - A3 (deterministic governance): no LLM in this path. The plan is built
 *     from `CapabilityGapAnalysis` (rule-based) and the spec is assembled
 *     from declarative inputs.
 *   - A6 (zero-trust execution): the synthesized spec carries a strictly
 *     RESTRICTIVE ACL. We never widen privilege via synthesis.
 *
 * Lifecycle: synthesized agents are task-scoped. The orchestrator registers
 * them on the `AgentRegistry` for the duration of one task and unregisters
 * in `finally`. Promotion to a persistent agent goes through the evolution
 * gate (Phase D), not this module.
 */

import { createHash } from 'node:crypto';
import type {
  AgentCapabilityOverrides,
  AgentSpec,
  AgentSynthesisPlan,
  CapabilityClaim,
  CapabilityGapAnalysis,
  CapabilityRequirement,
} from '../types.ts';

export interface SynthesisOptions {
  /**
   * Hard cap on the number of synthesized claims. Keeps prompts/UI from
   * being flooded by a noisy gap analysis. Default: 6.
   */
  maxClaims?: number;
  /**
   * When true, the synthesized AgentSpec gets `network: false`. Default
   * true — synthesis runs locally; the research path (Phase C) is the
   * place to grant network, and only via config-gated providers.
   */
  forbidNetwork?: boolean;
  /**
   * Allowlist of tool ids the synthesized agent may use. Defaults to the
   * conservative read-only / scratch set. Callers (e.g. Phase D promotion)
   * can widen this only after empirical evidence.
   */
  allowedTools?: string[];
}

const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  'file_read',
  'search_grep',
  'directory_list',
];

const DEFAULT_MAX_CLAIMS = 6;

/**
 * Derive an `AgentSynthesisPlan` from a `CapabilityGapAnalysis`. Returns
 * `null` when there is nothing meaningful to synthesize for — i.e. the gap
 * is empty or every requirement is already met by an existing candidate.
 *
 * Pure: no side effects, deterministic given the same analysis input.
 */
export function planFromGap(
  taskId: string,
  analysis: CapabilityGapAnalysis,
  context?: { goal?: string; rolesHint?: string[] },
): AgentSynthesisPlan | null {
  if (analysis.required.length === 0) return null;

  // Only synthesize for requirements that the BEST candidate (or any
  // candidate) does not satisfy. If `recommendedAction === 'proceed'` we
  // should not be here at all; bail out as a safety net.
  if (analysis.recommendedAction === 'proceed') return null;

  const top = analysis.candidates[0];
  const matchedIds = new Set(top?.matched.map((m) => m.id) ?? []);
  const unmet: CapabilityRequirement[] = analysis.required.filter(
    (r) => !matchedIds.has(r.id),
  );

  if (unmet.length === 0) return null;

  const claims: CapabilityClaim[] = unmet.map((r) => ({
    id: r.id,
    fileExtensions: r.fileExtensions,
    actionVerbs: r.actionVerbs,
    domains: r.domains,
    frameworkMarkers: r.frameworkMarkers,
    role: r.role,
    evidence: 'synthesized',
    // Synthesized claims start tentative — Phase D promotes them to higher
    // confidence only after Wilson LB ≥ threshold over real traces.
    confidence: 0.5,
  }));

  // Roles surface from explicit requirement.role hints + caller context.
  const roleSet = new Set<string>();
  for (const r of unmet) {
    if (r.role) roleSet.add(r.role);
  }
  for (const r of context?.rolesHint ?? []) roleSet.add(r);
  const roles = Array.from(roleSet);

  const suggestedId = makeSyntheticId(taskId, claims);

  return {
    taskId,
    suggestedId,
    capabilities: claims,
    roles,
    rationale: buildRationale(analysis, unmet, context?.goal),
  };
}

/**
 * Build a task-scoped `AgentSpec` from a synthesis plan.
 *
 * The returned spec is NOT registered. The caller (core-loop) is
 * responsible for `registry.registerAgent(...)` and the matching
 * `unregisterAgent` in a `finally` block.
 */
export function synthesizeAgent(
  plan: AgentSynthesisPlan,
  opts: SynthesisOptions = {},
): AgentSpec {
  const maxClaims = opts.maxClaims ?? DEFAULT_MAX_CLAIMS;
  const claims = plan.capabilities.slice(0, maxClaims);
  const allowedTools = opts.allowedTools ? [...opts.allowedTools] : [...DEFAULT_ALLOWED_TOOLS];

  // Strict ACL — synthesis NEVER widens. Network defaults to false; shell
  // and arbitrary writes always false. Reads stay open so the synthesized
  // agent can ground itself on the workspace.
  const capabilityOverrides: AgentCapabilityOverrides = {
    readAny: true,
    writeAny: false,
    network: opts.forbidNetwork === false ? undefined : false,
    shell: false,
  };

  const description = buildDescription(plan);
  const soul = buildSoul(plan);

  return {
    id: plan.suggestedId,
    name: plan.suggestedId,
    description,
    soul,
    allowedTools,
    capabilityOverrides,
    capabilities: claims,
    roles: plan.roles.length > 0 ? plan.roles : undefined,
    builtin: false,
  };
}

// ───────────────────────────── helpers ─────────────────────────────

function makeSyntheticId(taskId: string, claims: CapabilityClaim[]): string {
  // Stable across identical inputs so retries hash to the same id; this
  // also lets `registerAgent` reject double-registration as a tripwire.
  const fingerprint = claims
    .map((c) => c.id)
    .sort()
    .join('|');
  const hash = createHash('sha256')
    .update(`${taskId}::${fingerprint}`)
    .digest('hex')
    .slice(0, 8);
  return `synthetic-${hash}`;
}

function buildDescription(plan: AgentSynthesisPlan): string {
  const ids = plan.capabilities.map((c) => c.id).join(', ');
  const roleStr = plan.roles.length > 0 ? ` [${plan.roles.join(', ')}]` : '';
  return `Task-scoped synthetic agent for ${ids}${roleStr}.`;
}

function buildSoul(plan: AgentSynthesisPlan): string {
  // Minimal seed soul. Synthesized agents do not get an evolved persona —
  // they get a sober, capability-anchored brief so the worker prompt knows
  // why the agent exists and what is in scope.
  const lines: string[] = [];
  lines.push(`# Synthetic Agent: ${plan.suggestedId}`);
  lines.push('');
  lines.push('You were synthesized for a single task because no existing specialist');
  lines.push('claimed the required capabilities. Stay strictly within the scope below.');
  lines.push('');
  lines.push('## Capabilities (claimed, evidence: synthesized)');
  for (const c of plan.capabilities) {
    const tags: string[] = [];
    if (c.role) tags.push(`role=${c.role}`);
    if (c.domains?.length) tags.push(`domains=${c.domains.join('/')}`);
    if (c.fileExtensions?.length) tags.push(`ext=${c.fileExtensions.join('/')}`);
    if (c.frameworkMarkers?.length) tags.push(`fw=${c.frameworkMarkers.join('/')}`);
    const tagStr = tags.length > 0 ? ` (${tags.join('; ')})` : '';
    lines.push(`- ${c.id}${tagStr}`);
  }
  if (plan.roles.length > 0) {
    lines.push('');
    lines.push(`## Roles\n- ${plan.roles.join('\n- ')}`);
  }
  lines.push('');
  lines.push('## Rationale');
  lines.push(plan.rationale);
  lines.push('');
  lines.push('## Constraints');
  lines.push('- Read-only filesystem access; no writes, no network, no shell.');
  lines.push('- Defer to existing specialists when their fit is higher.');
  lines.push('- If you cannot satisfy a requirement, return `{ type: "unknown" }` (A2).');
  return lines.join('\n');
}

function buildRationale(
  analysis: CapabilityGapAnalysis,
  unmet: CapabilityRequirement[],
  goal?: string,
): string {
  const unmetIds = unmet.map((r) => r.id).join(', ');
  const goalLine = goal ? `goal=${truncate(goal, 120)}; ` : '';
  return `${goalLine}gapNormalized=${analysis.gapNormalized.toFixed(2)}; unmet=[${unmetIds}]; recommendedAction=${analysis.recommendedAction}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

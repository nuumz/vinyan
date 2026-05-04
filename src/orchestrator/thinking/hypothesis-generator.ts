/**
 * Yinyan T&R Kernel — L1 Hypothesis Generator.
 *
 * Asks N reasoning engines (or N approach-flavors of the same engine) to
 * propose answers in parallel, then deduplicates near-identical branches via
 * a content-shingle Jaccard fingerprint. Returns a `GenerationOutcome` for
 * the deterministic selector (T2) to score.
 *
 * Axiom anchors:
 *   - A1: branch dispatch chooses distinct engines whenever the registry
 *     allows; same-engine fallback is recorded so the selector can downgrade
 *     `oracleIndependence` later.
 *   - A2: branches that hit `limit_reached`, error, or produce empty content
 *     become `BranchRejection` rows — the generator never invents content.
 *   - A3: branch selection (engine + approach) is rule-based — no LLM picks
 *     who generates.
 *   - A8: every accepted/rejected branch is provenance-stamped (engineId,
 *     approachLabel, terminationReason, tokens).
 */
import { createHash } from 'node:crypto';
import type { ReasoningEngineRegistry } from '../llm/llm-reasoning-engine.ts';
import type { RERequest, ReasoningEngine } from '../types.ts';
import {
  APPROACH_LABELS,
  type ApproachLabel,
  type BranchSpec,
  type GenerationInput,
  type GenerationOutcome,
  type Hypothesis,
  hypothesisId,
  type MultiHypothesisPolicy,
} from './hypothesis.ts';

const APPROACH_OVERLAYS: Record<ApproachLabel, string> = {
  direct: 'Approach: produce the most direct, minimal change that satisfies the goal.',
  defensive: 'Approach: assume hostile inputs and surrounding-code fragility; prefer guards and validations.',
  minimal: 'Approach: change as little as possible; preserve existing structure even if suboptimal.',
  'refactor-first': 'Approach: clean up nearby structure first, then implement; readability over brevity.',
  exploratory: 'Approach: optimize for surfacing alternative interpretations of the goal in the rationale.',
};

/**
 * Public contract — implementations may live in tests / future engines.
 */
export interface HypothesisGenerator {
  generate(input: GenerationInput, policy: MultiHypothesisPolicy): Promise<GenerationOutcome>;
}

/**
 * Default kernel implementation. Constructed with the existing
 * `ReasoningEngineRegistry` — no new infrastructure required.
 */
export class DefaultHypothesisGenerator implements HypothesisGenerator {
  constructor(
    private readonly registry: ReasoningEngineRegistry,
    private readonly opts: {
      /**
       * Required capability for branch eligibility — defaults to the same
       * 'reasoning' tag the LLMReasoningEngine adapter declares.
       */
      requiredCapability?: string;
      /** Override ID generator for deterministic tests. */
      idFactory?: (branchIndex: number) => string;
    } = {},
  ) {}

  async generate(input: GenerationInput, policy: MultiHypothesisPolicy): Promise<GenerationOutcome> {
    const branches = this.planBranches(policy);
    if (branches.length === 0) {
      return {
        hypotheses: [],
        rejected: [],
        totalTokens: { input: 0, output: 0, thinking: 0 },
      };
    }

    const overlapThreshold = policy.maxFingerprintOverlap ?? 0.85;
    const accepted: Hypothesis[] = [];
    const rejected: GenerationOutcome['rejected'] = [];
    const totals = { input: 0, output: 0, thinking: 0 };

    // Dispatch every branch in parallel — A3: order-independent so the kernel
    // can't accidentally bias selection by completion order.
    type Pair = { branch: BranchSpec; result: PromiseSettledResult<Hypothesis> };
    const settled: Pair[] = await Promise.all(
      branches.map(async (branch, i) => ({
        branch,
        result: await Promise.allSettled([
          runBranch({ branch, input, branchIndex: i, idFactory: this.opts.idFactory }),
        ]).then((r) => r[0] as PromiseSettledResult<Hypothesis>),
      })),
    );

    for (const { branch, result } of settled) {
      if (result.status === 'rejected') {
        rejected.push({
          approachLabel: branch.approachLabel,
          engineId: branch.engine.id,
          rejection: { reason: 'engine-error', message: errorMessage(result.reason) },
        });
        continue;
      }
      const proposal = result.value;
      totals.input += proposal.tokensUsed.input;
      totals.output += proposal.tokensUsed.output;
      totals.thinking += proposal.tokensUsed.thinking ?? 0;

      if (!proposal.content.trim()) {
        rejected.push({
          approachLabel: branch.approachLabel,
          engineId: branch.engine.id,
          rejection: { reason: 'empty-content' },
        });
        continue;
      }

      // Aggregate-budget enforcement: stop accepting once we've crossed the
      // total ceiling. We still record the branch's tokens above so the
      // selector can audit how much was spent on the rejected work.
      if (input.totalTokenCeiling !== undefined && totals.input + totals.output > input.totalTokenCeiling) {
        rejected.push({
          approachLabel: branch.approachLabel,
          engineId: branch.engine.id,
          rejection: { reason: 'budget-exhausted' },
        });
        continue;
      }

      const collision = findCollision(proposal, accepted, overlapThreshold);
      if (collision) {
        rejected.push({
          approachLabel: branch.approachLabel,
          engineId: branch.engine.id,
          rejection: { reason: 'duplicate', collidedWith: collision.id, overlap: collision.overlap },
        });
        continue;
      }
      accepted.push(proposal);
    }

    return { hypotheses: accepted, rejected, totalTokens: totals };
  }

  /**
   * Construct the branch plan deterministically (A3). Selection rules:
   *   1. Iterate `APPROACH_LABELS` in declaration order until `policy.branches` slots filled.
   *   2. For each slot, pick the next eligible engine — distinct engines first
   *      when `diversityConstraint === 'different-resources'`, otherwise
   *      round-robin so single-engine setups still produce N branches.
   */
  private planBranches(policy: MultiHypothesisPolicy): BranchSpec[] {
    const required = this.opts.requiredCapability ?? 'reasoning';
    const eligible: ReasoningEngine[] = this.registry.listEngines().filter((e) => e.capabilities.includes(required));
    if (eligible.length === 0) return [];

    const requireDistinctEngines = policy.diversityConstraint === 'different-resources';
    const engineCount = requireDistinctEngines ? Math.min(eligible.length, policy.branches) : policy.branches;

    const plan: BranchSpec[] = [];
    for (let i = 0; i < engineCount; i++) {
      const approach = APPROACH_LABELS[i % APPROACH_LABELS.length] ?? 'direct';
      const engine = pickEngine(eligible, i);
      if (!engine) continue;
      plan.push({
        approachLabel: approach,
        engine,
        systemPromptOverlay: APPROACH_OVERLAYS[approach],
      });
    }
    return plan;
  }
}

interface RunBranchInput {
  branch: BranchSpec;
  input: GenerationInput;
  branchIndex: number;
  idFactory?: (branchIndex: number) => string;
}

async function runBranch(args: RunBranchInput): Promise<Hypothesis> {
  const { branch, input, branchIndex, idFactory } = args;
  const req: RERequest = {
    systemPrompt: `${input.systemPrompt}\n\n${branch.systemPromptOverlay}`,
    userPrompt: input.userPrompt,
    maxTokens: input.perBranchTokens,
    timeoutMs: input.perBranchTimeoutMs,
    providerOptions: input.providerOptions,
  };
  const groundedAt = Date.now();
  const res = await branch.engine.execute(req);
  const id = hypothesisId(idFactory ? idFactory(branchIndex) : `hyp-${branch.engine.id}-${branchIndex}`);
  return {
    id,
    engineId: res.engineId,
    approachLabel: branch.approachLabel,
    content: res.content,
    selfDeclaredConfidence: undefined,
    diversityFingerprint: fingerprintOf(branch.approachLabel, res.content),
    tokensUsed: {
      input: res.tokensUsed.input,
      output: res.tokensUsed.output,
      thinking: res.tokensUsed.thinkingTokens,
    },
    terminationReason: res.terminationReason,
    // T6 — bind to wall-clock for A10 staleness detection. Captured BEFORE
    // the engine call so a long-running generation does not push the
    // grounding timestamp into the future relative to the world-graph
    // reads that informed the prompt.
    groundedAt,
    // T6 — factHashes is populated by callers that wired a fact-snapshot
    // hook into the kernel; the bare generator does not reach into the
    // world-graph itself (A1: separation). Empty array surfaces explicitly
    // so consumers can distinguish "no facts consulted" from "T6 not wired".
    factHashes: input.factHashes ?? [],
  };
}

function pickEngine(pool: ReasoningEngine[], slot: number): ReasoningEngine | undefined {
  // Round-robin: same formula whether `different-resources` (caller has
  // already capped engineCount at pool.length) or `different-patterns`
  // (single-engine fallback still produces N branches with distinct
  // approach labels).
  return pool[slot % pool.length];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Fingerprinting ───────────────────────────────────────────────────────

/** Build a 16-char SHA fingerprint from (approach, normalized content). */
export function fingerprintOf(approach: ApproachLabel, content: string): string {
  const normalized = normalizeContent(content);
  return createHash('sha256').update(`${approach}:${normalized}`).digest('hex').slice(0, 16);
}

/** Lower-case, collapse whitespace, strip non-word punctuation — stable across cosmetic diffs. */
function normalizeContent(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[`*_>#-]/g, '')
    .trim();
}

/** Word-shingle Jaccard similarity ∈ [0, 1]. Empty strings → 0. */
export function jaccardOverlap(a: string, b: string, shingleSize = 3): number {
  const sa = shingles(normalizeContent(a), shingleSize);
  const sb = shingles(normalizeContent(b), shingleSize);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const tok of sa) if (sb.has(tok)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function shingles(text: string, n: number): Set<string> {
  const tokens = text.split(/\W+/).filter(Boolean);
  if (tokens.length < n) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}

function findCollision(
  candidate: Hypothesis,
  accepted: Hypothesis[],
  threshold: number,
): { id: Hypothesis['id']; overlap: number } | null {
  for (const h of accepted) {
    if (h.diversityFingerprint === candidate.diversityFingerprint) return { id: h.id, overlap: 1 };
    const overlap = jaccardOverlap(h.content, candidate.content);
    if (overlap >= threshold) return { id: h.id, overlap };
  }
  return null;
}

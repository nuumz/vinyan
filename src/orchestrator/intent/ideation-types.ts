/**
 * Ideation types — output of phase-brainstorm.
 *
 * Produced by the Brainstorm Room (drafters + integrator + critic) BEFORE
 * Perceive/Spec phases. Captures N candidate approaches the human can pick
 * from. The chosen candidate becomes a constraint passed to subsequent phases
 * so the rest of the pipeline doesn't re-derive intent.
 *
 * Axiom alignment:
 *   - A1: drafters and critic are distinct LLM calls / roles (enforced by
 *         Brainstorm Room). The result here is a pure data structure.
 *   - A2: `'unknown'` candidates are a legitimate output; the integrator may
 *         flag every approach as risky.
 *   - A7: ranked candidates with explicit risk notes make uncertainty visible
 *         before anyone writes code.
 */
import { z } from 'zod/v4';

export const ESTIMATED_COMPLEXITY_VOCAB = ['trivial', 'small', 'medium', 'large', 'unknown'] as const;
export type EstimatedComplexity = (typeof ESTIMATED_COMPLEXITY_VOCAB)[number];

export const IdeationCandidateSchema = z.object({
  /** Stable id within the IdeationResult (e.g., 'cand-0'). */
  id: z.string().min(1),
  /** Short headline shown to the user (≤ 80 chars). */
  title: z.string().min(3).max(120),
  /** Sentence-paragraph describing the approach. */
  approach: z.string().min(10),
  /** Why this approach over alternatives. */
  rationale: z.string().min(5),
  /** Risk notes — drafter-flagged caveats. Empty when there are none. */
  riskNotes: z.array(z.string()).default([]),
  /** Coarse complexity tag — used by Predict/Plan to seed budget hints. */
  estComplexity: z.enum(ESTIMATED_COMPLEXITY_VOCAB),
  /** Critic-assigned score in [0,1]. Drives default ranking. */
  score: z.number().min(0).max(1),
});
export type IdeationCandidate = z.infer<typeof IdeationCandidateSchema>;

export const IdeationResultSchema = z.object({
  /** Candidate set — at least 2, capped to keep token cost bounded. */
  candidates: z.array(IdeationCandidateSchema).min(2).max(6),
  /** Candidate ids ranked best→worst. Length must equal candidates.length. */
  rankedIds: z.array(z.string()),
  /** id of the candidate the user (or auto-pick) approved. Absent → no pick. */
  approvedCandidateId: z.string().optional(),
  /** Critic's confidence that the top candidate is meaningfully better than the next. */
  convergenceScore: z.number().min(0).max(1),
});
export type IdeationResult = z.infer<typeof IdeationResultSchema>;

/**
 * Look up the approved candidate (if any). Returns null when no candidate
 * has been approved or the recorded id no longer exists in the candidate set.
 */
export function getApprovedCandidate(result: IdeationResult): IdeationCandidate | null {
  if (!result.approvedCandidateId) return null;
  return result.candidates.find((c) => c.id === result.approvedCandidateId) ?? null;
}

/**
 * Project the chosen candidate's approach + rationale into a constraint string
 * that downstream phases can consume via TaskInput.constraints. Uses an
 * `APPROACH:` prefix so prompt assembly can highlight it distinctly.
 */
export function ideationToConstraint(result: IdeationResult): string | null {
  const chosen = getApprovedCandidate(result);
  if (!chosen) return null;
  const risks = chosen.riskNotes.length > 0 ? ` (risks: ${chosen.riskNotes.join('; ')})` : '';
  return `APPROACH: ${chosen.title} — ${chosen.approach}${risks}`;
}

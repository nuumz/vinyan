/**
 * Critic adapter — bridges the `SkillImporter`'s narrow `ImporterCriticFn`
 * shape to the real `CriticEngine.review(...)` surface.
 *
 * The importer hands us `{skillId, skillMd, gateVerdict}`; `CriticEngine.review`
 * expects `(proposal, task, perception, acceptanceCriteria?, context?)`. The
 * adapter synthesizes the richer inputs from the skill text:
 *
 *   - `WorkerProposal` — one mutation representing "write this SKILL.md
 *     under `skills/<id>/SKILL.md`" with the importer's gate verdict
 *     summary as the approach/explanation.
 *   - `TaskInput`     — a thin, well-typed stub whose `goal` is
 *     "Import skill <skillId> from external registry".
 *   - `PerceptualHierarchy` — empty, valid skeleton (no repo perception
 *     applies to an imported skill — the importer's Oracle Gate already
 *     handled the structural checks against the quarantine workspace).
 *
 * Axiom anchor: A1 Epistemic Separation — the critic is still a separate
 * LLM call; the adapter only reshapes I/O. A3 Deterministic Governance —
 * no LLM in the adapter path; all synthesis is pure text composition.
 *
 * Result mapping (`CriticResult` → `ImporterCriticVerdict`):
 *
 *   approved   → approved                (pass-through)
 *   confidence → confidence               (pass-through, clamped to [0, 1])
 *   reason +
 *   aspects[]  → notes (joined summary)
 *     - `reason`: primary rejection/approval note (may be absent)
 *     - `aspects`: one "✓/✗ <name>: <explanation>" line per aspect
 *     - empty-on-both → "critic-review: no notes"
 *
 * Error handling: exceptions from `CriticEngine.review` propagate upward.
 * The importer catches them and produces a well-formed `critic-error`
 * rejected state (see `importer.ts` step 5).
 */
import type { TaskInput, PerceptualHierarchy } from '../../orchestrator/types.ts';
import type { CriticEngine, CriticResult, WorkerProposal } from '../../orchestrator/critic/critic-engine.ts';
import type { ImporterCriticFn, ImporterCriticRequest, ImporterCriticVerdict } from './importer.ts';

/**
 * Structural critic interface — anything with a `review(...)` method that
 * matches `CriticEngine['review']`. Tests inject fakes that only implement
 * this method; the optional `clearTask?` hook is not needed by the adapter.
 */
export interface CriticAdapterDeps {
  readonly critic: Pick<CriticEngine, 'review'>;
}

/** Build an `ImporterCriticFn` that delegates to the real `CriticEngine`. */
export function buildImporterCriticFn(deps: CriticAdapterDeps): ImporterCriticFn {
  return async (req: ImporterCriticRequest): Promise<ImporterCriticVerdict> => {
    const proposal = synthesizeProposal(req);
    const task = synthesizeTaskInput(req);
    const perception = synthesizePerception();

    const result = await deps.critic.review(proposal, task, perception);
    return mapCriticResult(result);
  };
}

function synthesizeProposal(req: ImporterCriticRequest): WorkerProposal {
  const gateSummary = buildGateSummary(req);
  return {
    approach: `Import skill "${req.skillId}" from external registry. Gate pre-verified dry-run: ${gateSummary}.`,
    mutations: [
      {
        file: `skills/${req.skillId}/SKILL.md`,
        content: req.skillMd,
        explanation:
          `Write the imported SKILL.md for "${req.skillId}" into the local ` +
          `skill namespace. Review for semantic correctness: clear overview, ` +
          `safe procedure, plausible when-to-use.`,
      },
    ],
  };
}

function buildGateSummary(req: ImporterCriticRequest): string {
  const parts: string[] = [];
  parts.push(`decision=${req.gateVerdict.decision}`);
  if (req.gateVerdict.epistemicDecision) {
    parts.push(`epistemic=${req.gateVerdict.epistemicDecision}`);
  }
  if (typeof req.gateVerdict.aggregateConfidence === 'number') {
    parts.push(`confidence=${req.gateVerdict.aggregateConfidence.toFixed(2)}`);
  }
  const reasons = req.gateVerdict.reasons ?? [];
  if (reasons.length > 0) {
    parts.push(`reasons=[${reasons.join(', ')}]`);
  }
  return parts.join(' ');
}

function synthesizeTaskInput(req: ImporterCriticRequest): TaskInput {
  return {
    id: `skill-import/${req.skillId}`,
    source: 'api',
    goal: `Review the imported SKILL.md for "${req.skillId}" for semantic correctness and safety.`,
    taskType: 'reasoning',
    targetFiles: [`skills/${req.skillId}/SKILL.md`],
    profile: 'default',
    budget: {
      maxTokens: 4096,
      maxDurationMs: 30_000,
      maxRetries: 0,
    },
  };
}

function synthesizePerception(): PerceptualHierarchy {
  return {
    taskTarget: {
      file: '(skill-import)',
      description: 'Imported SKILL.md artifact (pre-promotion review)',
    },
    dependencyCone: {
      directImporters: [],
      directImportees: [],
      transitiveBlastRadius: 0,
    },
    diagnostics: {
      lintWarnings: [],
      typeErrors: [],
      failingTests: [],
    },
    verifiedFacts: [],
    runtime: {
      nodeVersion: process.version,
      os: process.platform,
      availableTools: [],
    },
  };
}

function mapCriticResult(result: CriticResult): ImporterCriticVerdict {
  const confidence = Number.isFinite(result.confidence)
    ? Math.max(0, Math.min(1, result.confidence))
    : 0;
  const notes = buildNotes(result);
  return {
    approved: result.approved === true,
    confidence,
    notes,
  };
}

function buildNotes(result: CriticResult): string {
  const parts: string[] = [];
  if (result.reason) parts.push(result.reason);
  for (const aspect of result.aspects ?? []) {
    const tick = aspect.passed ? '✓' : '✗';
    parts.push(`${tick} ${aspect.name}: ${aspect.explanation}`);
  }
  if (parts.length === 0) return 'critic-review: no notes';
  return parts.join('\n');
}

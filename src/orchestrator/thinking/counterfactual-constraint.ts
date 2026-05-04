/**
 * Yinyan T&R Kernel — L4 Counterfactual Replay (constraint extraction).
 *
 * Pure function: takes the structured `ClassifiedFailure[]` produced by
 * `failure-classifier.ts` and emits `CounterfactualConstraint[]` — META-
 * directives that tell the next-attempt LLM HOW to behave differently,
 * NOT just WHAT failed last time.
 *
 * The existing `[FAILED APPROACHES]` prompt section already surfaces the
 * raw verdicts ("X was rejected because Y"). Counterfactual constraints
 * are a complementary signal that converts each failure category into a
 * positive instruction grounded in the failure's evidence.
 *
 * Axiom anchors:
 *   - A1: extraction is deterministic — no LLM call in this file.
 *   - A3: same `ClassifiedFailure[]` always produces the same constraints
 *     and ordering, so phase replay is byte-stable.
 *   - A5: only deterministic failure categories drive directive synthesis.
 *     `unknown` falls back to a generic "re-examine" directive rather
 *     than fabricating a category-specific instruction.
 *   - A7: this is the prediction-error → behavior-change loop. The next
 *     attempt sees actionable feedback, not just historical exhaust.
 *   - A8: each constraint carries the evidence (compact failure messages)
 *     that produced it so the audit trail can replay why a directive was
 *     issued.
 */
import type { ClassifiedFailure, FailureCategory } from '../failure-classifier.ts';

/**
 * Counterfactual META-directive for the next attempt. Distinct from a
 * `ClassifiedFailure` (which describes WHAT happened) — a constraint
 * tells the LLM HOW to behave so the same failure category does not
 * recur on the retry.
 */
export interface CounterfactualConstraint {
  /** Failure category that triggered this constraint. Stable across runs. */
  category: FailureCategory;
  /**
   * Imperative META-directive shown to the next-attempt LLM. Ends with a
   * full stop and reads as a behavior change, not a description of last
   * attempt's failure.
   */
  negativeDirective: string;
  /** How many distinct failures of this category were observed in the input. */
  failureCount: number;
  /**
   * Compact list of failure messages that grounded this constraint. Bounded
   * to `EVIDENCE_LIMIT` so a single-category storm of failures cannot
   * dominate the prompt. The full classified failures still live in
   * working memory for the existing `[FAILED APPROACHES]` section.
   */
  evidence: string[];
}

const EVIDENCE_LIMIT = 3;

/**
 * Category-specific directive templates. Each template encodes WHY the
 * category's failure mode tends to recur and what the model should do
 * differently. Keep templates short — they repeat on every retry so the
 * marginal token cost matters.
 *
 * Adding a new category here is a deliberate change: it surfaces a new
 * line in the `[COUNTERFACTUAL CONSTRAINTS]` prompt section and may shift
 * benchmark token counts. Update `tests/orchestrator/thinking/
 * counterfactual-constraint.test.ts` whenever this map changes.
 */
const DIRECTIVE_TEMPLATES: Record<FailureCategory, string> = {
  type_error:
    'Before any assignment or call, verify type compatibility against the actual signature. Read the type definition before proposing the change, not after.',
  lint_violation:
    'Apply the relevant lint rule mentally to every line you edit. Style violations on retry indicate the lint output was not consulted.',
  test_failure:
    "Re-read each failing test's assertions in detail. Trace your proposed code change through every assertion before submitting.",
  ast_error:
    'Validate syntax by reading the proposed change line by line: brace pairing, statement terminators, balanced parentheses. Submit only after syntactic self-check.',
  goal_misalignment:
    'Restate the user goal in your own words first. Verify your proposed change satisfies that exact restatement, not an adjacent interpretation.',
  hallucination_file:
    'Verify file existence with an explicit Read tool call before referencing it. Do not infer paths from naming conventions.',
  hallucination_import:
    'Verify the imported symbol exists in the target file before adding the import. Inspect the file contents — do not assume the export.',
  hallucination_tool_call:
    'Use only tools listed in the active tool manifest. Do not invent tool names; do not embed pseudo tool-call syntax in narrative output.',
  hallucination_symbol:
    'Confirm every referenced symbol (function, class, variable) exists in the relevant file before proposing changes that use it.',
  overconfidence:
    'Reduce the confidence of any claim by one tier. Mark genuinely uncertain conclusions with explicit hedging instead of asserting them.',
  unknown:
    'Re-examine the previous attempt against the oracle verdicts before proposing the same approach in different wording.',
};

/**
 * Build counterfactual constraints from a flat list of classified failures.
 * Multiple failures of the same category collapse into one constraint with
 * `failureCount === N` and the first `EVIDENCE_LIMIT` messages as evidence.
 *
 * Returns an empty array when no failures are present — callers MUST treat
 * empty as "no counterfactual signal", NOT as "go ahead unconstrained".
 */
export function buildCounterfactualConstraints(failures: readonly ClassifiedFailure[]): CounterfactualConstraint[] {
  if (failures.length === 0) return [];
  const grouped = new Map<FailureCategory, { count: number; evidence: string[] }>();

  for (const f of failures) {
    const cat = (f.category as FailureCategory) ?? 'unknown';
    const current = grouped.get(cat);
    if (current) {
      current.count += 1;
      if (current.evidence.length < EVIDENCE_LIMIT) current.evidence.push(compactMessage(f));
    } else {
      grouped.set(cat, { count: 1, evidence: [compactMessage(f)] });
    }
  }

  // Stable sort by category name so the rendered prompt is byte-stable across
  // runs (Map preserves insertion order, but the input failure order is not
  // guaranteed; sorting eliminates that source of drift — A3).
  const sortedCategories = [...grouped.keys()].sort();
  return sortedCategories.map((cat) => {
    const entry = grouped.get(cat);
    if (!entry) {
      // Defensive: invariant violation guarded so strict-null code stays clean.
      return { category: cat, negativeDirective: DIRECTIVE_TEMPLATES[cat], failureCount: 0, evidence: [] };
    }
    return {
      category: cat,
      negativeDirective: DIRECTIVE_TEMPLATES[cat] ?? DIRECTIVE_TEMPLATES.unknown,
      failureCount: entry.count,
      evidence: entry.evidence,
    };
  });
}

function compactMessage(f: ClassifiedFailure): string {
  const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : '';
  return loc ? `${loc} — ${f.message}` : f.message;
}

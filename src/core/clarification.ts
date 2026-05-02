/**
 * Clarification request types — shared between orchestrator, bus, API, and TUI.
 *
 * Phase D: structured questions let the UI render option chips / checkboxes
 * the user can click instead of forcing them to type a free-form reply. The
 * free-text override is ALWAYS allowed so users can disagree, propose
 * alternatives, or provide context the options don't cover.
 */

export type ClarificationQuestionKind = 'single' | 'multi' | 'free';

export interface ClarificationOption {
  /** Stable machine id (e.g. "romance"). */
  id: string;
  /** Display label shown to the user (e.g. "โรแมนติก-แฟนตาซี"). */
  label: string;
  /** Optional secondary hint line under the label. */
  hint?: string;
  /**
   * Phase C — smart-clarification gate annotation. When true, the UI
   * highlights this option as the LLM ranker's recommended pick (e.g.
   * "Lifestyle (Recommended)"). At most one option per question should
   * carry `suggestedDefault: true`; the smart gate enforces this. Older
   * UI consumers that ignore the field render the option normally.
   */
  suggestedDefault?: boolean;
  /**
   * Phase C — short rationale ("you posted 4 lifestyle clips last week"
   * / "Lifestyle is Vinyan's default for video content"). Surfaced as
   * a tooltip / secondary line. Keep under ~120 chars.
   */
  rationale?: string;
  /**
   * Phase C — optional trend hint sourced from a `ClarificationTrendProvider`.
   * Surfaced as a small badge ("+47% week", "trending on TikTok"). Absent
   * unless a trend provider returned data for this option — the gate is
   * structured-validated to NEVER invent hints when the provider was
   * silent. Keep under ~80 chars.
   */
  trendingHint?: string;
}

export interface ClarificationQuestion {
  /** Stable question id, used when matching responses back. */
  id: string;
  /** The prompt text shown to the user. */
  prompt: string;
  /** Input kind — single choice, multi choice, or free text only. */
  kind: ClarificationQuestionKind;
  /** Options for single/multi kinds. Required unless kind === 'free'. */
  options?: ClarificationOption[];
  /** Whether the user may override the options with free text. Defaults true. */
  allowFreeText: boolean;
  /** Soft cap on selections when kind === 'multi'. Default: all. */
  maxSelections?: number;
  /**
   * Phase C — smart-gate-level rationale shown alongside the question
   * itself (e.g. "Defaults below come from your last 3 sessions"). Per
   * question; per-option rationales live on `ClarificationOption.rationale`.
   */
  questionRationale?: string;
}

export interface ClarificationResponse {
  questionId: string;
  /** Option ids the user picked (empty when kind === 'free' or purely free text). */
  selectedOptionIds: string[];
  /** The user's free-text answer or override. */
  freeText?: string;
}

/**
 * Wrap a legacy string[] question list into structured ClarificationQuestions
 * with kind='free'. Keeps the orchestrator and TUI compatible while consumers
 * migrate to the structured shape.
 */
export function liftStringsToStructured(prompts: string[]): ClarificationQuestion[] {
  return prompts.map((prompt, i) => ({
    id: `q${i + 1}`,
    prompt,
    kind: 'free' as const,
    allowFreeText: true,
  }));
}

/**
 * Progressive disclosure — three level projections of a SKILL.md record.
 *
 * L0  Compact card — id/name/tier/toolsets. Used by `skills_list` to pack
 *     many skills into a single LLM prompt section (budget = L0_BUDGET).
 *
 * L1  Frontmatter + authored body sections (overview, when-to-use, procedure,
 *     ...). Used by `skill_view` to surface one skill in full without the
 *     companion file contents. Truncated to L1_BUDGET if oversized.
 *
 * L2  Individual whitelisted file read — handled separately by the tool
 *     layer (see `src/orchestrator/tools/skill-tools.ts`). This module only
 *     provides the L2 view type so the tool output shape is stable.
 *
 * Axiom anchor: A5 Tiered Trust — list ordering honors `rankOf(tier)` so
 * deterministic skills dominate over heuristic/probabilistic/speculative.
 */

import { type ConfidenceTier, rankOf } from '../core/confidence-tier.ts';
import type { SkillMdRecord } from './skill-md/index.ts';
import { estimateTokens, L0_BUDGET_TOKENS, L1_BUDGET_TOKENS, truncateToTokenBudget } from './token-budget.ts';

// ── View types ──────────────────────────────────────────────────────────

export interface SkillL0View {
  id: string;
  name: string;
  version: string;
  description: string;
  confidenceTier: ConfidenceTier;
  origin: 'local' | 'a2a' | 'mcp' | 'hub' | 'autonomous';
  requiresToolsets: readonly string[];
  fallbackForToolsets: readonly string[];
  platforms?: readonly string[];
  status: 'probation' | 'active' | 'demoted' | 'quarantined' | 'retired';
}

export interface SkillL1View {
  l0: SkillL0View;
  body: {
    overview: string;
    whenToUse: string;
    preconditions?: string;
    procedure: string;
    fileListing?: readonly string[];
    falsificationRaw?: string;
  };
  truncated: boolean;
}

export interface SkillL2View {
  skillId: string;
  relativePath: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

// ── Projections ─────────────────────────────────────────────────────────

export function toL0(record: SkillMdRecord): SkillL0View {
  const fm = record.frontmatter;
  const view: SkillL0View = {
    id: fm.id,
    name: fm.name,
    version: fm.version,
    description: fm.description,
    confidenceTier: fm.confidence_tier,
    origin: fm.origin,
    requiresToolsets: fm.requires_toolsets,
    fallbackForToolsets: fm.fallback_for_toolsets,
    status: fm.status,
  };
  if (fm.platforms !== undefined) {
    view.platforms = fm.platforms;
  }
  return view;
}

/** L1 projection — drops companion files, enforces per-call token budget. */
export function toL1(record: SkillMdRecord): SkillL1View {
  const l0 = toL0(record);
  const rawBody = {
    overview: record.body.overview,
    whenToUse: record.body.whenToUse,
    preconditions: record.body.preconditions,
    procedure: record.body.procedure,
    fileListing: record.body.files,
    falsificationRaw: record.body.falsification?.raw,
  };

  // Measure the aggregate token cost of the body text fields.
  const concatenated = [
    rawBody.overview,
    rawBody.whenToUse,
    rawBody.preconditions ?? '',
    rawBody.procedure,
    rawBody.falsificationRaw ?? '',
  ]
    .join('\n\n')
    .trim();
  if (estimateTokens(concatenated) <= L1_BUDGET_TOKENS) {
    return { l0, body: rawBody, truncated: false };
  }

  // Truncate the longest prose field (procedure is typically the largest).
  // Strategy: keep short fields intact, truncate procedure + falsification.
  const shortFieldsTokens = estimateTokens(
    [rawBody.overview, rawBody.whenToUse, rawBody.preconditions ?? ''].join('\n\n'),
  );
  const remainingBudget = Math.max(500, L1_BUDGET_TOKENS - shortFieldsTokens);
  const truncatedProcedure = truncateToTokenBudget(rawBody.procedure, remainingBudget);
  const truncatedFalsification = rawBody.falsificationRaw
    ? truncateToTokenBudget(rawBody.falsificationRaw, Math.max(200, Math.floor(remainingBudget * 0.2)))
    : undefined;

  const view: SkillL1View = {
    l0,
    body: {
      overview: rawBody.overview,
      whenToUse: rawBody.whenToUse,
      preconditions: rawBody.preconditions,
      procedure: truncatedProcedure.text,
      fileListing: rawBody.fileListing,
      falsificationRaw: truncatedFalsification?.text,
    },
    truncated: truncatedProcedure.truncated || (truncatedFalsification?.truncated ?? false),
  };
  return view;
}

// ── Rendering (L0 list) ─────────────────────────────────────────────────

/**
 * Render a list of L0 views into a compact text block, packed up to
 * `L0_BUDGET_TOKENS`. Views are emitted highest-tier first (descending
 * `rankOf`), so deterministic skills always appear before heuristic ones.
 *
 * Returns the rendered text, the number of skills shown, and the number
 * that were dropped because of the budget (A5, A3).
 */
export function renderL0List(views: readonly SkillL0View[]): { text: string; truncated: number; shown: number } {
  const sorted = [...views].sort((a, b) => rankOf(b.confidenceTier) - rankOf(a.confidenceTier));
  const lines: string[] = [];
  let tokens = 0;
  let shown = 0;

  for (const v of sorted) {
    const line = renderL0Card(v);
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > L0_BUDGET_TOKENS) {
      break;
    }
    lines.push(line);
    tokens += lineTokens;
    shown++;
  }

  const truncated = sorted.length - shown;
  return { text: lines.join('\n'), truncated, shown };
}

/** Canonical one-skill card: `[tier] id@version — name :: description` + toolsets line. */
function renderL0CardImpl(v: SkillL0View): string {
  const header = `[${v.confidenceTier}] ${v.id}@${v.version} (${v.status}) — ${v.name} :: ${v.description}`;
  const toolsetBits: string[] = [];
  if (v.requiresToolsets.length > 0) toolsetBits.push(`requires: ${v.requiresToolsets.join(', ')}`);
  if (v.fallbackForToolsets.length > 0) toolsetBits.push(`fallback: ${v.fallbackForToolsets.join(', ')}`);
  if (v.platforms && v.platforms.length > 0) toolsetBits.push(`platforms: ${v.platforms.join(',')}`);
  return toolsetBits.length > 0 ? `${header}\n  ${toolsetBits.join(' | ')}` : header;
}

// Exposed for tests that need to compute exact packing behavior.
export const renderL0Card = renderL0CardImpl;

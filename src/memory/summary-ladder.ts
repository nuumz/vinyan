/**
 * Summary ladder — rule-based compaction for turns outside the retrieval
 * bundle. A3-audit-safe: derived text, never deletes originals.
 *
 * Plan commit E.
 */

import type { ContentBlock, Turn } from '../orchestrator/types.ts';
import { classifyTurn } from './turn-importance.ts';

export interface LadderSummary {
  text: string;
  summarizedTurns: number;
  filesDiscussed: string[];
  openClarifications: string[];
  resolvedClarifications: Array<{ question: string; answer: string }>;
  /**
   * Phase 1 port: ordered verbatim excerpts of turns classified as
   * `decision` or `clarification` by `turn-importance.ts::classifyTurn`.
   * Rendered into `text` as `→ [Turn K, importance] role: firstLine(200)`
   * lines after the topics/files/clarifications block so the LLM sees
   * the high-signal turns verbatim rather than averaged into topic
   * frequency counts. Empty array when no turns match.
   */
  decisionLines: string[];
}

// Alternation ordering: LONGER extensions first so `config.json` doesn't
// truncate to `config.js`. Regex alternation is non-greedy by default.
const FILE_PATH_REGEX = /[\w\-./]+\.(?:swift|hpp|json|jsx|tsx|yaml|java|cpp|yml|md|rs|ts|js|py|go|rb|kt|php|h|c)\b/g;
const INPUT_REQUIRED_TAG = '[INPUT-REQUIRED]';

function flattenVisibleText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_use') parts.push(`[tool:${block.name}] ${JSON.stringify(block.input)}`);
    else if (block.type === 'tool_result') parts.push(`[result] ${block.content}`);
  }
  return parts.join('\n');
}

/**
 * Extract the first non-empty line of `text`, truncated to `maxChars`
 * with a `…` suffix when clipped. Port of the feature/main session-manager
 * helper (lines 504–523 pre-merge) used for inline KEY-DECISION excerpts.
 *
 * Kept local to this module — no export — so the summary layer owns its
 * rendering format without leaking into the retriever or other consumers.
 */
function firstLineSnippet(text: string, maxChars: number): string {
  let line = '';
  for (const l of text.split('\n')) {
    const trimmed = l.trim();
    if (trimmed.length > 0) {
      line = trimmed;
      break;
    }
  }
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)}…`;
}

function parseInputRequired(text: string): string[] {
  const tagIdx = text.indexOf(INPUT_REQUIRED_TAG);
  if (tagIdx === -1) return [];
  const body = text.slice(tagIdx + INPUT_REQUIRED_TAG.length);
  const questions: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const q = trimmed.slice(2).trim();
      if (q) questions.push(q);
    } else if (trimmed.length > 0 && questions.length > 0) {
      break;
    }
  }
  return questions;
}

export function summarizeTurns(turns: readonly Turn[]): LadderSummary | null {
  if (turns.length === 0) return null;

  const filesDiscussed = new Set<string>();
  const topics = new Map<string, number>();
  const openClarifications: string[] = [];
  const resolvedClarifications: Array<{ question: string; answer: string }> = [];

  // Phase 1 port: track the "assistant [INPUT-REQUIRED] → user reply"
  // transition as we walk so the classifier can flag user replies as
  // decisions without re-running regexes.
  const decisionLines: string[] = [];
  let precededByIR = false;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const text = flattenVisibleText(turn.blocks);

    const fileRefs = text.match(FILE_PATH_REGEX);
    if (fileRefs) {
      for (const f of fileRefs) filesDiscussed.add(f);
    }

    if (turn.role === 'user') {
      const firstLine = text.split('\n')[0]?.slice(0, 80) ?? '';
      const topic = firstLine || '(empty)';
      topics.set(topic, (topics.get(topic) ?? 0) + 1);
    }

    let isIRAssistant = false;
    if (turn.role === 'assistant') {
      const questions = parseInputRequired(text);
      if (questions.length > 0) {
        isIRAssistant = true;
        const next = turns[i + 1];
        if (next && next.role === 'user') {
          const answerText = flattenVisibleText(next.blocks);
          const answer = answerText.split('\n')[0]?.slice(0, 120) ?? '';
          for (const q of questions) resolvedClarifications.push({ question: q, answer });
        } else {
          for (const q of questions) openClarifications.push(q);
        }
      }
    }

    // Classify each turn for inline KEY-DECISION emission. tool_result
    // turns are excluded — they're captured by tool-focused prompt
    // sections elsewhere and would flood the summary if each was rendered
    // verbatim.
    const importance = classifyTurn(turn, { precededByInputRequired: precededByIR });
    if (importance === 'decision' || importance === 'clarification') {
      const excerpt = firstLineSnippet(text, 200);
      decisionLines.push(`→ [Turn ${i + 1}, ${importance}] ${turn.role}: ${excerpt}`);
    }

    // Carry the hint forward: the NEXT entry only sees it when the current
    // entry is an assistant [INPUT-REQUIRED] block. Decision / clarification
    // hints don't chain beyond one turn.
    precededByIR = isIRAssistant;
  }

  const topicSummary = [...topics.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => `${count > 1 ? `${count}x ` : ''}${topic}`)
    .join('; ');

  const fileList = [...filesDiscussed].slice(0, 10);

  const lines: string[] = [];
  lines.push(`[SESSION CONTEXT: ${turns.length} prior turns compacted]`);
  if (topicSummary) lines.push(`Topics: ${topicSummary}`);
  if (fileList.length > 0) lines.push(`Files discussed: ${fileList.join(', ')}`);
  if (resolvedClarifications.length > 0) {
    const sample = resolvedClarifications
      .slice(0, 5)
      .map((r) => `Q: ${r.question} → A: ${r.answer}`)
      .join('; ');
    lines.push(`Resolved clarifications: ${sample}`);
  }
  if (openClarifications.length > 0) {
    lines.push(`Open clarifications (awaiting user): ${openClarifications.slice(0, 5).join('; ')}`);
  }

  // Phase 1 port: append KEY-DECISION lines last so the existing topic /
  // file / clarification framing still reads naturally at the top. Lines
  // are already in turn-index order from the single-pass loop above.
  for (const line of decisionLines) lines.push(line);

  return {
    text: lines.join('\n'),
    summarizedTurns: turns.length,
    filesDiscussed: fileList,
    openClarifications,
    resolvedClarifications,
    decisionLines,
  };
}

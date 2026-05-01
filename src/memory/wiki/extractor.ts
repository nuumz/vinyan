/**
 * Memory Wiki — rule-based extractor.
 *
 * Turns structured inputs (sessions, traces, coding-cli runs, oracle
 * verdicts, user notes) into `WikiPageProposal[]`.
 *
 * The default extractor is **deterministic** — no LLM in the path. It
 * recognizes a small but useful set of patterns:
 *
 *   - oracle verdicts → `task-memory` page summarizing the verification
 *   - failed approaches (from a session/trace summary) → `failure-pattern`
 *   - successful approaches → `workflow-pattern`
 *   - explicit user notes → `concept` / `decision` based on heading
 *   - coding-cli runs → `task-memory` with verification verdict line
 *
 * An optional `LlmWikiSynthesizer` (not implemented in this slice) can
 * later be plugged in to produce richer prose pages — its output still
 * passes through the validator.
 */
import type { WikiPageProposal, WikiSource, WikiSourceRef } from './types.ts';

export interface ExtractContext {
  readonly profile: string;
  readonly actor: string;
  readonly now: number;
}

export interface ExtractedProposals {
  readonly proposals: readonly WikiPageProposal[];
}

export function refOf(source: WikiSource): WikiSourceRef {
  return { id: source.id, contentHash: source.contentHash, kind: source.kind };
}

/**
 * Extract proposals from a session-summary source. Expects the body to
 * be the raw markdown summary; we do best-effort topic + decision +
 * failure extraction.
 */
export function extractFromSession(source: WikiSource, ctx: ExtractContext): ExtractedProposals {
  const ref = refOf(source);
  const proposals: WikiPageProposal[] = [];

  const decisions = grepHeadingBlocks(source.body, /(decision|chose|adopted)/i);
  for (const block of decisions.slice(0, 5)) {
    proposals.push({
      profile: ctx.profile,
      type: 'decision',
      title: titleFromBlock(block, 'Decision'),
      tags: ['session', 'auto-extracted'],
      body: renderDecisionBody(block, ref),
      evidenceTier: 'heuristic',
      confidence: 0.6,
      lifecycle: 'draft',
      sources: [ref],
      actor: ctx.actor,
      reason: 'extracted from session summary',
    });
  }

  const failures = grepHeadingBlocks(source.body, /(fail|failure|did not work|wrong|error|broke|broken)/i);
  for (const block of failures.slice(0, 5)) {
    proposals.push({
      profile: ctx.profile,
      type: 'failure-pattern',
      title: titleFromBlock(block, 'Failure'),
      tags: ['session', 'auto-extracted'],
      body: renderFailureBody(block, ref),
      evidenceTier: 'heuristic',
      confidence: 0.6,
      lifecycle: 'draft',
      sources: [ref],
      actor: ctx.actor,
      reason: 'extracted from session summary',
    });
  }

  const questions = grepLines(source.body, /\?\s*$/);
  for (const q of questions.slice(0, 3)) {
    proposals.push({
      profile: ctx.profile,
      type: 'open-question',
      title: q.length > 80 ? `${q.slice(0, 77)}...` : q,
      tags: ['session', 'open-question'],
      body: `> ${q}\n\n${renderCitationLine(ref)}\n`,
      evidenceTier: 'speculative',
      confidence: 0.4,
      lifecycle: 'draft',
      sources: [ref],
      actor: ctx.actor,
      reason: 'extracted from session summary',
    });
  }

  if (source.provenance.taskId) {
    proposals.push(buildTaskMemoryProposal(source, ctx, ref));
  }

  return { proposals };
}

/**
 * Build a task-memory page from a trace source.
 */
export function extractFromTrace(source: WikiSource, ctx: ExtractContext): ExtractedProposals {
  const ref = refOf(source);
  if (!source.provenance.taskId) {
    return { proposals: [] };
  }
  return { proposals: [buildTaskMemoryProposal(source, ctx, ref)] };
}

/**
 * Build a task-memory page from a coding-cli run.
 */
export function extractFromCodingCliRun(source: WikiSource, ctx: ExtractContext): ExtractedProposals {
  const ref = refOf(source);
  if (!source.provenance.taskId) {
    return { proposals: [] };
  }
  const proposals: WikiPageProposal[] = [
    {
      profile: ctx.profile,
      type: 'task-memory',
      title: `Coding CLI Run — task ${source.provenance.taskId}`,
      tags: ['coding-cli', `task:${source.provenance.taskId}`],
      body: renderCodingCliBody(source, ref),
      evidenceTier: 'heuristic',
      confidence: 0.65,
      lifecycle: 'draft',
      sources: [ref],
      actor: ctx.actor,
      reason: 'extracted from coding-cli run',
    },
  ];
  return { proposals };
}

/**
 * Build a failure-pattern page directly from a structured failure.
 */
export interface FailureExtractInput {
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
}

export function extractFromFailure(
  source: WikiSource,
  failure: FailureExtractInput,
  ctx: ExtractContext,
): ExtractedProposals {
  const ref = refOf(source);
  return {
    proposals: [
      {
        profile: ctx.profile,
        type: 'failure-pattern',
        title: failure.title,
        tags: failure.tags ? [...failure.tags] : ['failure-pattern'],
        body: `${failure.body.trim()}\n\n${renderCitationLine(ref)}\n`,
        evidenceTier: 'heuristic',
        confidence: 0.65,
        lifecycle: 'draft',
        sources: [ref],
        actor: ctx.actor,
        reason: 'recorded failure pattern',
      },
    ],
  };
}

/**
 * Build a generic source-summary page from any plain-text source. Useful
 * for user-notes and web-captures.
 */
export function extractSourceSummary(source: WikiSource, ctx: ExtractContext): ExtractedProposals {
  const ref = refOf(source);
  const heading = firstHeading(source.body) ?? `Source ${source.id.slice(0, 8)}`;
  return {
    proposals: [
      {
        profile: ctx.profile,
        type: 'source-summary',
        title: heading,
        tags: [source.kind],
        body: `${truncate(source.body, 4000)}\n\n${renderCitationLine(ref)}\n`,
        evidenceTier: source.kind === 'verification' ? 'deterministic' : 'probabilistic',
        confidence: source.kind === 'verification' ? 0.95 : 0.55,
        lifecycle: 'draft',
        sources: [ref],
        actor: ctx.actor,
        reason: `auto-summary of ${source.kind}`,
      },
    ],
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function buildTaskMemoryProposal(source: WikiSource, ctx: ExtractContext, ref: WikiSourceRef): WikiPageProposal {
  const taskId = source.provenance.taskId ?? 'unknown';
  return {
    profile: ctx.profile,
    type: 'task-memory',
    title: `Task ${taskId}`,
    tags: ['task-memory', `task:${taskId}`],
    body: `# Task ${taskId}\n\n${truncate(source.body, 4000)}\n\n${renderCitationLine(ref)}\n`,
    evidenceTier: 'heuristic',
    confidence: 0.6,
    lifecycle: 'draft',
    sources: [ref],
    actor: ctx.actor,
    reason: 'task-memory snapshot',
  };
}

function grepHeadingBlocks(body: string, re: RegExp): string[] {
  const out: string[] = [];
  const lines = body.split('\n');
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^#+\s/.test(line)) {
      if (current && current.length > 0) {
        const block = current.join('\n');
        if (re.test(block)) out.push(block);
      }
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current && current.length > 0) {
    const block = current.join('\n');
    if (re.test(block)) out.push(block);
  }
  return out;
}

function grepLines(body: string, re: RegExp): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && re.test(l));
}

function titleFromBlock(block: string, fallback: string): string {
  const firstLine = block.split('\n').find((l) => l.trim().length > 0) ?? '';
  const stripped = firstLine.replace(/^#+\s*/, '').trim();
  if (stripped.length > 80) return `${stripped.slice(0, 77)}...`;
  return stripped || fallback;
}

function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    if (/^#+\s/.test(line)) return line.replace(/^#+\s*/, '').trim();
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n_(truncated at ${max} chars)_`;
}

function renderCitationLine(ref: WikiSourceRef): string {
  return `[Source: ${ref.contentHash.slice(0, 8)}] (${ref.kind})`;
}

function renderDecisionBody(block: string, ref: WikiSourceRef): string {
  return `${block.trim()}\n\n## Provenance\n\n${renderCitationLine(ref)}\n`;
}

function renderFailureBody(block: string, ref: WikiSourceRef): string {
  return `${block.trim()}\n\n## Provenance\n\n${renderCitationLine(ref)}\n\n_Tag this page \`canonical\` only after a human or a verifier confirms the failure mode is real and the lesson is reusable._\n`;
}

function renderCodingCliBody(source: WikiSource, ref: WikiSourceRef): string {
  const meta = source.metadata ?? {};
  const verdict = typeof meta.verdict === 'string' ? `**Verification verdict:** ${meta.verdict}\n\n` : '';
  return `${verdict}${truncate(source.body, 4000)}\n\n${renderCitationLine(ref)}\n`;
}

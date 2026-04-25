/**
 * Commit Message Generator — deterministic-first.
 *
 * Strategy:
 *   1. If a SpecArtifact is present → render a Conventional Commit-style
 *      message from spec.summary + acceptance criteria + affected files.
 *   2. Else if a worker-generated answer is present → use it as the body
 *      with a synthesized title.
 *   3. Else → emit a minimal "chore" message and surface a flag so the
 *      caller knows the message is degraded.
 *
 * No LLM dependency; the generator is a pure function. This keeps audit
 * trails reproducible (A3) and means the commit message can be regenerated
 * deterministically from the same inputs in the future.
 */

import type { SpecArtifact } from '../spec/spec-artifact.ts';

export type CommitStyle = 'conventional' | 'plain';

export const CONVENTIONAL_TYPE_VOCAB = [
  'feat',
  'fix',
  'refactor',
  'test',
  'docs',
  'chore',
  'perf',
  'build',
  'ci',
  'style',
  'revert',
] as const;
export type ConventionalType = (typeof CONVENTIONAL_TYPE_VOCAB)[number];

export interface CommitMessageInput {
  /** Frozen spec — preferred source for title + body. */
  spec?: SpecArtifact;
  /** Worker-produced answer — fallback when no spec is available. */
  answer?: string;
  /** Files touched in this change set (paths relative to repo root). */
  affectedFiles?: string[];
  /** Override commit-message style. Defaults to 'conventional'. */
  style?: CommitStyle;
  /** Co-Author trailer line — passed verbatim. Default empty. */
  coAuthor?: string;
}

export interface CommitMessageOutput {
  /** First line of the commit message (≤ 80 chars when degraded='none'). */
  title: string;
  /** Body — empty string when no spec/answer was supplied. */
  body: string;
  /** Combined title + body + trailer, ready for `git commit -m`. */
  message: string;
  /** Why this message was chosen — useful for traces. */
  source: 'spec' | 'answer' | 'fallback';
  /** True when the generator could not derive a meaningful message. */
  degraded: boolean;
}

const TITLE_MAX_LEN = 72;
const SCOPE_MAX_LEN = 24;

/**
 * Synthesize a Conventional Commit type from the spec summary or answer.
 * Pure heuristic — picks the verb that best fits common conventions.
 */
function inferConventionalType(text: string): ConventionalType {
  const lower = text.toLowerCase();
  if (/\bfix(es|ed)?\b|\bbug\b|\bpatch\b|\bhotfix\b/.test(lower)) return 'fix';
  if (/\brefactor\b|\bclean\s*-?up\b/.test(lower)) return 'refactor';
  if (/\bdoc(s|umentation)?\b|\breadme\b/.test(lower)) return 'docs';
  if (/\btest(s|ing)?\b/.test(lower)) return 'test';
  if (/\bperf(ormance)?\b|\boptimize\b|\bspeed\s*up\b/.test(lower)) return 'perf';
  if (/\bci\b|\bgithub\s*action\b|\bworkflow\b/.test(lower)) return 'ci';
  if (/\bbuild\b|\bbundle\b/.test(lower)) return 'build';
  if (/\bstyle\b|\blint\b|\bformat\b/.test(lower)) return 'style';
  if (/\brevert\b/.test(lower)) return 'revert';
  return 'feat';
}

/**
 * Derive a scope from the affected files. Strategy: longest common prefix,
 * stripped of leading 'src/', truncated to SCOPE_MAX_LEN. Returns null
 * when no useful scope is derivable.
 */
function inferScope(affectedFiles: string[]): string | null {
  if (affectedFiles.length === 0) return null;
  const normalized = affectedFiles.map((f) => f.replace(/^\.?\/+/, '').replace(/^src\//, ''));
  if (normalized.length === 1) {
    const segments = normalized[0]!.split('/');
    if (segments.length === 1) return null;
    return segments[0]!.slice(0, SCOPE_MAX_LEN);
  }
  let prefix = normalized[0]!;
  for (let i = 1; i < normalized.length; i++) {
    while (!normalized[i]!.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return null;
    }
  }
  const trimmed = prefix.split('/').filter(Boolean)[0];
  if (!trimmed) return null;
  return trimmed.slice(0, SCOPE_MAX_LEN);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function buildBodyFromSpec(spec: SpecArtifact, affectedFiles: string[]): string {
  const lines: string[] = [];
  // Bullet acceptance criteria — these become the body.
  const testable = spec.acceptanceCriteria.filter((c) => c.testable);
  if (testable.length > 0) {
    lines.push('Acceptance:');
    for (const c of testable.slice(0, 6)) lines.push(`- ${c.description}`);
  }
  const blockers = spec.edgeCases.filter((ec) => ec.severity === 'blocker');
  if (blockers.length > 0) {
    lines.push('');
    lines.push('Edge cases (blocker):');
    for (const ec of blockers.slice(0, 4)) lines.push(`- ${ec.scenario} → ${ec.expected}`);
  }
  if (affectedFiles.length > 0) {
    lines.push('');
    lines.push('Files:');
    for (const f of affectedFiles.slice(0, 8)) lines.push(`- ${f}`);
    if (affectedFiles.length > 8) lines.push(`- (+${affectedFiles.length - 8} more)`);
  }
  return lines.join('\n');
}

/**
 * Produce a commit message from the supplied inputs. Pure function.
 */
export function generateCommitMessage(input: CommitMessageInput): CommitMessageOutput {
  const style = input.style ?? 'conventional';
  const affected = input.affectedFiles ?? [];

  // ── Path 1: Spec available → preferred deterministic source ──────
  if (input.spec) {
    const conventionalType = inferConventionalType(input.spec.summary);
    const scope = inferScope(affected);
    const titleBase =
      style === 'conventional'
        ? scope
          ? `${conventionalType}(${scope}): ${input.spec.summary}`
          : `${conventionalType}: ${input.spec.summary}`
        : input.spec.summary;
    const title = truncate(titleBase, TITLE_MAX_LEN);
    const body = buildBodyFromSpec(input.spec, affected);
    const message = composeMessage(title, body, input.coAuthor);
    return { title, body, message, source: 'spec', degraded: false };
  }

  // ── Path 2: Worker answer present → derive title from first line ──
  if (input.answer && input.answer.trim().length > 0) {
    const firstLine = input.answer.trim().split('\n')[0] ?? input.answer.trim();
    const conventionalType = inferConventionalType(firstLine);
    const scope = inferScope(affected);
    const titleBase =
      style === 'conventional'
        ? scope
          ? `${conventionalType}(${scope}): ${firstLine}`
          : `${conventionalType}: ${firstLine}`
        : firstLine;
    const title = truncate(titleBase, TITLE_MAX_LEN);
    const body = input.answer.trim() === firstLine ? '' : input.answer.trim();
    const message = composeMessage(title, body, input.coAuthor);
    return { title, body, message, source: 'answer', degraded: false };
  }

  // ── Path 3: Degraded fallback — explicit signal so callers can act ──
  const scope = inferScope(affected);
  const titleBase =
    style === 'conventional'
      ? scope
        ? `chore(${scope}): apply orchestrator changes`
        : 'chore: apply orchestrator changes'
      : 'apply orchestrator changes';
  const title = truncate(titleBase, TITLE_MAX_LEN);
  const body =
    affected.length > 0
      ? `Files:\n${affected.slice(0, 8).map((f) => `- ${f}`).join('\n')}`
      : '';
  const message = composeMessage(title, body, input.coAuthor);
  return { title, body, message, source: 'fallback', degraded: true };
}

function composeMessage(title: string, body: string, coAuthor?: string): string {
  const parts: string[] = [title];
  if (body) parts.push('', body);
  if (coAuthor) parts.push('', coAuthor);
  return parts.join('\n');
}

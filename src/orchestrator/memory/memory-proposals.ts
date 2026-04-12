/**
 * Memory Proposals — oracle-gated agent-proposed learned conventions (M4 tier).
 *
 * Vinyan A1 axiom (human-as-truth) forbids agents from directly writing M4
 * learned conventions. Instead, agents PROPOSE conventions which are:
 *
 *   1. **Grammar-checked** by a deterministic validator (this module)
 *   2. Written to `.vinyan/memory/pending/` as pending proposals
 *   3. Reviewed by a human, who can approve or reject
 *   4. Approved proposals are merged into `.vinyan/memory/learned.md` (M4)
 *
 * This module covers the first two steps — validation and pending write.
 * Review/approval CLI and M4 merging are follow-up work (Phase 3b).
 *
 * Beats Claude Code and VSCode Copilot by giving the worker loop a structured,
 * auditable way to accumulate project conventions without violating the
 * human-as-truth axiom (neither competitor has an agent-proposed memory flow
 * that stays A1-compliant).
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

// ── Types ───────────────────────────────────────────────────────────

/** Proposal category — narrow whitelist so M4 stays interpretable. */
export type ProposalCategory = 'convention' | 'anti-pattern' | 'finding';

/** Trust tier hint — mirrors instruction-hierarchy RuleFrontmatter.tier. */
export type ProposalTier = 'deterministic' | 'heuristic' | 'probabilistic';

/**
 * A single evidence reference — the empirical support for a proposal.
 * At minimum each proposal needs one evidence entry (oracle floor).
 */
export interface ProposalEvidence {
  /** Workspace-relative file path that supports the claim. */
  filePath: string;
  /** Optional 1-based line number. */
  line?: number;
  /** Short description of what this evidence shows. */
  note: string;
}

/** Agent-proposed M4 entry, pre-validation. */
export interface MemoryProposal {
  /** Short kebab-case slug used for the pending filename. */
  slug: string;
  /** Agent identifier (worker session or subagent name) that proposed this. */
  proposedBy: string;
  /** Orchestrator session id for traceability. */
  sessionId: string;
  /** Category — convention / anti-pattern / finding. */
  category: ProposalCategory;
  /** Trust tier — affects downstream weighting after human approval. */
  tier: ProposalTier;
  /** Confidence in [0, 1]. Must be ≥ CONFIDENCE_FLOOR. */
  confidence: number;
  /** Optional glob patterns this rule would apply to once approved. */
  applyTo?: string[];
  /** 1–3 sentence human-readable description of the rule. */
  description: string;
  /** Markdown body with the full proposed rule text. */
  body: string;
  /** Empirical support — at least one entry required. */
  evidence: ProposalEvidence[];
}

/** Result of running a proposal through the validator. */
export interface ProposalValidationResult {
  valid: boolean;
  /** Human-readable failure reason (when !valid). */
  reason?: string;
  /** Which oracle check failed (when !valid). */
  failedCheck?:
    | 'grammar'
    | 'confidence_floor'
    | 'evidence_floor'
    | 'size_limit'
    | 'category_whitelist'
    | 'tier_whitelist'
    | 'slug_safety'
    | 'contradiction';
}

/** Outcome of writing a validated proposal to disk. */
export interface ProposalWriteResult {
  path: string;
  contentHash: string;
}

// ── Oracle constants ────────────────────────────────────────────────

/** Minimum confidence an agent must express to propose a convention. */
export const CONFIDENCE_FLOOR = 0.7;

/** Minimum number of evidence entries required per proposal. */
export const EVIDENCE_FLOOR = 1;

/** Maximum serialized proposal size (frontmatter + body). */
export const MAX_PROPOSAL_SIZE = 5_000;

/** Whitelisted categories. */
const ALLOWED_CATEGORIES: ReadonlySet<ProposalCategory> = new Set([
  'convention',
  'anti-pattern',
  'finding',
]);

/** Whitelisted tiers. */
const ALLOWED_TIERS: ReadonlySet<ProposalTier> = new Set([
  'deterministic',
  'heuristic',
  'probabilistic',
]);

/** Slug format: lowercase letters, digits, dashes. No path separators, no dots. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── Oracle validator ────────────────────────────────────────────────

/**
 * Validate a proposal against the full oracle check set.
 *
 * Checks, in order:
 *   1. Grammar — all required fields are present and well-typed.
 *   2. Category whitelist — category ∈ {convention, anti-pattern, finding}.
 *   3. Tier whitelist — tier ∈ {deterministic, heuristic, probabilistic}.
 *   4. Slug safety — no path separators, no parent-dir, matches kebab pattern.
 *   5. Confidence floor — confidence ≥ CONFIDENCE_FLOOR.
 *   6. Evidence floor — at least EVIDENCE_FLOOR entries with non-empty paths.
 *   7. Size limit — serialized form ≤ MAX_PROPOSAL_SIZE bytes.
 *
 * Non-contradiction against existing M4 is out of scope here (requires loading
 * the current learned.md and running a semantic diff); that is a Phase 3b
 * concern handled by the review CLI.
 */
export function validateProposal(proposal: MemoryProposal): ProposalValidationResult {
  // 1. Grammar — presence and basic typing.
  if (!proposal || typeof proposal !== 'object') {
    return { valid: false, failedCheck: 'grammar', reason: 'proposal must be an object' };
  }
  const requiredStringFields: Array<keyof MemoryProposal> = [
    'slug',
    'proposedBy',
    'sessionId',
    'category',
    'tier',
    'description',
    'body',
  ];
  for (const field of requiredStringFields) {
    const value = proposal[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        valid: false,
        failedCheck: 'grammar',
        reason: `missing or empty required field: ${field}`,
      };
    }
  }
  if (typeof proposal.confidence !== 'number' || Number.isNaN(proposal.confidence)) {
    return { valid: false, failedCheck: 'grammar', reason: 'confidence must be a number' };
  }
  if (!Array.isArray(proposal.evidence)) {
    return { valid: false, failedCheck: 'grammar', reason: 'evidence must be an array' };
  }

  // 2. Category whitelist.
  if (!ALLOWED_CATEGORIES.has(proposal.category)) {
    return {
      valid: false,
      failedCheck: 'category_whitelist',
      reason: `category must be one of: ${[...ALLOWED_CATEGORIES].join(', ')}`,
    };
  }

  // 3. Tier whitelist.
  if (!ALLOWED_TIERS.has(proposal.tier)) {
    return {
      valid: false,
      failedCheck: 'tier_whitelist',
      reason: `tier must be one of: ${[...ALLOWED_TIERS].join(', ')}`,
    };
  }

  // 4. Slug safety — prevents path traversal and keeps filenames predictable.
  if (!SLUG_PATTERN.test(proposal.slug)) {
    return {
      valid: false,
      failedCheck: 'slug_safety',
      reason: `slug must match ${SLUG_PATTERN.source} (kebab-case, no dots or slashes)`,
    };
  }

  // 5. Confidence floor.
  if (proposal.confidence < CONFIDENCE_FLOOR || proposal.confidence > 1) {
    return {
      valid: false,
      failedCheck: 'confidence_floor',
      reason: `confidence must be in [${CONFIDENCE_FLOOR}, 1], got ${proposal.confidence}`,
    };
  }

  // 6. Evidence floor — at least one entry with a workspace-relative path.
  if (proposal.evidence.length < EVIDENCE_FLOOR) {
    return {
      valid: false,
      failedCheck: 'evidence_floor',
      reason: `at least ${EVIDENCE_FLOOR} evidence entr${EVIDENCE_FLOOR === 1 ? 'y' : 'ies'} required`,
    };
  }
  for (const [i, ev] of proposal.evidence.entries()) {
    if (!ev || typeof ev !== 'object') {
      return {
        valid: false,
        failedCheck: 'evidence_floor',
        reason: `evidence[${i}] must be an object`,
      };
    }
    if (typeof ev.filePath !== 'string' || ev.filePath.trim() === '') {
      return {
        valid: false,
        failedCheck: 'evidence_floor',
        reason: `evidence[${i}].filePath is required`,
      };
    }
    if (isAbsolute(ev.filePath) || ev.filePath.includes('..')) {
      return {
        valid: false,
        failedCheck: 'evidence_floor',
        reason: `evidence[${i}].filePath must be a workspace-relative path without '..'`,
      };
    }
    if (typeof ev.note !== 'string' || ev.note.trim() === '') {
      return {
        valid: false,
        failedCheck: 'evidence_floor',
        reason: `evidence[${i}].note is required`,
      };
    }
  }

  // 7. Size limit — check the serialized form, since that's what hits disk.
  const serialized = serializeProposal(proposal);
  if (serialized.length > MAX_PROPOSAL_SIZE) {
    return {
      valid: false,
      failedCheck: 'size_limit',
      reason: `serialized proposal is ${serialized.length} bytes, max ${MAX_PROPOSAL_SIZE}`,
    };
  }

  return { valid: true };
}

// ── Serialization ───────────────────────────────────────────────────

/**
 * Serialize a proposal to a markdown file with YAML frontmatter. The format
 * matches what the instruction-hierarchy loader can consume directly after
 * approval — so approved proposals can be moved into `learned.md` (or kept
 * as standalone scoped rules) without a format conversion step.
 */
export function serializeProposal(proposal: MemoryProposal): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`proposedBy: ${yamlString(proposal.proposedBy)}`);
  lines.push(`proposedAt: ${yamlString(new Date().toISOString())}`);
  lines.push(`sessionId: ${yamlString(proposal.sessionId)}`);
  lines.push(`category: ${proposal.category}`);
  lines.push(`tier: ${proposal.tier}`);
  lines.push(`confidence: ${proposal.confidence}`);
  lines.push(`description: ${yamlString(proposal.description)}`);
  if (proposal.applyTo && proposal.applyTo.length > 0) {
    lines.push('applyTo:');
    for (const glob of proposal.applyTo) lines.push(`  - ${yamlString(glob)}`);
  }
  lines.push('evidence:');
  for (const ev of proposal.evidence) {
    lines.push(`  - filePath: ${yamlString(ev.filePath)}`);
    if (typeof ev.line === 'number') lines.push(`    line: ${ev.line}`);
    lines.push(`    note: ${yamlString(ev.note)}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(proposal.body.trimEnd());
  lines.push('');
  return lines.join('\n');
}

/**
 * Minimal YAML string escaper. Always quotes the value to avoid edge cases
 * with colons, leading dashes, and reserved words. Newlines in the input are
 * replaced with literal `\n` — proposal fields are short single-line values,
 * and multi-line markdown belongs in the body.
 */
function yamlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

// ── Pending writer ──────────────────────────────────────────────────

/** Workspace-relative directory where pending proposals are written. */
export const PENDING_DIR_REL = join('.vinyan', 'memory', 'pending');

/**
 * Validate and write a proposal to `.vinyan/memory/pending/<timestamp>-<slug>.md`.
 *
 * The timestamp prefix (UTC, compact form) gives the review CLI a stable
 * ordering and guarantees uniqueness even if the agent proposes multiple
 * rules with the same slug in rapid succession.
 *
 * Throws if validation fails, so callers must handle the error and surface
 * it back to the worker as a tool failure rather than silently dropping it.
 */
export function writeProposal(workspace: string, proposal: MemoryProposal): ProposalWriteResult {
  const validation = validateProposal(proposal);
  if (!validation.valid) {
    throw new Error(
      `memory proposal rejected by oracle (${validation.failedCheck}): ${validation.reason}`,
    );
  }

  const pendingDir = resolve(workspace, PENDING_DIR_REL);
  mkdirSync(pendingDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_');
  const filename = `${timestamp}__${proposal.slug}.md`;
  const fullPath = join(pendingDir, filename);

  const content = serializeProposal(proposal);
  writeFileSync(fullPath, content);

  return {
    path: fullPath,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

// ── Pending reader (for future CLI / reminder injection) ────────────

/** A pending proposal as read from disk. */
export interface PendingProposalFile {
  /** Absolute path on disk. */
  path: string;
  /** Filename (including `.md`). */
  filename: string;
  /** Raw file content. */
  content: string;
}

/**
 * List all pending proposal files under `.vinyan/memory/pending/`. Sorted by
 * filename — because filenames start with ISO timestamps, this is also
 * chronological order.
 */
export function listPendingProposals(workspace: string): PendingProposalFile[] {
  const pendingDir = resolve(workspace, PENDING_DIR_REL);
  if (!existsSync(pendingDir)) return [];

  const entries = readdirSync(pendingDir).filter((f) => f.endsWith('.md')).sort();
  return entries.map((filename) => {
    const fullPath = join(pendingDir, filename);
    return {
      path: fullPath,
      filename,
      content: readFileSync(fullPath, 'utf-8'),
    };
  });
}

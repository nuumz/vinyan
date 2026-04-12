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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
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
    | 'duplicate'
    | 'contradiction';
}

/**
 * Optional workspace-state context passed to `validateProposal` so it can
 * reject duplicates before the proposal ever hits disk. Callers that already
 * know the existing slug sets (e.g., `writeProposal`) populate this; callers
 * that only want to grammar-check a proposal (e.g., unit tests of individual
 * oracle rules) can leave it undefined and the duplicate check is skipped.
 *
 * `approvedSlugs` and `pendingSlugs` are **sets** rather than arrays so the
 * check is O(1) and the caller's intent ("is this slug already taken") is
 * explicit in the shape. The validator never mutates them.
 */
export interface ProposalContext {
  /** Slugs already present in `.vinyan/memory/learned.md` (post-approval). */
  approvedSlugs?: ReadonlySet<string>;
  /** Slugs already present as `<ts>__<slug>.md` in `.vinyan/memory/pending/`. */
  pendingSlugs?: ReadonlySet<string>;
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
const ALLOWED_CATEGORIES: ReadonlySet<ProposalCategory> = new Set(['convention', 'anti-pattern', 'finding']);

/** Whitelisted tiers. */
const ALLOWED_TIERS: ReadonlySet<ProposalTier> = new Set(['deterministic', 'heuristic', 'probabilistic']);

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
 *   8. Duplicate slug (Phase 6, only when `context` is supplied) —
 *      proposal.slug must not collide with an approved M4 entry or a
 *      pending proposal already on disk.
 *
 * Semantic non-contradiction against existing M4 (semantic diff, not just
 * slug collision) is still out of scope here; that is a future phase.
 */
export function validateProposal(proposal: MemoryProposal, context?: ProposalContext): ProposalValidationResult {
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

  // 8. Duplicate-slug guard (Phase 6). Only runs when the caller supplied
  // workspace context — this keeps unit tests of the other oracle rules
  // free of fs setup. `writeProposal` always supplies both sets. Approved
  // collisions are reported before pending collisions because "already
  // approved" is a stronger signal for the agent's recovery logic (it
  // should rename the slug, not wait for the reviewer).
  if (context?.approvedSlugs?.has(proposal.slug)) {
    return {
      valid: false,
      failedCheck: 'duplicate',
      reason:
        `slug "${proposal.slug}" already exists in approved M4 learned.md. ` +
        `Choose a different slug or propose an amendment under a new name.`,
    };
  }
  if (context?.pendingSlugs?.has(proposal.slug)) {
    return {
      valid: false,
      failedCheck: 'duplicate',
      reason:
        `slug "${proposal.slug}" already has a pending proposal awaiting review. ` +
        `Check the existing pending entry before proposing a duplicate.`,
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
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
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
 * Phase 6: the validator receives the current approved + pending slug sets
 * so duplicate proposals are rejected **before** they hit disk. A worker that
 * proposes a slug already in either set gets an immediate oracle error with
 * actionable guidance — saving both worker tokens and human review cycles.
 *
 * Throws if validation fails, so callers must handle the error and surface
 * it back to the worker as a tool failure rather than silently dropping it.
 */
export function writeProposal(workspace: string, proposal: MemoryProposal): ProposalWriteResult {
  // Build the duplicate-detection context from disk. Both collectors swallow
  // fs errors into empty sets — a fresh workspace with no learned.md and no
  // pending/ is a valid starting state, not a failure.
  const approvedSlugs = collectApprovedSlugs(workspace);
  const pendingSlugs = collectPendingSlugs(workspace);
  const validation = validateProposal(proposal, { approvedSlugs, pendingSlugs });
  if (!validation.valid) {
    throw new Error(`memory proposal rejected by oracle (${validation.failedCheck}): ${validation.reason}`);
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

/**
 * Collect slugs from the current `.vinyan/memory/learned.md`. Silently returns
 * an empty set on a missing file, an unreadable file, or a hand-authored file
 * without the `vinyan-memory-entry` markers (`parseLearnedMdEntries` returns
 * `[]` in that case). Hand-authored files cannot participate in slug dedup
 * because they have no structured slug — this matches the Phase 4 read path.
 */
function collectApprovedSlugs(workspace: string): Set<string> {
  const learnedPath = resolve(workspace, LEARNED_FILE_REL);
  if (!existsSync(learnedPath)) return new Set();
  try {
    const content = readFileSync(learnedPath, 'utf-8');
    return new Set(parseLearnedMdEntries(content).map((e) => e.slug));
  } catch {
    return new Set();
  }
}

/**
 * Collect slugs from the current `.vinyan/memory/pending/` directory by
 * parsing each filename's `<timestamp>__<slug>.md` suffix. Uses
 * `listPendingProposals` as the underlying enumerator so the two paths stay
 * in lockstep and both respect the same `.md`-only filter.
 */
function collectPendingSlugs(workspace: string): Set<string> {
  try {
    return new Set(listPendingProposals(workspace).map((f) => filenameToSlug(f.filename)));
  } catch {
    return new Set();
  }
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

  const entries = readdirSync(pendingDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return entries.map((filename) => {
    const fullPath = join(pendingDir, filename);
    return {
      path: fullPath,
      filename,
      content: readFileSync(fullPath, 'utf-8'),
    };
  });
}

/**
 * Cheap count of pending proposals — does NOT read file contents. Used by the
 * agent loop at session start (Phase 3d) to surface the review backlog to L2+
 * workers via a `<vinyan-reminder>` `[MEMORY QUEUE]` line, so workers know to
 * check existing pending proposals before stuffing the queue with duplicates.
 *
 * Returns 0 when the pending directory does not exist (a fresh workspace) or
 * contains no markdown files. Non-md files are ignored — matches the filter
 * used by `listPendingProposals` so the two functions stay in lockstep.
 */
export function countPendingProposals(workspace: string): number {
  const pendingDir = resolve(workspace, PENDING_DIR_REL);
  if (!existsSync(pendingDir)) return 0;
  return readdirSync(pendingDir).filter((f) => f.endsWith('.md')).length;
}

// ── Proposal parsing ────────────────────────────────────────────────

/**
 * Parsed frontmatter of a pending proposal file. Only the fields we need
 * for review / approval are surfaced — the full YAML body is intentionally
 * not exposed, because CLI rendering should go through this typed shape
 * rather than re-parse the raw file ad-hoc.
 */
export interface ParsedProposal {
  slug: string;
  proposedBy: string;
  proposedAt: string;
  sessionId: string;
  category: ProposalCategory;
  tier: ProposalTier;
  confidence: number;
  description: string;
  applyTo: string[];
  /** Markdown body below the frontmatter. */
  body: string;
}

/**
 * Minimal parser for the YAML frontmatter we emit in `serializeProposal`.
 * We do NOT use a general YAML library because:
 *   1. We control both sides of this format — producer and consumer.
 *   2. Full YAML brings ambiguity and a dependency we don't need.
 *   3. `instruction-hierarchy.ts` already ships its own hand-rolled parser
 *      for the same reason; this keeps the pattern consistent.
 *
 * Returns null if the content does not start with `---\n` / `---\r\n` — the
 * caller should treat that as a malformed pending file and skip it.
 */
export function parseProposalFile(content: string): ParsedProposal | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;
  const closing = content.indexOf('\n---', 4);
  if (closing < 0) return null;

  const fmBlock = content.slice(4, closing);
  const body = content
    .slice(closing + 4)
    .replace(/^\r?\n/, '')
    .trimEnd();

  let slug = '';
  let proposedBy = '';
  let proposedAt = '';
  let sessionId = '';
  let category: ProposalCategory = 'finding';
  let tier: ProposalTier = 'heuristic';
  let confidence = 0;
  let description = '';
  const applyTo: string[] = [];

  let currentKey: string | null = null;
  for (const rawLine of fmBlock.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;

    // List item continuation: "  - value"
    const listMatch = line.match(/^\s+-\s*(.+)$/);
    if (listMatch && currentKey === 'applyTo') {
      applyTo.push(unquoteYamlString(listMatch[1]!));
      continue;
    }

    // Ignore nested evidence entries for now — the CLI renders body-level.
    if (listMatch && currentKey === 'evidence') continue;
    // Scalar sub-fields of evidence entries (indented `filePath:` / `note:`) are ignored here too.
    if (line.startsWith('    ') && currentKey === 'evidence') continue;

    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    currentKey = key;

    switch (key) {
      case 'slug':
        slug = unquoteYamlString(value);
        break;
      case 'proposedBy':
        proposedBy = unquoteYamlString(value);
        break;
      case 'proposedAt':
        proposedAt = unquoteYamlString(value);
        break;
      case 'sessionId':
        sessionId = unquoteYamlString(value);
        break;
      case 'category':
        category = unquoteYamlString(value) as ProposalCategory;
        break;
      case 'tier':
        tier = unquoteYamlString(value) as ProposalTier;
        break;
      case 'confidence': {
        const n = Number.parseFloat(value);
        if (!Number.isNaN(n)) confidence = n;
        break;
      }
      case 'description':
        description = unquoteYamlString(value);
        break;
      default:
        // applyTo and evidence use the list continuation paths above.
        break;
    }
  }

  // The `slug` frontmatter field is optional — writeProposal currently does
  // not emit it, so recover the slug from the filename-unaware body if not
  // present. Callers typically pass filenames too and can override.
  return {
    slug,
    proposedBy,
    proposedAt,
    sessionId,
    category,
    tier,
    confidence,
    description,
    applyTo,
    body,
  };
}

/** Reverse of yamlString's escape routine. */
function unquoteYamlString(value: string): string {
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// ── Slug resolution ─────────────────────────────────────────────────

/**
 * Error thrown when a slug lookup is ambiguous (multiple pending files match).
 * The CLI catches this and prints the candidate list so the reviewer can
 * re-invoke with the full filename.
 */
export class AmbiguousProposalError extends Error {
  readonly candidates: string[];
  constructor(slug: string, candidates: string[]) {
    super(`ambiguous slug "${slug}" — matches ${candidates.length} pending proposals: ${candidates.join(', ')}`);
    this.name = 'AmbiguousProposalError';
    this.candidates = candidates;
  }
}

/**
 * Resolve a user-supplied handle (slug OR filename) to a single pending
 * proposal file. Throws if zero or multiple matches.
 *
 * Accepted inputs:
 *   - A full filename (`2026-04-12_12-34-56-789Z__use-bun-test.md`)
 *   - A bare slug (`use-bun-test`) — matches files ending in `__<slug>.md`
 *   - A slug with `.md` suffix (`use-bun-test.md`) — normalized to bare slug
 */
export function resolveProposalBySlug(workspace: string, handle: string): PendingProposalFile {
  const pending = listPendingProposals(workspace);
  if (pending.length === 0) {
    throw new Error('no pending proposals — nothing to resolve');
  }

  // 1. Exact filename match (wins if multiple slug-prefix matches).
  const exact = pending.find((p) => p.filename === handle);
  if (exact) return exact;

  // 2. Slug suffix match.
  const bareSlug = handle.replace(/\.md$/, '');
  const slugMatches = pending.filter((p) => p.filename.endsWith(`__${bareSlug}.md`));
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    throw new AmbiguousProposalError(
      bareSlug,
      slugMatches.map((p) => p.filename),
    );
  }

  throw new Error(`no pending proposal matching "${handle}"`);
}

// ── Approval / rejection ────────────────────────────────────────────

/** Workspace-relative path of the M4 learned conventions file. */
export const LEARNED_FILE_REL = join('.vinyan', 'memory', 'learned.md');

/** Workspace-relative directory for rejected proposals. */
export const REJECTED_DIR_REL = join('.vinyan', 'memory', 'rejected');

/**
 * Hard cap on the serialized size of `.vinyan/memory/learned.md`, in bytes.
 *
 * Sized with headroom under `MAX_INSTRUCTION_SIZE` (50 KB) in
 * `instruction-hierarchy.ts`: once learned.md exceeds that cap, the instruction
 * loader silently drops the file and every approved convention goes dark. We
 * keep 5 KB of headroom so one more approval can never land the file over the
 * loader's ceiling.
 *
 * Exceeding this cap during approval is a signal that the review CLI should
 * prune or re-summarize older entries; `approveProposal` refuses the write so
 * the failure surfaces to the human reviewer instead of silently truncating.
 */
export const LEARNED_MD_MAX_SIZE = 45_000;

export interface ApproveResult {
  /** Absolute path of learned.md after append. */
  learnedPath: string;
  /** The rendered block that was appended to learned.md. */
  appendedBlock: string;
  /** The pending file that was consumed. */
  consumedPending: string;
}

export interface RejectResult {
  /** Absolute path of the archived rejected file. */
  rejectedPath: string;
  /** The pending file that was consumed. */
  consumedPending: string;
}

/**
 * Approve a pending proposal: append it to `.vinyan/memory/learned.md` and
 * remove it from `pending/`. Approval metadata (reviewer + timestamp) is
 * encoded in an HTML comment so it round-trips through markdown parsers
 * without polluting the visible rule body.
 *
 * `learned.md` is treated as a single append-only M4 source — new entries
 * go to the bottom. The M2/M3 priority-based override system keeps earlier
 * entries in force unless explicitly shadowed, so append-order doesn't
 * change rule semantics.
 */
export function approveProposal(workspace: string, handle: string, reviewer: string): ApproveResult {
  const pending = resolveProposalBySlug(workspace, handle);
  const parsed = parseProposalFile(pending.content);
  if (!parsed) {
    throw new Error(`pending file ${pending.filename} has malformed frontmatter`);
  }

  // Derive slug from filename if frontmatter didn't carry it.
  const slug = parsed.slug || filenameToSlug(pending.filename);
  const approvedAt = new Date().toISOString();
  const block = renderApprovedBlock({ ...parsed, slug }, reviewer, approvedAt);

  const learnedPath = resolve(workspace, LEARNED_FILE_REL);
  mkdirSync(resolve(workspace, '.vinyan', 'memory'), { recursive: true });

  // Read once up front so the duplicate-slug and size-cap checks both operate
  // on the same snapshot, and so we can compute the post-append size without
  // actually committing the write.
  const existing = existsSync(learnedPath) ? readFileSync(learnedPath, 'utf-8') : '';

  // Duplicate-slug guard. Two approved entries with the same slug would break
  // the discovery fingerprint in instruction-hierarchy (slug-salted hashes
  // would collide) and leave the reviewer unable to tell which rule applies.
  // We refuse the write and leave the pending file in place so the reviewer
  // can rename/merge/reject it explicitly.
  if (existing.length > 0) {
    const existingEntries = parseLearnedMdEntries(existing);
    if (existingEntries.some((e) => e.slug === slug)) {
      throw new Error(
        `cannot approve "${slug}": an entry with this slug already exists in ${LEARNED_FILE_REL}. ` +
          `Rename the proposal, reject it, or prune the existing entry before re-approving.`,
      );
    }
  }

  // Size-cap enforcement. We project the exact bytes that would be written —
  // header (for fresh files) or separator (for existing files) — and refuse
  // the append if the result would exceed LEARNED_MD_MAX_SIZE. The reviewer
  // must prune old entries before adding new ones once the cap is reached.
  const header = '<!-- Vinyan M4 learned conventions. Agent-proposed, human-approved. -->\n\n';
  const separator = existing.endsWith('\n') || existing.length === 0 ? '\n' : '\n\n';
  const appendPayload = existing.length > 0 ? `${separator}${block}\n` : `${header}${block}\n`;
  const projectedSize = existing.length + appendPayload.length;
  if (projectedSize > LEARNED_MD_MAX_SIZE) {
    throw new Error(
      `cannot approve "${slug}": ${LEARNED_FILE_REL} would reach ${projectedSize} bytes ` +
        `(cap ${LEARNED_MD_MAX_SIZE}). Prune older entries via the review CLI before approving new ones.`,
    );
  }

  if (existing.length > 0) {
    appendFileSync(learnedPath, appendPayload);
  } else {
    writeFileSync(learnedPath, appendPayload);
  }

  // Remove the pending file last so a failure above leaves the proposal
  // intact for the reviewer to retry after pruning / renaming.
  unlinkPending(pending.path);

  return {
    learnedPath,
    appendedBlock: block,
    consumedPending: pending.filename,
  };
}

/**
 * Reject a pending proposal: move it to `.vinyan/memory/rejected/` and
 * prepend a rejection header. The pending file is removed. The rejected
 * archive preserves the original proposal for audit purposes.
 */
export function rejectProposal(workspace: string, handle: string, reviewer: string, reason: string): RejectResult {
  const pending = resolveProposalBySlug(workspace, handle);

  const rejectedDir = resolve(workspace, REJECTED_DIR_REL);
  mkdirSync(rejectedDir, { recursive: true });

  const rejectedAt = new Date().toISOString();
  const rejectionHeader = `<!-- vinyan-memory-rejected: by="${escapeCommentValue(reviewer)}", at="${rejectedAt}", reason="${escapeCommentValue(reason)}" -->\n\n`;

  const rejectedPath = join(rejectedDir, pending.filename);
  writeFileSync(rejectedPath, `${rejectionHeader}${pending.content}`);
  unlinkPending(pending.path);

  return {
    rejectedPath,
    consumedPending: pending.filename,
  };
}

// ── Internal helpers ────────────────────────────────────────────────

function renderApprovedBlock(parsed: ParsedProposal, reviewer: string, approvedAt: string): string {
  const metaFields = [
    `slug=${parsed.slug}`,
    `category=${parsed.category}`,
    `tier=${parsed.tier}`,
    `confidence=${parsed.confidence}`,
    `proposedBy=${parsed.proposedBy}`,
    `approvedBy=${escapeCommentValue(reviewer)}`,
    `approvedAt=${approvedAt}`,
  ];
  const metaComment = `<!-- vinyan-memory-entry: ${metaFields.join(', ')} -->`;
  const applyToLine = parsed.applyTo.length > 0 ? `\n**Applies to**: ${parsed.applyTo.join(', ')}` : '';
  const heading = `## ${parsed.slug} (${parsed.category})`;
  const summary = `**Summary**: ${parsed.description}${applyToLine}`;
  return `${metaComment}\n${heading}\n\n${summary}\n\n${parsed.body.trim()}`;
}

/**
 * HTML-comment-safe value escape. HTML comments cannot contain `--` so we
 * replace any run of dashes with en-dashes, and strip angle brackets to
 * avoid accidentally terminating the comment.
 */
function escapeCommentValue(value: string): string {
  return value.replace(/--+/g, '–').replace(/[<>]/g, '');
}

/** Derive a slug from a pending filename of the form `<timestamp>__<slug>.md`. */
function filenameToSlug(filename: string): string {
  const stripped = filename.replace(/\.md$/, '');
  const sepIdx = stripped.indexOf('__');
  return sepIdx >= 0 ? stripped.slice(sepIdx + 2) : stripped;
}

/** Remove a pending file after approval / rejection. */
function unlinkPending(path: string): void {
  unlinkSync(path);
}

// ── M4 learned.md reader (Phase 4) ──────────────────────────────────

/**
 * One parsed entry from a multi-entry `learned.md` file. Each entry carries
 * the per-rule metadata that `approveProposal` wrote into the HTML comment
 * marker, plus the glob list extracted from the `**Applies to**:` body line.
 *
 * The READ path for learned.md needs per-entry granularity because
 * `instruction-hierarchy.ts` filters rules by `applyTo` at the InstructionSource
 * level. Before Phase 4 the whole file was loaded as ONE opaque source, so
 * every approved rule appeared in every worker's prompt regardless of whether
 * its scope matched — defeating the `applyTo` metadata that Phase 3 wrote
 * during approval.
 */
export interface LearnedEntry {
  /** Slug from the metadata comment — stable identifier for the entry. */
  slug: string;
  /** Proposal category: convention / anti-pattern / finding. */
  category: ProposalCategory;
  /** Trust tier hint the LLM should factor in when weighing this rule. */
  tier: ProposalTier;
  /** Confidence [0, 1] from the original proposal. */
  confidence: number;
  /** Agent identifier that proposed this rule. */
  proposedBy: string;
  /** Human reviewer that approved it. */
  approvedBy: string;
  /** ISO-8601 approval timestamp. */
  approvedAt: string;
  /** Human description from the `**Summary**:` body line (may be empty). */
  description: string;
  /** Glob patterns from the `**Applies to**:` body line (empty ⇒ always active). */
  applyTo: string[];
  /** Full markdown body below the metadata comment, including heading. */
  body: string;
}

/** Line-start match for the approved-entry metadata comment. */
const LEARNED_ENTRY_MARKER_RE = /^<!-- vinyan-memory-entry:/gm;

/**
 * Parse a multi-entry `learned.md` file into discrete `LearnedEntry` records.
 *
 * Each entry written by `approveProposal` / `renderApprovedBlock` starts with a
 * line of the form:
 *
 *   <!-- vinyan-memory-entry: slug=..., category=..., tier=..., confidence=..., proposedBy=..., approvedBy=..., approvedAt=... -->
 *
 * followed by a `## <slug> (<category>)` heading, `**Summary**:` and
 * (optional) `**Applies to**:` lines, and the rule body. Entries are separated
 * by blank lines and append-only to the file.
 *
 * Returns an **empty array** when no marker is present — the caller should
 * then treat the file as an opaque single instruction source for
 * backwards-compatibility with hand-authored `learned.md` files that do not
 * follow the marker convention.
 *
 * The marker regex is anchored at line start (`/^.../m`) so a stray
 * `<!-- vinyan-memory-entry: -->` appearing mid-line inside a body cannot
 * fake a new entry boundary. `escapeCommentValue` guarantees approval metadata
 * never contains a nested `-->`, so the closing delimiter is always the first
 * `-->` after the marker.
 */
export function parseLearnedMdEntries(content: string): LearnedEntry[] {
  // Cheap fast-path: if the marker string does not appear at all we can skip
  // the regex entirely. Most hand-authored learned.md files hit this branch.
  if (!content.includes('<!-- vinyan-memory-entry:')) return [];

  // Collect the starting offset of every line-anchored marker. Using
  // matchAll keeps the loop side-effect free and avoids the regex's internal
  // `lastIndex` state leaking between calls (the RE has the /g flag).
  LEARNED_ENTRY_MARKER_RE.lastIndex = 0;
  const starts: number[] = [];
  for (const match of content.matchAll(LEARNED_ENTRY_MARKER_RE)) {
    if (typeof match.index === 'number') starts.push(match.index);
  }
  if (starts.length === 0) return [];

  const entries: LearnedEntry[] = [];
  for (let i = 0; i < starts.length; i++) {
    const blockStart = starts[i] ?? 0;
    const blockEnd = starts[i + 1] ?? content.length;
    const block = content.slice(blockStart, blockEnd);
    const entry = parseSingleLearnedEntry(block);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Parse a single block starting at a `vinyan-memory-entry` marker. */
function parseSingleLearnedEntry(block: string): LearnedEntry | null {
  const metaClose = block.indexOf('-->');
  if (metaClose < 0) return null;

  const metaRaw = block
    .slice(0, metaClose)
    .replace(/^<!-- vinyan-memory-entry:/, '')
    .trim();
  const meta = parseLearnedEntryMeta(metaRaw);
  const slug = meta.slug ?? '';
  if (!slug) return null;

  const afterMeta = block
    .slice(metaClose + 3)
    .replace(/^\r?\n/, '')
    .trimEnd();
  const confidenceParsed = Number.parseFloat(meta.confidence ?? '');
  const confidence = Number.isFinite(confidenceParsed) ? confidenceParsed : 0;
  const { description, applyTo } = extractLearnedBodyFields(afterMeta);

  return {
    slug,
    category: (meta.category ?? 'finding') as ProposalCategory,
    tier: (meta.tier ?? 'heuristic') as ProposalTier,
    confidence,
    proposedBy: meta.proposedBy ?? '',
    approvedBy: meta.approvedBy ?? '',
    approvedAt: meta.approvedAt ?? '',
    description,
    applyTo,
    body: afterMeta,
  };
}

/**
 * Scan the body of a learned.md entry for its `**Summary**:` and
 * `**Applies to**:` lines. Line-based scan (not regex-on-whole-body) so
 * occurrences of these markers deeper in the rule body are not picked up.
 * The first occurrence of each field wins; later duplicates are ignored.
 */
function extractLearnedBodyFields(body: string): {
  description: string;
  applyTo: string[];
} {
  let description = '';
  let applyTo: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!description) {
      const summaryMatch = line.match(/^\*\*Summary\*\*:\s*(.*)$/);
      if (summaryMatch) {
        description = (summaryMatch[1] ?? '').trim();
      }
    }
    if (applyTo.length === 0) {
      const appliesMatch = line.match(/^\*\*Applies to\*\*:\s*(.*)$/);
      if (appliesMatch) {
        applyTo = (appliesMatch[1] ?? '')
          .split(',')
          .map((g) => g.trim())
          .filter((g) => g.length > 0);
      }
    }
  }
  return { description, applyTo };
}

/**
 * Parse the comma-separated `key=value` pairs from a `vinyan-memory-entry`
 * metadata comment body. Duplicate keys: last-wins. Values containing commas
 * are not supported — `renderApprovedBlock` only emits comma-free scalars, so
 * this stays simple on purpose.
 */
function parseLearnedEntryMeta(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of meta.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

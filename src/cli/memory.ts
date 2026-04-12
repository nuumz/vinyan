/**
 * CLI commands for agent-proposed memory review.
 *
 *   vinyan memory list [--workspace <path>]
 *     Print a table of pending proposals.
 *
 *   vinyan memory show <handle> [--workspace <path>]
 *     Print one proposal — handle is either its slug or its full filename.
 *
 *   vinyan memory approve <handle> [--workspace <path>] [--reviewer <name>]
 *     Move the proposal into .vinyan/memory/learned.md and remove it from pending/.
 *
 *   vinyan memory reject <handle> [--workspace <path>] [--reviewer <name>] [--reason <text>]
 *     Archive the proposal into .vinyan/memory/rejected/ and remove it from pending/.
 *
 * Design notes:
 *  - The CLI is thin — all real work lives in `memory-proposals.ts` so it can
 *    be unit-tested without spawning a subprocess.
 *  - Handle resolution ambiguity (same slug across multiple pending files)
 *    surfaces as a clear error listing candidates, not a silent "pick first".
 *  - A1 compliance: the `--reviewer` flag is required for approve/reject so
 *    the audit trail always names a human, never "anonymous".
 */

import { existsSync } from 'fs';
import { relative } from 'path';
import {
  AmbiguousProposalError,
  approveProposal,
  listPendingProposals,
  parseProposalFile,
  rejectProposal,
  resolveProposalBySlug,
} from '../orchestrator/memory/memory-proposals.ts';

const USAGE =
  'Usage: vinyan memory <list|show|approve|reject> [args]\n' +
  '  list                                       List pending proposals\n' +
  '  show <handle>                              Print one pending proposal\n' +
  '  approve <handle> --reviewer <name>         Approve and merge into learned.md\n' +
  '  reject  <handle> --reviewer <name> --reason <text>   Archive to rejected/\n' +
  '\n' +
  'Common flags:\n' +
  '  --workspace <path>                         Workspace root (default: cwd)\n';

export async function runMemoryCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  switch (subcommand) {
    case 'list':
      await handleList(rest);
      break;
    case 'show':
      await handleShow(rest);
      break;
    case 'approve':
      await handleApprove(rest);
      break;
    case 'reject':
      await handleReject(rest);
      break;
    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

// ── Handlers ────────────────────────────────────────────────────────

async function handleList(args: string[]): Promise<void> {
  const workspace = getWorkspace(args);
  const pending = listPendingProposals(workspace);

  if (pending.length === 0) {
    console.log('No pending memory proposals.');
    return;
  }

  console.log(`Pending proposals (${pending.length}):\n`);
  for (const p of pending) {
    const parsed = parseProposalFile(p.content);
    const slug = parsed?.slug || filenameToSlug(p.filename);
    const category = parsed?.category ?? '?';
    const confidence = parsed?.confidence != null ? parsed.confidence.toFixed(2) : '?';
    const description = parsed?.description ?? '';
    const rel = relative(workspace, p.path);
    console.log(`  ${slug}`);
    console.log(`    category:   ${category}`);
    console.log(`    confidence: ${confidence}`);
    if (description) console.log(`    summary:    ${description}`);
    console.log(`    file:       ${rel}`);
    console.log('');
  }
  console.log('Review with: vinyan memory show <slug>');
  console.log('Approve with: vinyan memory approve <slug> --reviewer <name>');
}

async function handleShow(args: string[]): Promise<void> {
  const workspace = getWorkspace(args);
  const handle = args.find((a) => !a.startsWith('--') && !isFlagValue(args, a));
  if (!handle) {
    process.stderr.write('Error: show requires a slug or filename argument\n');
    process.exit(2);
    return;
  }

  let pending;
  try {
    pending = resolveProposalBySlug(workspace, handle);
  } catch (e) {
    handleResolutionError(e);
    return;
  }

  console.log(`# ${pending.filename}\n`);
  console.log(pending.content);
}

async function handleApprove(args: string[]): Promise<void> {
  const workspace = getWorkspace(args);
  const reviewer = getFlag(args, '--reviewer');
  const handle = args.find((a) => !a.startsWith('--') && !isFlagValue(args, a));

  if (!handle) {
    process.stderr.write('Error: approve requires a slug or filename argument\n');
    process.exit(2);
    return;
  }
  if (!reviewer) {
    process.stderr.write(
      'Error: approve requires --reviewer <name> (A1 compliance: audit trail must name a human)\n',
    );
    process.exit(2);
    return;
  }

  if (!existsSync(workspace)) {
    process.stderr.write(`Error: workspace not found: ${workspace}\n`);
    process.exit(2);
    return;
  }

  try {
    const result = approveProposal(workspace, handle, reviewer);
    console.log(`Approved ${result.consumedPending}`);
    console.log(`Appended to ${relative(workspace, result.learnedPath)}`);
  } catch (e) {
    handleResolutionError(e);
  }
}

async function handleReject(args: string[]): Promise<void> {
  const workspace = getWorkspace(args);
  const reviewer = getFlag(args, '--reviewer');
  const reason = getFlag(args, '--reason');
  const handle = args.find((a) => !a.startsWith('--') && !isFlagValue(args, a));

  if (!handle) {
    process.stderr.write('Error: reject requires a slug or filename argument\n');
    process.exit(2);
    return;
  }
  if (!reviewer) {
    process.stderr.write(
      'Error: reject requires --reviewer <name> (audit trail must name a human)\n',
    );
    process.exit(2);
    return;
  }
  if (!reason) {
    process.stderr.write(
      'Error: reject requires --reason <text> (rejections must be explained)\n',
    );
    process.exit(2);
    return;
  }

  try {
    const result = rejectProposal(workspace, handle, reviewer, reason);
    console.log(`Rejected ${result.consumedPending}`);
    console.log(`Archived to ${relative(workspace, result.rejectedPath)}`);
  } catch (e) {
    handleResolutionError(e);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function getWorkspace(args: string[]): string {
  return getFlag(args, '--workspace') ?? process.cwd();
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * Detect if an arg is the VALUE of a flag (to avoid misinterpreting it as
 * the positional handle). Example: in `approve --reviewer alice use-bun-test`,
 * `alice` is a flag value and must be skipped when hunting for the handle.
 */
function isFlagValue(args: string[], value: string): boolean {
  const idx = args.indexOf(value);
  if (idx <= 0) return false;
  const prev = args[idx - 1];
  return typeof prev === 'string' && prev.startsWith('--');
}

function filenameToSlug(filename: string): string {
  const stripped = filename.replace(/\.md$/, '');
  const sepIdx = stripped.indexOf('__');
  return sepIdx >= 0 ? stripped.slice(sepIdx + 2) : stripped;
}

function handleResolutionError(e: unknown): void {
  if (e instanceof AmbiguousProposalError) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.stderr.write('Re-run with the full filename instead of the slug.\n');
    process.exit(2);
    return;
  }
  process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

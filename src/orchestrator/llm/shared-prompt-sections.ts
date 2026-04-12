/**
 * Shared Prompt Sections — single source of truth for prompt fragments rendered
 * by BOTH the structured-worker assembly path (prompt-section-registry.ts) and
 * the agent-loop worker path (agent-worker-entry.ts).
 *
 * Why: the two paths used to drift — the structured path rendered M1-M4 tiered
 * instructions and an OS/date environment block, while the L2+ agent loop path
 * shipped neither (the subprocess boundary dropped them). Sharing the render
 * functions guarantees both workers see the same authoritative view.
 *
 * This module is IPC-boundary safe: it contains only pure functions over plain
 * data so the same rendering logic runs inside the orchestrator AND inside the
 * subprocess worker.
 */
import { execSync } from 'child_process';
import { sanitizeForPrompt } from '../../guardrails/index.ts';
import type { InstructionMemory, InstructionSource, InstructionTier } from './instruction-hierarchy.ts';

/** Sanitize a string for safe prompt inclusion. */
function clean(s: string): string {
  return sanitizeForPrompt(s).cleaned;
}

// ── Tier metadata (shared across renderers) ─────────────────────────

/** Tier header labels — shows the LLM the provenance of each rule. */
export const TIER_HEADER_LABELS: Record<InstructionTier, string> = {
  user: 'USER PREFERENCES (cross-project)',
  project: 'PROJECT INSTRUCTIONS',
  'scoped-rule': 'SCOPED RULE',
  learned: 'LEARNED CONVENTIONS (agent-proposed, human-verified)',
};

/** Trust hint for each tier — informs how strictly the LLM should follow. */
export const TIER_TRUST_HINT: Record<InstructionTier, string> = {
  user: 'HIGH — user intent',
  project: 'HIGH — project intent',
  'scoped-rule': 'HIGH — project rule',
  learned: 'MEDIUM — agent-learned, needs independent verification',
};

// ── Instruction hierarchy renderer ──────────────────────────────────

/**
 * Render the full multi-tier instruction hierarchy with provenance headers.
 *
 * - Multi-tier mode (sources[] present): one section per source, headed by
 *   tier label, description, applyTo globs, and trust hint.
 * - Legacy mode (content-only): flat `[PROJECT INSTRUCTIONS]` block.
 * - Empty input: returns null so callers can skip injection entirely.
 *
 * Call site contract: callers concatenate the returned string into either a
 * system or user prompt. The returned value is already sanitized.
 */
export function renderInstructionHierarchy(instructions?: InstructionMemory | null): string | null {
  if (!instructions) return null;

  // Multi-tier path: render each source with provenance header
  if (instructions.sources && instructions.sources.length > 0) {
    const parts: string[] = ['[PROJECT INSTRUCTIONS]'];
    parts.push('The following instructions come from multiple sources in precedence order.');
    parts.push('Later rules override earlier rules on conflict. Respect scoped rules for their target file patterns.');
    parts.push('');

    for (const source of instructions.sources) {
      parts.push(renderInstructionSource(source));
      parts.push('');
    }
    return parts.join('\n').trimEnd();
  }

  // Legacy path: single-file flat rendering
  return `[PROJECT INSTRUCTIONS]\n${clean(instructions.content)}`;
}

/** Render a single instruction source with its tier header. */
function renderInstructionSource(source: InstructionSource): string {
  const tierLabel = TIER_HEADER_LABELS[source.tier] ?? source.tier;
  const trust = TIER_TRUST_HINT[source.tier] ?? '';
  const applyTo = source.frontmatter.applyTo?.length ? ` (applies to: ${source.frontmatter.applyTo.join(', ')})` : '';
  const desc = source.frontmatter.description ? ` — ${source.frontmatter.description}` : '';
  // M4 learned rules may also carry a confidence score — surface it so the LLM
  // can weigh a heuristic 0.72 rule differently from a deterministic 0.95 one.
  const conf =
    typeof source.frontmatter.confidence === 'number' && Number.isFinite(source.frontmatter.confidence)
      ? ` confidence=${source.frontmatter.confidence.toFixed(2)}`
      : '';
  const header = `── ${tierLabel}${desc}${applyTo} [${trust}${conf}] ──`;
  return `${header}\n${clean(source.content.trim())}`;
}

// ── Environment info (OS / cwd / date / git) ────────────────────────

/**
 * Plain-data description of the worker's runtime environment. Gathered by the
 * orchestrator (which has workspace access) and shipped to the subprocess via
 * IPC so the worker can render it in its system prompt.
 */
export interface EnvironmentInfo {
  /** Absolute working directory the worker is operating on. */
  cwd: string;
  /** Node.js `process.platform` — 'darwin' | 'linux' | 'win32' etc. */
  platform: string;
  /** Node.js `process.arch` — 'x64' | 'arm64' etc. */
  arch: string;
  /** Orchestrator wall-clock time in ISO-8601 (UTC). Worker renders it locally. */
  dateIso: string;
  /** Git branch name if the cwd is a git repo, else undefined. */
  gitBranch?: string;
  /** True if the working tree has uncommitted changes. Undefined if unknown. */
  gitDirty?: boolean;
  /** True if cwd is a git repository. Undefined if unknown. */
  isGitRepo?: boolean;
}

/**
 * Gather environment information for the current orchestrator process.
 * Best-effort: any probe that fails is silently dropped (undefined).
 * Runs synchronously and fast enough to include in the agent loop init path.
 */
export function computeEnvironmentInfo(workspace: string): EnvironmentInfo {
  const info: EnvironmentInfo = {
    cwd: workspace,
    platform: process.platform,
    arch: process.arch,
    dateIso: new Date().toISOString(),
  };

  // Git probes — best-effort, never throw. A failed probe simply omits the field.
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    if (branch) {
      info.gitBranch = branch;
      info.isGitRepo = true;
    }
  } catch {
    info.isGitRepo = false;
  }

  if (info.isGitRepo) {
    try {
      const status = execSync('git status --porcelain', {
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
        timeout: 1000,
      });
      info.gitDirty = status.trim().length > 0;
    } catch {
      // Leave gitDirty undefined — unknown is a valid state.
    }
  }

  return info;
}

/**
 * Render an `[ENVIRONMENT]` block from gathered info. Keeps the worker's view
 * of its own runtime stable across turns — returns null if the info object is
 * missing so callers can skip gracefully.
 */
export function renderEnvironmentSection(env?: EnvironmentInfo | null): string | null {
  if (!env) return null;
  const osName =
    env.platform === 'darwin'
      ? 'macOS'
      : env.platform === 'win32'
        ? 'Windows'
        : env.platform === 'linux'
          ? 'Linux'
          : env.platform;

  const dateHuman = formatDateIsoHuman(env.dateIso);
  const lines = ['[ENVIRONMENT]'];
  lines.push(`Working directory: ${env.cwd}`);
  lines.push(`Platform: ${osName} (${env.arch})`);
  lines.push(`Current date: ${dateHuman}`);
  if (env.isGitRepo) {
    const branch = env.gitBranch ?? '(detached)';
    const dirty = env.gitDirty === true ? ' — dirty' : env.gitDirty === false ? ' — clean' : '';
    lines.push(`Git: ${branch}${dirty}`);
  } else if (env.isGitRepo === false) {
    lines.push('Git: not a repository');
  }
  return lines.join('\n');
}

/** Format an ISO-8601 timestamp as human-readable local text. */
function formatDateIsoHuman(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dateStr = d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeStr = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${dateStr}, ${timeStr}`;
}

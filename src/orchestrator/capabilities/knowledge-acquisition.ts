/**
 * Knowledge Acquisition (Phase 3 — provider-based, local-first default).
 *
 * When the capability router decides `recommendedAction === 'research'`,
 * the orchestrator calls `acquireKnowledge` to gather *context* — never
 * authoritative facts, never goal rewrites.
 *
 * Built-in local providers, in order of trust:
 *   1. WorldGraph facts          — deterministic, content-addressed (A4)
 *   2. Workspace docs (README/.md) — heuristic; tier=heuristic (A5)
 *   3. External providers (MCP/web) must be adapters at the edge; their
 *      output is parsed and converted into KnowledgeContext before it reaches
 *      this orchestrator path. Internal peer providers use ECP/A2A, not MCP.
 *
 * Everything is local I/O. No network. The function is best-effort:
 * source failures degrade silently and do NOT block routing.
 *
 * The result is rendered into the worker prompt as a `RESEARCH_CONTEXT:`
 * pipeline constraint, parsed by `agent-worker-entry.ts` into a
 * `## Research Context` section. The block is explicitly tagged
 * probabilistic so the LLM treats it as a weak preference hint (A2/A5).
 */
import { promises as fs, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import type {
  CapabilityGapAnalysis,
  CapabilityRequirement,
  KnowledgeAcquisitionProviderId,
  KnowledgeAcquisitionRequest,
  KnowledgeContext,
} from '../types.ts';

/** Maximum hits per source — caps prompt bloat on noisy queries. */
export const DEFAULT_MAX_PER_SOURCE = 3;
/** Hard limit on total contexts — cheaper than letting prompts grow unbounded. */
export const DEFAULT_MAX_TOTAL = 8;
/** Cap on individual content snippet length (chars). */
export const SNIPPET_MAX_CHARS = 240;
/** Files we'll grep for workspace docs context. */
const DOC_FILE_PATTERN = /\.(md|mdx|markdown|txt)$/i;
/** Directories never to recurse into when scanning docs. */
const DOC_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

export interface AcquireKnowledgeDeps {
  /** Optional WorldGraph for fact lookups by symbol/path target. */
  worldGraph?: WorldGraph;
  /** Workspace root for doc grep. Absent → docs source skipped. */
  workspace?: string;
  /** Provider adapters beyond the built-in local sources. */
  knowledgeProviders?: readonly KnowledgeProvider[];
  /** Per-source cap. Defaults to DEFAULT_MAX_PER_SOURCE. */
  maxPerSource?: number;
  /** Total cap across all sources. Defaults to DEFAULT_MAX_TOTAL. */
  maxTotal?: number;
}

export type KnowledgeProviderId = KnowledgeAcquisitionProviderId;

export interface KnowledgeProviderContext {
  maxPerSource: number;
  now: () => number;
}

export interface KnowledgeProvider {
  /** Provider id used by KnowledgeAcquisitionRequest.providers. */
  readonly id: KnowledgeProviderId;
  /** Best-effort evidence collection. Throwing providers are isolated by acquireKnowledge(). */
  collect(req: KnowledgeAcquisitionRequest, ctx: KnowledgeProviderContext): Promise<KnowledgeContext[]> | KnowledgeContext[];
}

export interface ResearchPlanningOptions {
  providers?: readonly KnowledgeProviderId[];
}

/**
 * Build a KnowledgeAcquisitionRequest from a CapabilityGapAnalysis.
 *
 * The router emits `recommendedAction === 'research'` when there is a
 * partial fit but not a strong one. We turn the unmet requirements into
 * retrieval queries — capability id + verb hints + framework markers.
 *
 * Returns null when there is nothing meaningful to look up (fully met,
 * no requirements, recommendedAction not in the research family).
 */
export function planFromGapForResearch(
  taskId: string,
  analysis: CapabilityGapAnalysis,
  options: ResearchPlanningOptions = {},
): KnowledgeAcquisitionRequest | null {
  if (analysis.recommendedAction !== 'research') return null;
  if (!analysis.required || analysis.required.length === 0) return null;

  const top = analysis.candidates[0];
  const matched = new Set(top?.matched.map((m) => m.id) ?? []);
  const unmet = analysis.required.filter((r) => !matched.has(r.id));
  if (unmet.length === 0) return null;

  const queries = buildQueries(unmet);
  if (queries.length === 0) return null;

  return {
    taskId,
    capabilities: unmet.map((r) => r.id),
    queries,
    providers: [...(options.providers ?? ['world-graph', 'docs'])],
  };
}

function buildQueries(reqs: CapabilityRequirement[]): string[] {
  const out = new Set<string>();
  for (const r of reqs) {
    out.add(r.id);
    if (r.actionVerbs) {
      for (const v of r.actionVerbs) {
        if (v.length >= 3) out.add(v);
      }
    }
    if (r.frameworkMarkers) {
      for (const f of r.frameworkMarkers) {
        if (f.length >= 2) out.add(f);
      }
    }
  }
  // Bound query count — guards against pathological capability lists.
  return Array.from(out).slice(0, 12);
}

/**
 * Run all configured local sources for a request and return a flat list of
 * knowledge contexts ranked by confidence (descending).
 *
 * Best-effort — every source is wrapped in try/catch so that a single
 * failure can't poison the whole acquisition phase. Returning [] is a
 * valid outcome (A2): the worker just won't get a `[RESEARCH CONTEXT]`
 * section, never a fabricated one.
 */
export async function acquireKnowledge(
  req: KnowledgeAcquisitionRequest,
  deps: AcquireKnowledgeDeps,
): Promise<KnowledgeContext[]> {
  if (req.queries.length === 0) return [];
  const maxPerSource = deps.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const maxTotal = deps.maxTotal ?? DEFAULT_MAX_TOTAL;
  const providerOrder = req.providers ?? ['world-graph', 'docs'];
  const providers = buildProviderRegistry(deps);
  const providerCtx: KnowledgeProviderContext = { maxPerSource, now: () => Date.now() };
  const out: KnowledgeContext[] = [];

  for (const providerId of providerOrder) {
    if (out.length >= maxTotal) break;
    const provider = providers.get(providerId);
    if (!provider) continue;
    try {
      const hits = await provider.collect(req, providerCtx);
      out.push(...hits);
    } catch {
      /* defensive — best effort */
    }
  }

  // Sort by confidence desc; tie-break by source order (deterministic
  // governance: same inputs → same prompt → same cache key).
  const sourceRank: Record<KnowledgeContext['source'], number> = {
    'world-graph': 0,
    'workspace-docs': 1,
    'trace-cache': 2,
    mcp: 3,
    web: 4,
    peer: 5,
  };
  out.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return sourceRank[a.source] - sourceRank[b.source];
  });
  return out.slice(0, maxTotal);
}

function buildProviderRegistry(deps: AcquireKnowledgeDeps): Map<KnowledgeProviderId, KnowledgeProvider> {
  const providers = new Map<KnowledgeProviderId, KnowledgeProvider>();
  if (deps.worldGraph) {
    providers.set('world-graph', createWorldGraphKnowledgeProvider(deps.worldGraph));
  }
  if (deps.workspace) {
    providers.set('docs', createWorkspaceDocsKnowledgeProvider(deps.workspace));
  }
  for (const provider of deps.knowledgeProviders ?? []) {
    providers.set(provider.id, provider);
  }
  return providers;
}

export function createWorldGraphKnowledgeProvider(worldGraph: WorldGraph): KnowledgeProvider {
  return {
    id: 'world-graph',
    collect(req, ctx) {
      return collectFromWorldGraph(req, worldGraph, ctx.maxPerSource, ctx.now());
    },
  };
}

export function createWorkspaceDocsKnowledgeProvider(workspace: string): KnowledgeProvider {
  return {
    id: 'docs',
    collect(req, ctx) {
      return collectFromWorkspaceDocs(req, workspace, ctx.maxPerSource, ctx.now());
    },
  };
}

function collectFromWorldGraph(
  req: KnowledgeAcquisitionRequest,
  wg: WorldGraph,
  maxPerSource: number,
  retrievedAt: number,
): KnowledgeContext[] {
  const seen = new Set<string>();
  const out: KnowledgeContext[] = [];
  for (const q of req.queries) {
    if (out.length >= maxPerSource * req.queries.length) break;
    const facts = wg.queryFacts(q) ?? [];
    let perQuery = 0;
    for (const f of facts) {
      if (perQuery >= maxPerSource) break;
      const key = `${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: 'world-graph',
        capability: matchedCapability(req.capabilities, q),
        query: q,
        content: truncate(`${f.pattern} (${f.oracleName})`, SNIPPET_MAX_CHARS),
        reference: f.id,
        // World-graph facts arrive with their own confidence; clamp into
        // [0, 1] just in case, and never let it exceed 0.9 — research
        // context is *evidence*, not verdict (A1). The verifier still
        // owns the final word.
        confidence: clamp01(Math.min(0.9, f.confidence ?? 0.6)),
        retrievedAt,
      });
      perQuery++;
    }
  }
  return out;
}

async function collectFromWorkspaceDocs(
  req: KnowledgeAcquisitionRequest,
  workspace: string,
  maxPerSource: number,
  retrievedAt: number,
): Promise<KnowledgeContext[]> {
  const docFiles = await listDocFiles(workspace, 4);
  if (docFiles.length === 0) return [];
  const seen = new Set<string>();
  const out: KnowledgeContext[] = [];
  for (const q of req.queries) {
    const needle = q.toLowerCase();
    if (needle.length < 2) continue;
    let perQuery = 0;
    for (const file of docFiles) {
      if (perQuery >= maxPerSource) break;
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx < 0) continue;
      const snippet = extractSnippet(text, idx, needle.length);
      const key = `${file}#${snippet.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: 'workspace-docs',
        capability: matchedCapability(req.capabilities, q),
        query: q,
        content: truncate(snippet, SNIPPET_MAX_CHARS),
        reference: relative(workspace, file),
        // Heuristic tier (A5) — substring grep is a coarse signal.
        confidence: 0.4,
        retrievedAt,
      });
      perQuery++;
    }
  }
  return out;
}

async function listDocFiles(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  await walk(root, 0);
  return out;

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as import('node:fs').Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DOC_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && DOC_FILE_PATTERN.test(entry.name)) {
        try {
          const stat = statSync(full);
          // Skip massive files — likely generated.
          if (stat.size > 512 * 1024) continue;
        } catch {
          continue;
        }
        out.push(full);
      }
    }
  }
}

function extractSnippet(text: string, idx: number, needleLen: number): string {
  const before = Math.max(0, idx - 80);
  const after = Math.min(text.length, idx + needleLen + 160);
  // Collapse internal whitespace for clean prompt rendering.
  return text.slice(before, after).replace(/\s+/g, ' ').trim();
}

function matchedCapability(capabilities: string[], query: string): string | undefined {
  return capabilities.find((c) => c === query);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Build the `RESEARCH_CONTEXT:` pipeline-constraint string consumed by
 * `agent-worker-entry.ts`. The payload is JSON so the worker parser can
 * validate fields before rendering.
 *
 * Returns null when there is nothing to ship — the caller must skip the
 * push entirely so the worker never sees an empty section header.
 */
export function buildResearchContextConstraint(contexts: KnowledgeContext[]): string | null {
  if (contexts.length === 0) return null;
  const payload = {
    entries: contexts.map((c) => ({
      source: c.source,
      capability: c.capability,
      query: c.query,
      content: c.content,
      reference: c.reference,
      confidence: c.confidence,
    })),
  };
  return `RESEARCH_CONTEXT:${JSON.stringify(payload)}`;
}

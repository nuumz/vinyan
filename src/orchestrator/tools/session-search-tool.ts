/**
 * `session_search` — user-visible LLM tool for historical recall over the
 * unified memory records store (`memory_records_fts`, migration 003).
 *
 * This file is the thin Tool wrapper around `searchSessions` in
 * `session-search-impl.ts`. The heavy lifting (profile/tier/freshness
 * filtering, bm25 → composite scoring) lives there; this module only
 * adapts parameters, validates input, and renders a summary string for
 * LLM consumption.
 *
 * A3 — deterministic governance: parameter validation is rule-based.
 * A4 — FTS5 text match is a deterministic signal at the matching-process
 *      level, but hits retain their own `evidenceTier` (the tool does not
 *      upgrade tiers).
 */
import { isConfidenceTier } from '../../core/confidence-tier.ts';
import { MEMORY_KINDS, type MemoryKind } from '../../memory/provider/types.ts';
import type { ToolResult } from '../types.ts';
import {
  renderTopHits,
  searchSessions,
  type SessionScope,
  type SessionSearchDeps,
  type SessionSearchInput,
  type SessionSearchResult,
} from './session-search-impl.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

// ── Dep injection ───────────────────────────────────────────────────────

export interface SessionSearchToolDeps extends SessionSearchDeps {}

// ── Helpers ─────────────────────────────────────────────────────────────

const SESSION_SCOPES: readonly SessionScope[] = ['current', 'recent7d', 'all'];

function makeResult(callId: string, partial: Partial<ToolResult>): ToolResult {
  return { callId, tool: 'session_search', status: 'success', durationMs: 0, ...partial };
}

function isSessionScope(value: unknown): value is SessionScope {
  return typeof value === 'string' && (SESSION_SCOPES as readonly string[]).includes(value);
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

/**
 * Normalize the raw params record into a `SessionSearchInput`. Returns an
 * `Error` string when required fields are missing/invalid so the caller can
 * return a 'error' ToolResult instead of throwing.
 */
function parseParams(params: Record<string, unknown>): { ok: true; input: SessionSearchInput } | { ok: false; error: string } {
  const query = typeof params.query === 'string' ? params.query : '';
  if (query.length === 0) {
    return { ok: false, error: 'Parameter `query` is required and must be a non-empty string' };
  }
  const profile = typeof params.profile === 'string' ? params.profile : '';
  if (profile.length === 0) {
    return { ok: false, error: 'Parameter `profile` is required' };
  }

  // Build a mutable draft then freeze into the readonly SessionSearchInput.
  const draft: {
    query: string;
    profile: string;
    sessionScope?: SessionScope;
    sessionId?: string;
    kinds?: readonly MemoryKind[];
    minTier?: import('../../core/confidence-tier.ts').ConfidenceTier;
    freshnessMs?: number;
    limit?: number;
  } = { query, profile };

  if (params.sessionScope !== undefined) {
    if (!isSessionScope(params.sessionScope)) {
      return { ok: false, error: "`sessionScope` must be one of 'current' | 'recent7d' | 'all'" };
    }
    draft.sessionScope = params.sessionScope;
  }
  if (params.sessionId !== undefined) {
    if (typeof params.sessionId !== 'string') {
      return { ok: false, error: '`sessionId` must be a string' };
    }
    draft.sessionId = params.sessionId;
  }
  if (params.kinds !== undefined) {
    if (!Array.isArray(params.kinds) || !params.kinds.every(isMemoryKind)) {
      return { ok: false, error: `\`kinds\` must be an array of [${MEMORY_KINDS.join(', ')}]` };
    }
    draft.kinds = params.kinds as readonly MemoryKind[];
  }
  if (params.minTier !== undefined) {
    if (!isConfidenceTier(params.minTier)) {
      return { ok: false, error: '`minTier` must be a ConfidenceTier' };
    }
    draft.minTier = params.minTier;
  }
  if (params.freshnessMs !== undefined) {
    if (typeof params.freshnessMs !== 'number' || !Number.isFinite(params.freshnessMs) || params.freshnessMs < 0) {
      return { ok: false, error: '`freshnessMs` must be a non-negative number' };
    }
    draft.freshnessMs = params.freshnessMs;
  }
  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number' || !Number.isFinite(params.limit)) {
      return { ok: false, error: '`limit` must be a finite number' };
    }
    draft.limit = params.limit;
  }

  return { ok: true, input: draft };
}

// ── Tool factory ────────────────────────────────────────────────────────

export function createSessionSearchTool(deps: SessionSearchToolDeps): Tool {
  const description =
    'Search historical session turns + memory records by FTS5 keyword match. ' +
    'Profile-scoped (no cross-profile reads). Filters by kind, minimum ' +
    'confidence tier, and freshness. Deterministic text match (A4) — hits ' +
    "retain each record's original evidence tier.";

  return {
    name: 'session_search',
    description,
    minIsolationLevel: 0,
    category: 'search',
    sideEffect: false,
    descriptor(): ToolDescriptor {
      return {
        name: 'session_search',
        description,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'FTS5 keyword phrase. Operators are treated as literal terms.' },
            profile: { type: 'string', description: 'Profile scope. Cross-profile wildcards are rejected.' },
            sessionScope: {
              type: 'string',
              description: "'current' (requires sessionId), 'recent7d', or 'all'. Default 'all'.",
              enum: ['current', 'recent7d', 'all'],
            },
            sessionId: { type: 'string', description: "Session id — required when sessionScope is 'current'." },
            kinds: {
              type: 'array',
              description: 'Optional filter by memory kind.',
              items: { type: 'string' },
            },
            minTier: {
              type: 'string',
              description: 'Inclusive floor on evidence tier.',
              enum: ['deterministic', 'heuristic', 'probabilistic', 'speculative'],
            },
            freshnessMs: { type: 'number', description: 'Only records newer than (now - freshnessMs).' },
            limit: { type: 'number', description: 'Max hits returned (bounded to [1, 50]; default 10).' },
          },
          required: ['query', 'profile'],
        },
        category: 'search',
        sideEffect: false,
        minRoutingLevel: 0,
        toolKind: 'executable',
      };
    },
    async execute(params): Promise<ToolResult> {
      const callId = (params.callId as string) ?? '';
      const parsed = parseParams(params);
      if (!parsed.ok) {
        return makeResult(callId, { status: 'error', error: parsed.error });
      }
      try {
        const result: SessionSearchResult = await searchSessions(parsed.input, deps);
        const renderedText = renderTopHits(result.hits, 3);
        return makeResult(callId, {
          output: {
            query: result.query,
            hits: result.hits,
            totalCandidates: result.totalCandidates,
            truncated: result.truncated,
            ...(result.warning !== undefined ? { warning: result.warning } : {}),
            renderedText,
          },
        });
      } catch (e) {
        return makeResult(callId, {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}

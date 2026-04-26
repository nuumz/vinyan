/**
 * Skill tools — progressive disclosure surface (Decision 20).
 *
 *   skills_list       → L0 catalog (tiered, budget-packed)
 *   skill_view        → L1 single skill (frontmatter + authored body)
 *   skill_view_file   → L2 whitelisted companion file read
 *
 * All three tools are read-only (sideEffect: false). They are rule-gated:
 *   - `status ∈ {quarantined, retired}` ⇒ deny L1/L2 access.
 *   - Path-traversal / non-whitelisted files ⇒ deny L2 access.
 *
 * No LLM is consulted for any authorization decision here (A3 Deterministic
 * Governance).
 */

import { type ConfidenceTier, isConfidenceTier, rankOf } from '../../core/confidence-tier.ts';
import {
  SkillArtifactNotFoundError,
  type SkillArtifactStore,
  SkillFileNotWhitelistedError,
  SkillPathTraversalError,
} from '../../skills/artifact-store.ts';
import {
  renderL0List,
  type SkillL0View,
  type SkillL1View,
  type SkillL2View,
  toL0,
  toL1,
} from '../../skills/progressive-disclosure.ts';
import { L2_BUDGET_TOKENS, truncateToTokenBudget } from '../../skills/token-budget.ts';
import type { ToolResult } from '../types.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

// ── Dep injection ───────────────────────────────────────────────────────

export interface SkillToolsDeps {
  readonly artifactStore: SkillArtifactStore;
}

// ── Errors ──────────────────────────────────────────────────────────────

export class SkillAccessDeniedError extends Error {
  constructor(skillId: string, status: string) {
    super(`Access to skill '${skillId}' denied — status='${status}'`);
    this.name = 'SkillAccessDeniedError';
  }
}

const BLOCKED_STATUSES = new Set(['quarantined', 'retired']);

// ── Helpers ─────────────────────────────────────────────────────────────

function makeResult(callId: string, tool: string, partial: Partial<ToolResult>): ToolResult {
  return { callId, tool, status: 'success', durationMs: 0, ...partial };
}

/** Load every L0 view from disk. */
async function loadAllL0(store: SkillArtifactStore): Promise<Array<{ l0: SkillL0View; mtime: number }>> {
  const entries = await store.list();
  const out: Array<{ l0: SkillL0View; mtime: number }> = [];
  for (const entry of entries) {
    try {
      const record = await store.read(entry.id);
      // mtime for tiebreak (recency).
      const { statSync } = await import('node:fs');
      const mtime = statSync(entry.absolutePath).mtimeMs;
      out.push({ l0: toL0(record), mtime });
    } catch {
      // Skip malformed artifacts — they'll be surfaced by the exporter/admin UI.
    }
  }
  return out;
}

// ── Tool factories ──────────────────────────────────────────────────────

/** `skills_list` — compact catalog view (L0). */
export function createSkillsListTool(deps: SkillToolsDeps): Tool {
  return {
    name: 'skills_list',
    description:
      'List available SKILL.md capability packages as compact L0 cards ' +
      '(id, name, tier, toolsets). Filter by `tier` and cap with `limit`. ' +
      'Use this to discover skills before reading one in full via `skill_view`.',
    minIsolationLevel: 0,
    category: 'file_read',
    sideEffect: false,
    descriptor(): ToolDescriptor {
      return {
        name: 'skills_list',
        description: this.description,
        inputSchema: {
          type: 'object',
          properties: {
            tier: {
              type: 'string',
              description: 'Optional filter by confidence tier.',
              enum: ['deterministic', 'heuristic', 'probabilistic', 'speculative'],
            },
            limit: {
              type: 'number',
              description: 'Max number of skills to include (after tier filter, before budget packing).',
            },
          },
          required: [],
        },
        category: 'file_read',
        sideEffect: false,
        minRoutingLevel: 0,
        toolKind: 'executable',
      };
    },
    async execute(params): Promise<ToolResult> {
      const callId = (params.callId as string) ?? '';
      const tierFilterRaw = typeof params.tier === 'string' ? params.tier : undefined;
      const tierFilter: ConfidenceTier | undefined = isConfidenceTier(tierFilterRaw) ? tierFilterRaw : undefined;
      const limit =
        typeof params.limit === 'number' && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : undefined;

      try {
        const all = await loadAllL0(deps.artifactStore);
        let filtered = all;
        if (tierFilter) {
          filtered = filtered.filter((e) => e.l0.confidenceTier === tierFilter);
        }
        // Sort by tier desc, then mtime desc.
        filtered.sort((a, b) => {
          const tierDelta = rankOf(b.l0.confidenceTier) - rankOf(a.l0.confidenceTier);
          if (tierDelta !== 0) return tierDelta;
          return b.mtime - a.mtime;
        });
        if (limit !== undefined) {
          filtered = filtered.slice(0, limit);
        }
        const views = filtered.map((e) => e.l0);
        const rendered = renderL0List(views);
        return makeResult(callId, 'skills_list', {
          output: {
            skills: views.slice(0, rendered.shown),
            truncated: rendered.truncated,
            renderedText: rendered.text,
          },
        });
      } catch (e) {
        return makeResult(callId, 'skills_list', {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}

/** `skill_view` — L1 view of a single skill. */
export function createSkillViewTool(deps: SkillToolsDeps): Tool {
  return {
    name: 'skill_view',
    description:
      'Read the L1 view of a single SKILL.md by id — frontmatter + authored ' +
      'sections (overview, when to use, procedure, ...) without the companion ' +
      'files. Access denied for skills whose status is quarantined or retired.',
    minIsolationLevel: 0,
    category: 'file_read',
    sideEffect: false,
    descriptor(): ToolDescriptor {
      return {
        name: 'skill_view',
        description: this.description,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Skill id (e.g. `refactor/extract-method-ts`).' },
          },
          required: ['id'],
        },
        category: 'file_read',
        sideEffect: false,
        minRoutingLevel: 0,
        toolKind: 'executable',
      };
    },
    async execute(params): Promise<ToolResult> {
      const callId = (params.callId as string) ?? '';
      const id = typeof params.id === 'string' ? params.id : '';
      if (id.length === 0) {
        return makeResult(callId, 'skill_view', { status: 'error', error: 'Parameter `id` is required' });
      }
      try {
        const record = await deps.artifactStore.read(id);
        const status = record.frontmatter.status;
        if (BLOCKED_STATUSES.has(status)) {
          throw new SkillAccessDeniedError(id, status);
        }
        const view: SkillL1View = toL1(record);
        return makeResult(callId, 'skill_view', { output: view });
      } catch (e) {
        if (e instanceof SkillArtifactNotFoundError) {
          return makeResult(callId, 'skill_view', { status: 'error', error: e.message });
        }
        if (e instanceof SkillAccessDeniedError) {
          return makeResult(callId, 'skill_view', { status: 'denied', error: e.message });
        }
        return makeResult(callId, 'skill_view', {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}

/** `skill_view_file` — L2 view of a whitelisted companion file. */
export function createSkillViewFileTool(deps: SkillToolsDeps): Tool {
  return {
    name: 'skill_view_file',
    description:
      'Read a companion file attached to a SKILL.md (L2 view). The file must ' +
      'be whitelisted in the SKILL.md `## Files` section; path traversal is ' +
      'rejected. Access denied for quarantined / retired skills.',
    minIsolationLevel: 0,
    category: 'file_read',
    sideEffect: false,
    descriptor(): ToolDescriptor {
      return {
        name: 'skill_view_file',
        description: this.description,
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Skill id.' },
            path: { type: 'string', description: 'Relative file path whitelisted by the SKILL.md.' },
          },
          required: ['id', 'path'],
        },
        category: 'file_read',
        sideEffect: false,
        minRoutingLevel: 0,
        toolKind: 'executable',
      };
    },
    async execute(params): Promise<ToolResult> {
      const callId = (params.callId as string) ?? '';
      const id = typeof params.id === 'string' ? params.id : '';
      const path = typeof params.path === 'string' ? params.path : '';
      if (id.length === 0 || path.length === 0) {
        return makeResult(callId, 'skill_view_file', {
          status: 'error',
          error: 'Parameters `id` and `path` are required',
        });
      }
      try {
        const record = await deps.artifactStore.read(id);
        const status = record.frontmatter.status;
        if (BLOCKED_STATUSES.has(status)) {
          throw new SkillAccessDeniedError(id, status);
        }
        const { content, bytes } = await deps.artifactStore.readFile(id, path);
        const truncated = truncateToTokenBudget(content, L2_BUDGET_TOKENS);
        const view: SkillL2View = {
          skillId: id,
          relativePath: path,
          content: truncated.text,
          bytes,
          truncated: truncated.truncated,
        };
        return makeResult(callId, 'skill_view_file', { output: view });
      } catch (e) {
        if (
          e instanceof SkillAccessDeniedError ||
          e instanceof SkillFileNotWhitelistedError ||
          e instanceof SkillPathTraversalError
        ) {
          return makeResult(callId, 'skill_view_file', { status: 'denied', error: e.message });
        }
        if (e instanceof SkillArtifactNotFoundError) {
          return makeResult(callId, 'skill_view_file', { status: 'error', error: e.message });
        }
        return makeResult(callId, 'skill_view_file', {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}

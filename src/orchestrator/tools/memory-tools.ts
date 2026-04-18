/**
 * Memory tools — memory_propose.
 *
 * Agents propose M4 learned conventions through this tool. The proposal is
 * grammar-checked by an oracle validator (see `memory-proposals.ts`) and
 * written to `.vinyan/memory/pending/` for human review. Agents never write
 * directly to `.vinyan/memory/learned.md` — doing so would violate the A1
 * axiom (human-as-truth).
 *
 * Routing: L2+ only. L1 single-turn workers cannot propose memory because
 * they lack the session context needed to justify a new convention.
 */

import type { ToolResult } from '../types.ts';
import {
  type MemoryProposal,
  type ProposalCategory,
  type ProposalEvidence,
  type ProposalTier,
  writeProposal,
} from '../memory/memory-proposals.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

/**
 * Local copy of makeResult to avoid an import cycle with built-in-tools.ts.
 * built-in-tools.ts imports this file for the BUILT_IN_TOOLS map, so we
 * cannot import anything back from it at module load time without risking
 * a TDZ error when memory-tools.ts is imported directly (e.g., from a test).
 */
function makeResult(callId: string, tool: string, partial: Partial<ToolResult>): ToolResult {
  return {
    callId,
    tool,
    status: 'success',
    durationMs: 0,
    ...partial,
  };
}

/**
 * Coerce the raw tool parameters into a typed MemoryProposal. Any missing
 * or wrongly typed fields will be caught by `validateProposal` downstream —
 * this function only handles the shape coercion.
 */
function coerceProposal(params: Record<string, unknown>): MemoryProposal {
  const evidenceRaw = Array.isArray(params.evidence) ? (params.evidence as unknown[]) : [];
  const evidence: ProposalEvidence[] = evidenceRaw.map((e) => {
    const obj = (e ?? {}) as Record<string, unknown>;
    return {
      filePath: typeof obj.file_path === 'string' ? obj.file_path : String(obj.filePath ?? ''),
      line: typeof obj.line === 'number' ? obj.line : undefined,
      note: typeof obj.note === 'string' ? obj.note : '',
    };
  });

  const applyTo = Array.isArray(params.apply_to)
    ? (params.apply_to as unknown[]).map((g) => String(g))
    : undefined;

  return {
    slug: String(params.slug ?? ''),
    proposedBy: String(params.proposed_by ?? 'worker'),
    sessionId: String(params.session_id ?? 'unknown'),
    category: (params.category ?? 'finding') as ProposalCategory,
    tier: (params.tier ?? 'heuristic') as ProposalTier,
    confidence: typeof params.confidence === 'number' ? params.confidence : Number.NaN,
    applyTo,
    description: String(params.description ?? ''),
    body: String(params.body ?? ''),
    evidence,
  };
}

export const memoryPropose: Tool = {
  name: 'memory_propose',
  description:
    'Propose a new learned convention for M4 memory. The proposal is written to ' +
    '.vinyan/memory/pending/ and awaits human review — it does NOT immediately ' +
    'modify project memory. Use this when you notice a durable project rule ' +
    '(naming, style, anti-pattern, API contract) that future sessions should know.',
  minIsolationLevel: 2,
  category: 'file_write',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'memory_propose',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'Short kebab-case slug identifying this rule (e.g., "prefer-bun-test").',
          },
          category: {
            type: 'string',
            description: 'Proposal category.',
            enum: ['convention', 'anti-pattern', 'finding'],
          },
          tier: {
            type: 'string',
            description:
              'Trust tier. "deterministic" = verified by oracle, "heuristic" = strong pattern evidence, "probabilistic" = observation only.',
            enum: ['deterministic', 'heuristic', 'probabilistic'],
          },
          confidence: {
            type: 'number',
            description: 'Your confidence in [0.7, 1.0]. Proposals below 0.7 are rejected by the oracle.',
          },
          description: {
            type: 'string',
            description: '1-3 sentence summary of the rule for reviewers.',
          },
          body: {
            type: 'string',
            description: 'Markdown body with the full proposed rule text (do/don\'t examples, rationale).',
          },
          apply_to: {
            type: 'array',
            description: 'Optional glob patterns this rule applies to (e.g., ["src/**/*.ts"]).',
            items: { type: 'string' },
          },
          evidence: {
            type: 'array',
            description:
              'Empirical support for the rule. At least one entry required. Each entry: {file_path, line?, note}.',
            items: { type: 'object' },
          },
          proposed_by: {
            type: 'string',
            description: 'Your worker / subagent identifier. Defaults to "worker".',
          },
          session_id: {
            type: 'string',
            description: 'Orchestrator session id for traceability. Defaults to "unknown".',
          },
        },
        required: ['slug', 'category', 'tier', 'confidence', 'description', 'body', 'evidence'],
      },
      category: 'file_write',
      sideEffect: true,
      minRoutingLevel: 2,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const callId = (params.callId as string) ?? '';
    const proposal = coerceProposal(params);

    try {
      const result = writeProposal(context.workspace, proposal);
      return makeResult(callId, 'memory_propose', {
        output:
          `Proposal "${proposal.slug}" written to ${result.path} (pending human review). ` +
          `The rule will NOT affect this session — it will be considered by a human and, ` +
          `if approved, merged into .vinyan/memory/learned.md for future sessions.`,
      });
    } catch (e) {
      return makeResult(callId, 'memory_propose', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

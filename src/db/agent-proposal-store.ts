import type { Database } from 'bun:sqlite';
import type { AgentProposal, AgentProposalStatus } from '../orchestrator/types.ts';

export interface AgentProposalWriteResult {
  proposal: AgentProposal;
  created: boolean;
  updated: boolean;
}

interface AgentProposalRow {
  id: string;
  status: string;
  suggestedAgentId: string;
  taskTypeSignature: string;
  name: string;
  description: string;
  unmetCapabilityIds: string;
  capabilityClaims: string;
  roles: string;
  allowedTools: string;
  capabilityOverrides: string;
  sourceSyntheticAgentIds: string;
  evidenceTraceIds: string;
  observationCount: number;
  successCount: number;
  wilsonLowerBound: number;
  trustTier: string;
  provenance: string;
  rationale: string;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decisionReason: string | null;
}

const SELECT_COLUMNS = `
  id,
  status,
  suggested_agent_id AS suggestedAgentId,
  task_type_signature AS taskTypeSignature,
  name,
  description,
  unmet_capability_ids AS unmetCapabilityIds,
  capability_claims AS capabilityClaims,
  roles,
  allowed_tools AS allowedTools,
  capability_overrides AS capabilityOverrides,
  source_synthetic_agent_ids AS sourceSyntheticAgentIds,
  evidence_trace_ids AS evidenceTraceIds,
  observation_count AS observationCount,
  success_count AS successCount,
  wilson_lower_bound AS wilsonLowerBound,
  trust_tier AS trustTier,
  provenance,
  rationale,
  created_at AS createdAt,
  updated_at AS updatedAt,
  decided_at AS decidedAt,
  decision_reason AS decisionReason
`;

export class AgentProposalStore {
  constructor(private readonly db: Database) {}

  upsertPending(proposal: AgentProposal): AgentProposalWriteResult {
    const existing = this.findById(proposal.id);
    if (existing && existing.status !== 'pending') {
      return { proposal: existing, created: false, updated: false };
    }

    if (existing) {
      const merged = { ...proposal, createdAt: existing.createdAt, status: existing.status };
      this.db
        .prepare(
          `UPDATE agent_proposals SET
             suggested_agent_id = ?, task_type_signature = ?, name = ?, description = ?,
             unmet_capability_ids = ?, capability_claims = ?, roles = ?, allowed_tools = ?,
             capability_overrides = ?, source_synthetic_agent_ids = ?, evidence_trace_ids = ?,
             observation_count = ?, success_count = ?, wilson_lower_bound = ?, trust_tier = ?,
             provenance = ?, rationale = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          merged.suggestedAgentId,
          merged.taskTypeSignature,
          merged.name,
          merged.description,
          JSON.stringify(merged.unmetCapabilityIds),
          JSON.stringify(merged.capabilityClaims),
          JSON.stringify(merged.roles),
          JSON.stringify(merged.allowedTools),
          JSON.stringify(merged.capabilityOverrides),
          JSON.stringify(merged.sourceSyntheticAgentIds),
          JSON.stringify(merged.evidenceTraceIds),
          merged.observationCount,
          merged.successCount,
          merged.wilsonLowerBound,
          merged.trustTier,
          merged.provenance,
          merged.rationale,
          merged.updatedAt,
          merged.id,
        );
      return { proposal: merged, created: false, updated: true };
    }

    this.insert(proposal);
    return { proposal, created: true, updated: false };
  }

  findById(id: string): AgentProposal | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM agent_proposals WHERE id = ?`)
      .get(id) as AgentProposalRow | null;
    return row ? rowToProposal(row) : null;
  }

  listByStatus(status: AgentProposalStatus = 'pending', limit = 100): AgentProposal[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM agent_proposals
         WHERE status = ?
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`,
      )
      .all(status, limit) as AgentProposalRow[];
    return rows.map(rowToProposal);
  }

  countByStatus(status: AgentProposalStatus = 'pending'): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM agent_proposals WHERE status = ?').get(status) as {
      count: number;
    };
    return row.count;
  }

  markDecided(
    id: string,
    status: Exclude<AgentProposalStatus, 'pending'>,
    reason: string,
    decidedAt = Date.now(),
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_proposals
         SET status = ?, decided_at = ?, decision_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decidedAt, reason, decidedAt, id);
    return result.changes > 0;
  }

  private insert(proposal: AgentProposal): void {
    this.db
      .prepare(
        `INSERT INTO agent_proposals (
          id, status, suggested_agent_id, task_type_signature, name, description,
          unmet_capability_ids, capability_claims, roles, allowed_tools, capability_overrides,
          source_synthetic_agent_ids, evidence_trace_ids, observation_count, success_count,
          wilson_lower_bound, trust_tier, provenance, rationale, created_at, updated_at,
          decided_at, decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.status,
        proposal.suggestedAgentId,
        proposal.taskTypeSignature,
        proposal.name,
        proposal.description,
        JSON.stringify(proposal.unmetCapabilityIds),
        JSON.stringify(proposal.capabilityClaims),
        JSON.stringify(proposal.roles),
        JSON.stringify(proposal.allowedTools),
        JSON.stringify(proposal.capabilityOverrides),
        JSON.stringify(proposal.sourceSyntheticAgentIds),
        JSON.stringify(proposal.evidenceTraceIds),
        proposal.observationCount,
        proposal.successCount,
        proposal.wilsonLowerBound,
        proposal.trustTier,
        proposal.provenance,
        proposal.rationale,
        proposal.createdAt,
        proposal.updatedAt,
        proposal.decidedAt ?? null,
        proposal.decisionReason ?? null,
      );
  }
}

function rowToProposal(row: AgentProposalRow): AgentProposal {
  return {
    id: row.id,
    status: row.status as AgentProposalStatus,
    suggestedAgentId: row.suggestedAgentId,
    name: row.name,
    description: row.description,
    taskTypeSignature: row.taskTypeSignature,
    unmetCapabilityIds: JSON.parse(row.unmetCapabilityIds),
    capabilityClaims: JSON.parse(row.capabilityClaims),
    roles: JSON.parse(row.roles),
    allowedTools: JSON.parse(row.allowedTools),
    capabilityOverrides: JSON.parse(row.capabilityOverrides),
    sourceSyntheticAgentIds: JSON.parse(row.sourceSyntheticAgentIds),
    evidenceTraceIds: JSON.parse(row.evidenceTraceIds),
    observationCount: row.observationCount,
    successCount: row.successCount,
    wilsonLowerBound: row.wilsonLowerBound,
    trustTier: row.trustTier as AgentProposal['trustTier'],
    provenance: row.provenance,
    rationale: row.rationale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
  };
}

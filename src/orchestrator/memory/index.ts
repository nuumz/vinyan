/**
 * Memory module — agent-proposed memory artifacts (currently M4 proposals).
 *
 * This module is separate from `llm/instruction-*` because instruction loading
 * is a read-only operation over human-authored sources, while memory proposals
 * are agent-authored write operations gated by an oracle. Keeping them apart
 * preserves the A1 axiom boundary at the module level.
 */

export {
  CONFIDENCE_FLOOR,
  EVIDENCE_FLOOR,
  MAX_PROPOSAL_SIZE,
  PENDING_DIR_REL,
  countPendingProposals,
  listPendingProposals,
  type MemoryProposal,
  type PendingProposalFile,
  type ProposalCategory,
  type ProposalEvidence,
  type ProposalTier,
  type ProposalValidationResult,
  type ProposalWriteResult,
  serializeProposal,
  validateProposal,
  writeProposal,
} from './memory-proposals.ts';

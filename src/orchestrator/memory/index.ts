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
  countPendingProposals,
  EVIDENCE_FLOOR,
  LEARNED_FILE_REL,
  type LearnedEntry,
  listPendingProposals,
  MAX_PROPOSAL_SIZE,
  type MemoryProposal,
  PENDING_DIR_REL,
  type PendingProposalFile,
  type ProposalCategory,
  type ProposalEvidence,
  type ProposalTier,
  type ProposalValidationResult,
  type ProposalWriteResult,
  parseLearnedMdEntries,
  serializeProposal,
  validateProposal,
  writeProposal,
} from './memory-proposals.ts';

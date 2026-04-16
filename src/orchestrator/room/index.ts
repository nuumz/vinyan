/**
 * Agent Conversation Room (ACR) — public API barrel export.
 *
 * Re-exports the types, dispatcher, selector, and supporting classes that
 * external consumers (factory.ts, phase-generate.ts) need. Internal details
 * (supervisor, ledger, blackboard) are NOT re-exported — they are consumed
 * only by RoomDispatcher itself.
 */

export {
  RoomDispatcher,
  type RoomDispatcherDeps,
  type RoomDispatchOutcome,
  type RoomExecuteInput,
} from './room-dispatcher.ts';
export { ROOM_SELECTOR_CONSTANTS, selectRoomContract } from './room-selector.ts';
export type {
  BlackboardEntry,
  ConvergenceOutcome,
  LedgerEntry,
  LedgerEntryType,
  RoleSpec,
  RoomContract,
  RoomParticipant,
  RoomResult,
  RoomState,
  RoomStatus,
} from './types.ts';
export {
  BlackboardScopeViolation,
  RoleSpecSchema,
  RoomAdmissionFailure,
  RoomBudgetExhausted,
  RoomContractSchema,
  RoomParticipantSchema,
} from './types.ts';

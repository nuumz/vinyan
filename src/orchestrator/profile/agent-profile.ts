/**
 * Agent Profile — shared abstraction across Worker, Oracle Peer, and Local Oracle.
 *
 * Unifies the four-lifecycle sprawl (WorkerProfile, OracleProfile, CachedSkill,
 * EvolutionaryRule) under one typed envelope so that promotion/demotion gates,
 * events, and read APIs can operate on a common shape.
 *
 * Source of truth: ultraplan "Unified Agent Profiles" Step 1.
 */

export type AgentProfileKind = 'worker' | 'oracle-peer' | 'oracle-local';

/** Status lifecycle shared across all profile kinds: probation → active → demoted → retired. */
export type AgentProfileStatus = 'probation' | 'active' | 'demoted' | 'retired';

/** Fields every profile must expose for ProfileLifecycle + FleetRegistry.
 *
 * `kind` is not part of this base interface — it lives on the discriminated
 * union below. Existing types like EngineProfile can implement the base
 * shape without a new column. The lifecycle learns its kind from config.
 */
export interface AgentProfileBase {
  id: string;
  status: AgentProfileStatus;
  createdAt: number;
  promotedAt?: number;
  demotedAt?: number;
  demotionReason?: string;
  /** Re-enrollment counter — after N demotions, profile retires permanently. */
  demotionCount: number;
}

/**
 * Minimal CRUD surface the generic lifecycle needs. Concrete stores
 * (WorkerStore, OracleProfileStore, LocalOracleProfileStore) implement this
 * adapter without abandoning their existing richer APIs.
 */
export interface ProfileStore<T extends AgentProfileBase> {
  findById(id: string): T | null;
  findByStatus(status: AgentProfileStatus): T[];
  findActive(): T[];
  updateStatus(id: string, status: AgentProfileStatus, reason?: string): void;
  /** Reset demotion state and return to probation after cooldown. */
  reEnroll?(id: string): void;
}

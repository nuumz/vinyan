/**
 * TeamManager — durable rosters with persistent shared blackboards.
 *
 * A Team is a group of engines that share state across many tasks. It is
 * distinct from a Room (task-scoped, dissolves on close) in three ways:
 *
 *  1. **Durability** — a team survives restart; its blackboard is in SQLite.
 *  2. **Composition** — membership is explicit (join/leave), not implicit
 *     from auction winners.
 *  3. **Scope** — a single team can participate in many rooms over time.
 *
 * Teams are optional; the system works without them. Use them when you
 * want cross-task memory for a specific agent group.
 *
 * Source of truth: docs/design/vinyan-os-ecosystem-plan.md §2.2, §3.1
 */

import { randomUUID } from 'crypto';

import type { TeamBlackboardEntry, TeamMemberRecord, TeamRecord, TeamStore } from '../../db/team-store.ts';

// ── Config ───────────────────────────────────────────────────────────

export interface TeamManagerConfig {
  readonly store: TeamStore;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface CreateTeamParams {
  name: string;
  departmentId?: string;
  initialMembers?: ReadonlyArray<{ engineId: string; role?: string }>;
}

// ── Manager ──────────────────────────────────────────────────────────

export class TeamManager {
  private readonly store: TeamStore;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(config: TeamManagerConfig) {
    this.store = config.store;
    this.now = config.now ?? (() => Date.now());
    this.newId = config.idFactory ?? (() => randomUUID());
  }

  // ── Roster ───────────────────────────────────────────────────────

  create(params: CreateTeamParams): TeamRecord {
    const teamId = this.newId();
    const createdAt = this.now();
    this.store.createTeam({
      teamId,
      name: params.name,
      departmentId: params.departmentId,
      createdAt,
    });
    if (params.initialMembers) {
      for (const m of params.initialMembers) {
        this.store.addMember({
          teamId,
          engineId: m.engineId,
          role: m.role,
          joinedAt: createdAt,
        });
      }
    }
    return this.store.getTeam(teamId)!;
  }

  get(teamId: string): TeamRecord | null {
    return this.store.getTeam(teamId);
  }

  listActive(): readonly TeamRecord[] {
    return this.store.listActiveTeams();
  }

  archive(teamId: string): boolean {
    return this.store.archiveTeam(teamId, this.now());
  }

  members(teamId: string): readonly TeamMemberRecord[] {
    return this.store.listMembers(teamId);
  }

  addMember(teamId: string, engineId: string, role?: string): void {
    if (!this.store.getTeam(teamId)) {
      throw new Error(`team: unknown team ${teamId}`);
    }
    // Skip if the engine is already an active member
    const existing = this.store.listMembers(teamId).find((m) => m.engineId === engineId);
    if (existing) return;
    this.store.addMember({ teamId, engineId, role, joinedAt: this.now() });
  }

  removeMember(teamId: string, engineId: string): boolean {
    return this.store.removeMember(teamId, engineId, this.now());
  }

  // ── Blackboard (persistent shared state) ─────────────────────────

  /**
   * Write a new version for (teamId, key). Returns the assigned version.
   * The value is JSON-serialized; pass anything serializable.
   */
  setState(teamId: string, key: string, value: unknown, authorId: string): number {
    if (!this.store.getTeam(teamId)) {
      throw new Error(`team: unknown team ${teamId}`);
    }
    return this.store.writeBlackboard({
      teamId,
      key,
      value,
      authorId,
      updatedAt: this.now(),
    });
  }

  /** Latest version for (teamId, key). `undefined` if the key has never been set. */
  getState<T = unknown>(teamId: string, key: string): T | undefined {
    const row = this.store.readBlackboard(teamId, key);
    return row ? (row.value as T) : undefined;
  }

  /** Full entry (with version + author + timestamp) for (teamId, key). */
  getStateEntry(teamId: string, key: string): TeamBlackboardEntry | null {
    return this.store.readBlackboard(teamId, key);
  }

  listStateKeys(teamId: string): readonly string[] {
    return this.store.listBlackboardKeys(teamId);
  }

  deleteState(teamId: string, key: string): number {
    return this.store.deleteBlackboardKey(teamId, key);
  }
}

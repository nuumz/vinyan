/**
 * TeamStore — SQLite persistence for teams + membership + blackboards.
 *
 * Schema from migration 033. Blackboard row shape intentionally mirrors
 * `room_blackboard` (migration 016) so tooling that walks versioned KV
 * state can operate on either.
 *
 * Restart-safe: all state is in SQLite, so long-running teams pick up
 * where they left off after a process restart.
 */

import type { Database, Statement } from 'bun:sqlite';

export interface TeamRecord {
  readonly teamId: string;
  readonly name: string;
  readonly departmentId: string | null;
  readonly createdAt: number;
  readonly archivedAt: number | null;
}

export interface TeamMemberRecord {
  readonly teamId: string;
  readonly engineId: string;
  readonly role: string | null;
  readonly joinedAt: number;
  readonly leftAt: number | null;
}

export interface TeamBlackboardEntry {
  readonly teamId: string;
  readonly key: string;
  readonly version: number;
  readonly value: unknown;
  readonly authorId: string;
  readonly updatedAt: number;
}

interface TeamRow {
  team_id: string;
  name: string;
  department_id: string | null;
  created_at: number;
  archived_at: number | null;
}

interface MemberRow {
  team_id: string;
  engine_id: string;
  role: string | null;
  joined_at: number;
  left_at: number | null;
}

interface BlackboardRow {
  team_id: string;
  key: string;
  version: number;
  value_json: string;
  author_id: string;
  updated_at: number;
}

export class TeamStore {
  private readonly sInsertTeam: Statement;
  private readonly sGetTeam: Statement;
  private readonly sListActiveTeams: Statement;
  private readonly sArchiveTeam: Statement;

  private readonly sInsertMember: Statement;
  private readonly sListMembers: Statement;
  private readonly sLeaveMember: Statement;

  private readonly sUpsertBlackboard: Statement;
  private readonly sGetBlackboard: Statement;
  private readonly sListBlackboardKeys: Statement;
  private readonly sDeleteBlackboard: Statement;
  private readonly sMaxVersion: Statement;

  constructor(db: Database) {
    this.sInsertTeam = db.prepare(`
      INSERT INTO teams (team_id, name, department_id, created_at) VALUES (?, ?, ?, ?)
    `);
    this.sGetTeam = db.prepare('SELECT * FROM teams WHERE team_id = ?');
    this.sListActiveTeams = db.prepare(
      'SELECT * FROM teams WHERE archived_at IS NULL ORDER BY created_at',
    );
    this.sArchiveTeam = db.prepare(
      'UPDATE teams SET archived_at = ? WHERE team_id = ? AND archived_at IS NULL',
    );

    this.sInsertMember = db.prepare(`
      INSERT INTO team_members (team_id, engine_id, role, joined_at)
      VALUES (?, ?, ?, ?)
    `);
    this.sListMembers = db.prepare(
      `SELECT * FROM team_members
          WHERE team_id = ? AND left_at IS NULL
          ORDER BY joined_at`,
    );
    this.sLeaveMember = db.prepare(
      `UPDATE team_members
          SET left_at = ?
        WHERE team_id = ? AND engine_id = ? AND left_at IS NULL`,
    );

    this.sUpsertBlackboard = db.prepare(`
      INSERT INTO team_blackboard (team_id, key, version, value_json, author_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.sGetBlackboard = db.prepare(`
      SELECT * FROM team_blackboard
       WHERE team_id = ? AND key = ?
       ORDER BY version DESC
       LIMIT 1
    `);
    this.sListBlackboardKeys = db.prepare(`
      SELECT DISTINCT key FROM team_blackboard WHERE team_id = ? ORDER BY key
    `);
    this.sDeleteBlackboard = db.prepare(
      'DELETE FROM team_blackboard WHERE team_id = ? AND key = ?',
    );
    this.sMaxVersion = db.prepare(
      'SELECT MAX(version) as v FROM team_blackboard WHERE team_id = ? AND key = ?',
    );
  }

  // ── Teams ────────────────────────────────────────────────────────

  createTeam(params: {
    teamId: string;
    name: string;
    departmentId?: string;
    createdAt: number;
  }): void {
    this.sInsertTeam.run(
      params.teamId,
      params.name,
      params.departmentId ?? null,
      params.createdAt,
    );
  }

  getTeam(teamId: string): TeamRecord | null {
    const row = this.sGetTeam.get(teamId) as TeamRow | null;
    return row ? mapTeam(row) : null;
  }

  listActiveTeams(): readonly TeamRecord[] {
    return (this.sListActiveTeams.all() as TeamRow[]).map(mapTeam);
  }

  archiveTeam(teamId: string, at: number): boolean {
    const r = this.sArchiveTeam.run(at, teamId) as { changes: number };
    return r.changes > 0;
  }

  // ── Members ──────────────────────────────────────────────────────

  addMember(params: {
    teamId: string;
    engineId: string;
    role?: string;
    joinedAt: number;
  }): void {
    this.sInsertMember.run(
      params.teamId,
      params.engineId,
      params.role ?? null,
      params.joinedAt,
    );
  }

  listMembers(teamId: string): readonly TeamMemberRecord[] {
    return (this.sListMembers.all(teamId) as MemberRow[]).map(mapMember);
  }

  removeMember(teamId: string, engineId: string, at: number): boolean {
    const r = this.sLeaveMember.run(at, teamId, engineId) as { changes: number };
    return r.changes > 0;
  }

  // ── Blackboard ───────────────────────────────────────────────────

  /**
   * Append a new version for (teamId, key). Version auto-increments from the
   * current MAX(version)+1. Returns the assigned version.
   */
  writeBlackboard(params: {
    teamId: string;
    key: string;
    value: unknown;
    authorId: string;
    updatedAt: number;
  }): number {
    const maxRow = this.sMaxVersion.get(params.teamId, params.key) as { v: number | null };
    const next = (maxRow.v ?? 0) + 1;
    this.sUpsertBlackboard.run(
      params.teamId,
      params.key,
      next,
      JSON.stringify(params.value),
      params.authorId,
      params.updatedAt,
    );
    return next;
  }

  /** Latest version for (teamId, key), or null if the key has never been written. */
  readBlackboard(teamId: string, key: string): TeamBlackboardEntry | null {
    const row = this.sGetBlackboard.get(teamId, key) as BlackboardRow | null;
    if (!row) return null;
    return mapBlackboard(row);
  }

  listBlackboardKeys(teamId: string): readonly string[] {
    const rows = this.sListBlackboardKeys.all(teamId) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  /** Delete every version for (teamId, key). */
  deleteBlackboardKey(teamId: string, key: string): number {
    const r = this.sDeleteBlackboard.run(teamId, key) as { changes: number };
    return r.changes;
  }
}

function mapTeam(row: TeamRow): TeamRecord {
  return {
    teamId: row.team_id,
    name: row.name,
    departmentId: row.department_id,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

function mapMember(row: MemberRow): TeamMemberRecord {
  return {
    teamId: row.team_id,
    engineId: row.engine_id,
    role: row.role,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
  };
}

function mapBlackboard(row: BlackboardRow): TeamBlackboardEntry {
  return {
    teamId: row.team_id,
    key: row.key,
    version: row.version,
    value: JSON.parse(row.value_json),
    authorId: row.author_id,
    updatedAt: row.updated_at,
  };
}

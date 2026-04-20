/**
 * TeamStore — SQLite persistence for teams + membership.
 *
 * As of docs/plans/sqlite-joyful-lynx.md §Phase 4, the blackboard
 * portion of team state lives ENTIRELY on the filesystem (via
 * `TeamBlackboardFs`). Migration 040 dropped the DB `team_blackboard`
 * table. The blackboard methods on this class require `fsBlackboard`
 * to be wired via `TeamStoreConfig`; they throw when it is missing.
 *
 * Teams + members stay in SQLite — they're relational and query-heavy,
 * which markdown cannot serve efficiently.
 */

import type { Database, Statement } from 'bun:sqlite';
import type { TeamBlackboardFs } from '../orchestrator/ecosystem/team-blackboard-fs.ts';

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

export interface TeamStoreConfig {
  /**
   * Filesystem-backed blackboard. Required for blackboard operations
   * (setState/getState/listKeys/delete). Team/member ops work without it.
   */
  fsBlackboard?: TeamBlackboardFs;
}

export class TeamStore {
  private readonly fsBlackboard?: TeamBlackboardFs;

  private readonly sInsertTeam: Statement;
  private readonly sGetTeam: Statement;
  private readonly sListActiveTeams: Statement;
  private readonly sArchiveTeam: Statement;

  private readonly sInsertMember: Statement;
  private readonly sListMembers: Statement;
  private readonly sLeaveMember: Statement;

  constructor(db: Database, config: TeamStoreConfig = {}) {
    this.fsBlackboard = config.fsBlackboard;
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
  }

  private requireFs(): TeamBlackboardFs {
    if (!this.fsBlackboard) {
      throw new Error(
        'team-store: fsBlackboard not wired — team blackboard requires a workspace after migration 040. ' +
          'Pass `fsBlackboard` to TeamStore or `workspace` to buildEcosystem.',
      );
    }
    return this.fsBlackboard;
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

  // ── Blackboard (filesystem-only after migration 040) ─────────────

  writeBlackboard(params: {
    teamId: string;
    key: string;
    value: unknown;
    authorId: string;
    updatedAt: number;
  }): number {
    const entry = this.requireFs().write({
      teamId: params.teamId,
      key: params.key,
      value: params.value,
      authorId: params.authorId,
      updatedAt: params.updatedAt,
    });
    return entry.version;
  }

  readBlackboard(teamId: string, key: string): TeamBlackboardEntry | null {
    const entry = this.requireFs().read(teamId, key);
    if (!entry) return null;
    return {
      teamId: entry.teamId,
      key: entry.key,
      version: entry.version,
      value: entry.value,
      authorId: entry.authorId,
      updatedAt: entry.updatedAt,
    };
  }

  listBlackboardKeys(teamId: string): readonly string[] {
    return this.requireFs().listKeys(teamId);
  }

  deleteBlackboardKey(teamId: string, key: string): number {
    return this.requireFs().delete(teamId, key);
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

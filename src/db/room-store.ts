/**
 * RoomStore — SQLite persistence for Agent Conversation Room lifecycle.
 *
 * Uses migration 016 tables: room_sessions, room_participants, room_ledger,
 * room_blackboard. Prepared statements cached in constructor (TraceStore
 * pattern). JSON-encoded complex fields.
 *
 * Crash-safety invariant: every insert MUST complete BEFORE the corresponding
 * bus event is emitted. The RoomDispatcher calls `roomStore.insertX()` first,
 * then `bus.emit(...)` — so a crash between the two leaves the DB consistent
 * and the in-memory state can be reconstructed from the DB on reload.
 *
 * R2: persistence hardening. R0/R1 ran rooms entirely in-memory.
 */
import type { Database, Statement } from 'bun:sqlite';
import type { LedgerEntry } from '../orchestrator/room/types.ts';

export interface RoomSessionRow {
  id: string;
  parent_task_id: string;
  contract_json: string;
  status: string;
  rounds_used: number;
  tokens_consumed: number;
  created_at: number;
  closed_at: number | null;
}

export interface RoomParticipantRow {
  id: string;
  room_id: string;
  role_name: string;
  worker_id: string;
  worker_model_id: string;
  turns_used: number;
  tokens_used: number;
  status: string;
  admitted_at: number;
}

export interface RoomLedgerRow {
  room_id: string;
  seq: number;
  timestamp: number;
  author_participant_id: string;
  author_role: string;
  entry_type: string;
  content_hash: string;
  prev_hash: string;
  payload_json: string;
}

export interface RoomBlackboardRow {
  room_id: string;
  key: string;
  version: number;
  value_json: string;
  author_role: string;
  updated_at: number;
}

export class RoomStore {
  private readonly db: Database;
  private readonly insertSessionStmt: Statement;
  private readonly updateSessionStatusStmt: Statement;
  private readonly updateSessionTokensStmt: Statement;
  private readonly insertParticipantStmt: Statement;
  private readonly updateParticipantStmt: Statement;
  private readonly insertLedgerStmt: Statement;
  private readonly insertBlackboardStmt: Statement;

  constructor(db: Database) {
    this.db = db;
    this.insertSessionStmt = db.prepare(`
      INSERT OR IGNORE INTO room_sessions
        (id, parent_task_id, contract_json, status, rounds_used, tokens_consumed, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateSessionStatusStmt = db.prepare(`
      UPDATE room_sessions SET status = ?, rounds_used = ?, tokens_consumed = ?, closed_at = ? WHERE id = ?
    `);
    this.updateSessionTokensStmt = db.prepare(`
      UPDATE room_sessions SET tokens_consumed = ?, rounds_used = ? WHERE id = ?
    `);
    this.insertParticipantStmt = db.prepare(`
      INSERT OR IGNORE INTO room_participants
        (id, room_id, role_name, worker_id, worker_model_id, turns_used, tokens_used, status, admitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateParticipantStmt = db.prepare(`
      UPDATE room_participants SET turns_used = ?, tokens_used = ?, status = ? WHERE id = ?
    `);
    this.insertLedgerStmt = db.prepare(`
      INSERT INTO room_ledger
        (room_id, seq, timestamp, author_participant_id, author_role, entry_type, content_hash, prev_hash, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertBlackboardStmt = db.prepare(`
      INSERT OR REPLACE INTO room_blackboard
        (room_id, key, version, value_json, author_role, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  insertSession(
    roomId: string,
    parentTaskId: string,
    contractJson: string,
    status: string,
    createdAt: number,
  ): void {
    this.insertSessionStmt.run(roomId, parentTaskId, contractJson, status, 0, 0, createdAt, null);
  }

  updateSessionStatus(
    roomId: string,
    status: string,
    roundsUsed: number,
    tokensConsumed: number,
    closedAt: number | null,
  ): void {
    this.updateSessionStatusStmt.run(status, roundsUsed, tokensConsumed, closedAt, roomId);
  }

  updateSessionTokens(roomId: string, tokensConsumed: number, roundsUsed: number): void {
    this.updateSessionTokensStmt.run(tokensConsumed, roundsUsed, roomId);
  }

  insertParticipant(
    id: string,
    roomId: string,
    roleName: string,
    workerId: string,
    workerModelId: string,
    status: string,
    admittedAt: number,
  ): void {
    this.insertParticipantStmt.run(id, roomId, roleName, workerId, workerModelId, 0, 0, status, admittedAt);
  }

  updateParticipant(id: string, turnsUsed: number, tokensUsed: number, status: string): void {
    this.updateParticipantStmt.run(turnsUsed, tokensUsed, status, id);
  }

  insertLedgerEntry(roomId: string, entry: LedgerEntry): void {
    this.insertLedgerStmt.run(
      roomId,
      entry.seq,
      entry.timestamp,
      entry.author,
      entry.authorRole,
      entry.type,
      entry.contentHash,
      entry.prevHash,
      JSON.stringify(entry.payload),
    );
  }

  insertBlackboardEntry(
    roomId: string,
    key: string,
    version: number,
    valueJson: string,
    authorRole: string,
    updatedAt: number,
  ): void {
    this.insertBlackboardStmt.run(roomId, key, version, valueJson, authorRole, updatedAt);
  }

  // ── Queries ───────────────────────────────────────────────────────

  findSessionByParentTask(parentTaskId: string): RoomSessionRow | null {
    return (this.db.query('SELECT * FROM room_sessions WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT 1').get(parentTaskId) as RoomSessionRow | null);
  }

  findSessionById(roomId: string): RoomSessionRow | null {
    return (this.db.query('SELECT * FROM room_sessions WHERE id = ?').get(roomId) as RoomSessionRow | null);
  }

  findLedgerByRoom(roomId: string): RoomLedgerRow[] {
    return this.db.query('SELECT * FROM room_ledger WHERE room_id = ? ORDER BY seq').all(roomId) as RoomLedgerRow[];
  }

  findParticipantsByRoom(roomId: string): RoomParticipantRow[] {
    return this.db.query('SELECT * FROM room_participants WHERE room_id = ? ORDER BY admitted_at').all(roomId) as RoomParticipantRow[];
  }

  findBlackboardByRoom(roomId: string): RoomBlackboardRow[] {
    return this.db.query('SELECT * FROM room_blackboard WHERE room_id = ? ORDER BY key, version').all(roomId) as RoomBlackboardRow[];
  }
}

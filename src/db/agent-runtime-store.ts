/**
 * AgentRuntimeStore — SQLite persistence for the runtime-state FSM.
 *
 * Paired with `src/orchestrator/ecosystem/runtime-state.ts`, which owns the
 * FSM rules. This module only encapsulates row shape + transactional writes.
 *
 * Schema from migration 031. Transitions and row updates are done in a single
 * transaction so the audit log never drifts from the current state.
 */

import type { Database, Statement } from 'bun:sqlite';
import type { AgentRuntimeSnapshot, RuntimeState } from '../orchestrator/ecosystem/runtime-state.ts';

interface RuntimeRow {
  agent_id: string;
  state: RuntimeState;
  active_task_count: number;
  capacity_max: number;
  last_transition_at: number;
  last_transition_reason: string | null;
  last_heartbeat_at: number;
}

export interface InsertParams {
  agentId: string;
  state: RuntimeState;
  activeTaskCount: number;
  capacityMax: number;
  lastTransitionAt: number;
  lastTransitionReason: string;
  lastHeartbeatAt: number;
}

export interface ApplyTransitionParams {
  agentId: string;
  fromState: RuntimeState;
  toState: RuntimeState;
  reason: string;
  taskId?: string;
  at: number;
  /** Increment (+1 / -1) to apply to active_task_count. 0 = no change. */
  activeTaskCountDelta: number;
  /** When true, active_task_count is set to max(0, count + delta). */
  resetActiveTaskCount?: boolean;
}

export class AgentRuntimeStore {
  private readonly db: Database;
  private readonly sGet: Statement;
  private readonly sInsert: Statement;
  private readonly sListByState: Statement;
  private readonly sUpdateHeartbeat: Statement;
  private readonly sApplyTxn: (p: ApplyTransitionParams) => void;

  constructor(db: Database) {
    this.db = db;
    this.sGet = db.prepare('SELECT * FROM agent_runtime WHERE agent_id = ?');
    this.sInsert = db.prepare(`
      INSERT INTO agent_runtime
        (agent_id, state, active_task_count, capacity_max,
         last_transition_at, last_transition_reason, last_heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.sListByState = db.prepare(
      'SELECT * FROM agent_runtime WHERE state = ? ORDER BY agent_id',
    );
    this.sUpdateHeartbeat = db.prepare(
      'UPDATE agent_runtime SET last_heartbeat_at = ? WHERE agent_id = ?',
    );

    const sUpdate = db.prepare(`
      UPDATE agent_runtime
         SET state = ?,
             active_task_count = MAX(0, active_task_count + ?),
             last_transition_at = ?,
             last_transition_reason = ?,
             last_heartbeat_at = ?
       WHERE agent_id = ?
    `);
    const sUpdateReset = db.prepare(`
      UPDATE agent_runtime
         SET state = ?,
             active_task_count = 0,
             last_transition_at = ?,
             last_transition_reason = ?,
             last_heartbeat_at = ?
       WHERE agent_id = ?
    `);
    const sLog = db.prepare(`
      INSERT INTO agent_runtime_transitions
        (agent_id, from_state, to_state, reason, task_id, at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // bun:sqlite transaction factory: returns a callable that runs the body
    // atomically. Keeps row update + log append together.
    this.sApplyTxn = db.transaction((p: ApplyTransitionParams) => {
      if (p.resetActiveTaskCount) {
        sUpdateReset.run(p.toState, p.at, p.reason, p.at, p.agentId);
      } else {
        sUpdate.run(
          p.toState,
          p.activeTaskCountDelta,
          p.at,
          p.reason,
          p.at,
          p.agentId,
        );
      }
      sLog.run(
        p.agentId,
        p.fromState,
        p.toState,
        p.reason,
        p.taskId ?? null,
        p.at,
      );
    }) as (p: ApplyTransitionParams) => void;
  }

  // ── Reads ────────────────────────────────────────────────────────

  get(agentId: string): AgentRuntimeSnapshot | null {
    const row = this.sGet.get(agentId) as RuntimeRow | null;
    return row ? this.rowToSnapshot(row) : null;
  }

  listByState(state: RuntimeState): readonly AgentRuntimeSnapshot[] {
    const rows = this.sListByState.all(state) as RuntimeRow[];
    return rows.map((r) => this.rowToSnapshot(r));
  }

  // ── Writes ───────────────────────────────────────────────────────

  insert(params: InsertParams): void {
    this.sInsert.run(
      params.agentId,
      params.state,
      params.activeTaskCount,
      params.capacityMax,
      params.lastTransitionAt,
      params.lastTransitionReason,
      params.lastHeartbeatAt,
    );
  }

  updateHeartbeat(agentId: string, at: number): void {
    this.sUpdateHeartbeat.run(at, agentId);
  }

  applyTransition(params: ApplyTransitionParams): void {
    this.sApplyTxn(params);
  }

  /** Count transitions for a given agent (used by tests/diagnostics). */
  countTransitions(agentId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as n FROM agent_runtime_transitions WHERE agent_id = ?')
      .get(agentId) as { n: number };
    return row.n;
  }

  // ── Mapping ──────────────────────────────────────────────────────

  private rowToSnapshot(row: RuntimeRow): AgentRuntimeSnapshot {
    return {
      agentId: row.agent_id,
      state: row.state,
      activeTaskCount: row.active_task_count,
      capacityMax: row.capacity_max,
      lastTransitionAt: row.last_transition_at,
      lastTransitionReason: row.last_transition_reason,
      lastHeartbeatAt: row.last_heartbeat_at,
    };
  }
}

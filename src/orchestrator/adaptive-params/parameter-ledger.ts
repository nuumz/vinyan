/**
 * Adaptive Parameter Ledger — append-only history of parameter tuning.
 *
 * Every mutation to an adaptive parameter (default → tuned, tuned → tuned,
 * tuned → reverted-to-default) lands here. The store reads the most
 * recent row per `param_name` to determine "current value".
 *
 * Backed by `parameter_adaptations` table (migration 030).
 */
import type { Database, Statement } from 'bun:sqlite';

export interface ParameterAdaptationInput {
  readonly paramName: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly reason: string;
  readonly ownerModule: string;
}

export interface ParameterAdaptationRecord {
  readonly id: number;
  readonly ts: number;
  readonly paramName: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly reason: string;
  readonly ownerModule: string;
  readonly ledgerVersion: number;
}

interface Row {
  id: number;
  ts: number;
  param_name: string;
  old_value: string;
  new_value: string;
  reason: string;
  owner_module: string;
  ledger_version: number;
}

export class ParameterLedger {
  private readonly insertStmt: Statement;
  private readonly latestStmt: Statement;
  private readonly historyStmt: Statement;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    opts?: { clock?: () => number },
  ) {
    this.clock = opts?.clock ?? Date.now;
    this.insertStmt = db.prepare(
      `INSERT INTO parameter_adaptations
         (ts, param_name, old_value, new_value, reason, owner_module)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.latestStmt = db.prepare(
      `SELECT * FROM parameter_adaptations
        WHERE param_name = ?
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
    );
    this.historyStmt = db.prepare(
      `SELECT * FROM parameter_adaptations
        WHERE param_name = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
    );
  }

  /** Append a new adaptation row. Returns the inserted record. */
  append(input: ParameterAdaptationInput): ParameterAdaptationRecord {
    const ts = this.clock();
    const result = this.insertStmt.run(
      ts,
      input.paramName,
      JSON.stringify(input.oldValue),
      JSON.stringify(input.newValue),
      input.reason,
      input.ownerModule,
    );
    return {
      id: Number(result.lastInsertRowid),
      ts,
      paramName: input.paramName,
      oldValue: input.oldValue,
      newValue: input.newValue,
      reason: input.reason,
      ownerModule: input.ownerModule,
      ledgerVersion: 1,
    };
  }

  /**
   * Most recent adaptation for a param. Returns `null` when no row exists
   * — caller falls back to the registry default.
   */
  latest(paramName: string): ParameterAdaptationRecord | null {
    const row = this.latestStmt.get(paramName) as Row | undefined;
    return row ? rowToRecord(row) : null;
  }

  history(paramName: string, limit = 50): readonly ParameterAdaptationRecord[] {
    const rows = this.historyStmt.all(paramName, limit) as Row[];
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: Row): ParameterAdaptationRecord {
  return {
    id: row.id,
    ts: row.ts,
    paramName: row.param_name,
    oldValue: safeJsonParse(row.old_value),
    newValue: safeJsonParse(row.new_value),
    reason: row.reason,
    ownerModule: row.owner_module,
    ledgerVersion: row.ledger_version,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

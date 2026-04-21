/**
 * PluginAuditStore — writer + reader for `plugin_audit` (migration 007).
 *
 * The Plugin Registry (`src/plugin/registry.ts`) records every state
 * transition through this store so the governance decision log is
 * replayable (A3: deterministic governance).
 *
 * Profile scoping (w1-contracts §3): every read method requires either an
 * explicit profile filter or the explicit `'ALL'` sentinel. Cross-profile
 * reads without the sentinel are refused to prevent accidental leaks.
 */
import type { Database } from 'bun:sqlite';
import type { ConfidenceTier } from '../core/confidence-tier.ts';
import type { PluginCategory } from '../plugin/manifest.ts';
import type { PluginAuditEvent, PluginAuditRecord, PluginState } from '../plugin/types.ts';

interface PluginAuditRow {
  audit_id: number;
  profile: string;
  plugin_id: string;
  plugin_version: string;
  category: string;
  event: string;
  tier: string | null;
  from_state: string | null;
  to_state: string | null;
  detail_json: string | null;
  created_at: number;
}

export interface PluginAuditQuery {
  /** Profile to filter on. Pass `'ALL'` to disable the filter (logged-cross-read). */
  profile: string;
  limit?: number;
}

export class PluginAuditStore {
  constructor(private readonly db: Database) {}

  record(record: PluginAuditRecord): void {
    this.db
      .prepare(
        `INSERT INTO plugin_audit
          (profile, plugin_id, plugin_version, category, event, tier,
           from_state, to_state, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.profile,
        record.pluginId,
        record.pluginVersion,
        record.category,
        record.event,
        record.tier ?? null,
        record.fromState ?? null,
        record.toState ?? null,
        record.detail ? JSON.stringify(record.detail) : null,
        record.createdAt,
      );
  }

  /** Per-plugin history (oldest first). Profile-scoped. */
  history(pluginId: string, opts: PluginAuditQuery): PluginAuditRecord[] {
    const limit = opts.limit ?? 100;
    const rows =
      opts.profile === 'ALL'
        ? (this.db
            .prepare(`SELECT * FROM plugin_audit WHERE plugin_id = ? ORDER BY created_at ASC, audit_id ASC LIMIT ?`)
            .all(pluginId, limit) as PluginAuditRow[])
        : (this.db
            .prepare(
              `SELECT * FROM plugin_audit
                 WHERE plugin_id = ? AND profile = ?
                 ORDER BY created_at ASC, audit_id ASC LIMIT ?`,
            )
            .all(pluginId, opts.profile, limit) as PluginAuditRow[]);
    return rows.map(rowToRecord);
  }

  /** Most-recent event for a plugin. Profile-scoped. */
  latest(pluginId: string, opts: PluginAuditQuery): PluginAuditRecord | null {
    const row =
      opts.profile === 'ALL'
        ? (this.db
            .prepare(`SELECT * FROM plugin_audit WHERE plugin_id = ? ORDER BY created_at DESC, audit_id DESC LIMIT 1`)
            .get(pluginId) as PluginAuditRow | null)
        : (this.db
            .prepare(
              `SELECT * FROM plugin_audit
                 WHERE plugin_id = ? AND profile = ?
                 ORDER BY created_at DESC, audit_id DESC LIMIT 1`,
            )
            .get(pluginId, opts.profile) as PluginAuditRow | null);
    return row ? rowToRecord(row) : null;
  }
}

function rowToRecord(row: PluginAuditRow): PluginAuditRecord {
  return {
    profile: row.profile,
    pluginId: row.plugin_id,
    pluginVersion: row.plugin_version,
    category: row.category as PluginCategory,
    event: row.event as PluginAuditEvent,
    tier: (row.tier ?? undefined) as ConfidenceTier | undefined,
    fromState: (row.from_state ?? undefined) as PluginState | undefined,
    toState: (row.to_state ?? undefined) as PluginState | undefined,
    detail: row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
  };
}

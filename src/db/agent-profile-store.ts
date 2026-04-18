/**
 * AgentProfileStore — per-agent profile persistence.
 *
 * Phase 1 shipped this as a singleton (`id = 'local'`). Phase 2 (migration 026)
 * relaxed the CHECK constraint; the table now holds one row per agent:
 *   - The workspace "host" (role='host', id='local') — preserved for backward compat.
 *   - Each specialist registered via vinyan.json or CLI (role='specialist').
 *
 * Aggregate counters are still computed on-demand from other stores with 60s cache.
 *
 * Source of truth: AgentProfile ultraplan + Phase 2 multi-agent plan.
 */
import type { Database } from 'bun:sqlite';
import type {
  AgentPreferences,
  AgentProfile,
  AgentProfileSummary,
} from '../orchestrator/types.ts';
import { DEFAULT_AGENT_PREFERENCES } from '../orchestrator/types.ts';
import { AgentProfileRowSchema } from './schemas.ts';

/** ID of the workspace host agent (unchanged for backward compat). */
export const HOST_AGENT_ID = 'local';

/**
 * Parameters for initial agent bootstrap. Called for each agent the first time
 * it's encountered. Idempotent (INSERT OR IGNORE semantics in loadOrCreate).
 */
export interface LoadOrCreateParams {
  /** Agent id (defaults to HOST_AGENT_ID = 'local' for backward compat). */
  id?: string;
  /** Workspace-level A2A instance UUID (from `.vinyan/instance-id`). */
  instanceId: string;
  /** Absolute workspace path. */
  workspace: string;
  /** Optional override from `vinyan.json` (overrides default 'vinyan'). */
  displayNameOverride?: string;
  /** Optional tagline from config. */
  descriptionOverride?: string;
  /** VINYAN.md path if present. */
  vinyanMdPath?: string;
  /** SHA-256 of VINYAN.md content. */
  vinyanMdHash?: string;
  /** Phase 2: role classification ('host' | 'specialist' | 'custom'). */
  role?: string;
  /** Phase 2: comma-separated specialization tags. */
  specialization?: string;
  /** Phase 2: short one-line persona summary (full soul is on filesystem). */
  persona?: string;
}

/** Deps for on-demand summarize() — all optional (stores may be unavailable). */
export interface SummarizeDeps {
  traceStore?: {
    count(): number;
    countDistinctTaskTypes(): number;
    findRecent?(limit: number): Array<{ outcome: string; timestamp: number }>;
  };
  skillStore?: { countActive(): number };
  workerStore?: { countActive(): number };
  patternStore?: { countCycleRuns(): number };
  db?: Database;
}

export class AgentProfileStore {
  private db: Database;
  private summaryCache: { summary: AgentProfileSummary; expiresAt: number } | null = null;
  private readonly cacheTTL = 60_000; // 60s

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Load the agent profile, creating it with defaults if absent.
   * Idempotent: safe to call on every factory bootstrap.
   *
   * When `params.id` is omitted, operates on the workspace host (id='local').
   * When provided, operates on that specific agent — callers use this to
   * register specialists from vinyan.json `agents[]`.
   */
  loadOrCreate(params: LoadOrCreateParams): AgentProfile {
    const id = params.id ?? HOST_AGENT_ID;
    const existing = this.get(id);
    if (existing) return existing;

    const now = Date.now();
    const prefs = { ...DEFAULT_AGENT_PREFERENCES };

    this.db
      .prepare(
        `INSERT INTO agent_profile
         (id, instance_id, display_name, description, workspace_path,
          created_at, updated_at, preferences_json, capabilities_json,
          vinyan_md_path, vinyan_md_hash, role, specialization, persona)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.instanceId,
        params.displayNameOverride ?? 'vinyan',
        params.descriptionOverride ?? null,
        params.workspace,
        now,
        now,
        JSON.stringify(prefs),
        '[]',
        params.vinyanMdPath ?? null,
        params.vinyanMdHash ?? null,
        params.role ?? (id === HOST_AGENT_ID ? 'host' : 'specialist'),
        params.specialization ?? null,
        params.persona ?? null,
      );

    return this.get(id)!;
  }

  /** Read an agent profile by id. Defaults to workspace host. */
  get(id: string = HOST_AGENT_ID): AgentProfile | null {
    const row = this.db.prepare(`SELECT * FROM agent_profile WHERE id = ?`).get(id);
    if (!row) return null;
    return rowToProfile(row);
  }

  /** List all agent profiles (host + specialists). Phase 2 multi-agent query. */
  findAll(): AgentProfile[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_profile ORDER BY role, id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => rowToProfile(r)).filter((p): p is AgentProfile => p !== null);
  }

  /**
   * Merge preference updates with existing values and bump updated_at.
   * Config-first precedence: factory calls this on every boot with
   * preferences from `vinyan.json` to keep DB in sync.
   *
   * Defaults to the workspace host when `id` omitted.
   */
  updatePreferences(partial: Partial<AgentPreferences>, id: string = HOST_AGENT_ID): void {
    const current = this.get(id);
    if (!current) return;
    const merged: AgentPreferences = { ...current.preferences, ...partial };
    this.db
      .prepare(
        `UPDATE agent_profile SET preferences_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(merged), Date.now(), id);
    this.summaryCache = null;
  }

  /** Replace the declared capabilities list (idempotent; runs on every boot). */
  updateCapabilities(capabilities: string[], id: string = HOST_AGENT_ID): void {
    const unique = Array.from(new Set(capabilities)).sort();
    this.db
      .prepare(
        `UPDATE agent_profile SET capabilities_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(unique), Date.now(), id);
  }

  /** Update VINYAN.md link + hash (called on every boot to track freshness). */
  updateVinyanMdLink(path: string | null, hash: string | null, id: string = HOST_AGENT_ID): void {
    this.db
      .prepare(
        `UPDATE agent_profile SET vinyan_md_path = ?, vinyan_md_hash = ?, updated_at = ? WHERE id = ?`,
      )
      .run(path, hash, Date.now(), id);
  }

  /** Phase 2: update role/specialization/persona columns. */
  updateRoleColumns(
    id: string,
    fields: { role?: string | null; specialization?: string | null; persona?: string | null },
  ): void {
    const parts: string[] = [];
    const values: Array<string | number | null> = [];
    if (fields.role !== undefined) {
      parts.push('role = ?');
      values.push(fields.role);
    }
    if (fields.specialization !== undefined) {
      parts.push('specialization = ?');
      values.push(fields.specialization);
    }
    if (fields.persona !== undefined) {
      parts.push('persona = ?');
      values.push(fields.persona);
    }
    if (parts.length === 0) return;
    parts.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    this.db.prepare(`UPDATE agent_profile SET ${parts.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Compute aggregate counters for THE Vinyan Agent from other stores.
   * Cached 60s in-memory (matches WorkerStore.getStats pattern).
   */
  summarize(deps: SummarizeDeps): AgentProfileSummary {
    if (this.summaryCache && this.summaryCache.expiresAt > Date.now()) {
      return this.summaryCache.summary;
    }

    const totalTasks = deps.traceStore?.count() ?? 0;
    const distinctTaskTypes = deps.traceStore?.countDistinctTaskTypes() ?? 0;

    // successRate from the most recent 100 traces if available (rolling signal)
    let successRate = 0;
    let lastActiveAt = 0;
    if (deps.traceStore?.findRecent) {
      const recent = deps.traceStore.findRecent(100);
      if (recent.length > 0) {
        const successes = recent.filter((t) => t.outcome === 'success').length;
        successRate = successes / recent.length;
        lastActiveAt = Math.max(...recent.map((t) => t.timestamp));
      }
    }

    const lastSleepCycleAt = deps.db
      ? (() => {
          try {
            const row = deps.db!
              .prepare(`SELECT MAX(started_at) as t FROM sleep_cycle_runs`)
              .get() as { t: number | null } | null;
            return row?.t ?? 0;
          } catch {
            return 0;
          }
        })()
      : 0;

    const summary: AgentProfileSummary = {
      totalTasks,
      distinctTaskTypes,
      successRate,
      activeSkills: deps.skillStore?.countActive() ?? 0,
      activeWorkers: deps.workerStore?.countActive() ?? 0,
      sleepCyclesRun: deps.patternStore?.countCycleRuns() ?? 0,
      lastActiveAt,
      lastSleepCycleAt,
    };

    this.summaryCache = { summary, expiresAt: Date.now() + this.cacheTTL };
    return summary;
  }

  /** Invalidate the summary cache (for testing or forced refresh). */
  invalidateCache(): void {
    this.summaryCache = null;
  }
}

function rowToProfile(raw: unknown): AgentProfile {
  const row = raw as Record<string, unknown>;
  const parsed = AgentProfileRowSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[AgentProfileStore] Invalid row shape, falling back to defaults:', parsed.error.issues);
    return {
      id: String(row.id ?? HOST_AGENT_ID),
      instanceId: String(row.instance_id ?? ''),
      displayName: String(row.display_name ?? 'vinyan'),
      workspacePath: String(row.workspace_path ?? ''),
      createdAt: Number(row.created_at ?? Date.now()),
      updatedAt: Number(row.updated_at ?? Date.now()),
      preferences: { ...DEFAULT_AGENT_PREFERENCES },
      capabilities: [],
    };
  }

  const r = parsed.data;
  const prefRaw = r.preferences_json as Record<string, unknown>;
  const preferences: AgentPreferences = {
    approvalMode:
      (prefRaw.approvalMode as AgentPreferences['approvalMode']) ??
      DEFAULT_AGENT_PREFERENCES.approvalMode,
    verbosity:
      (prefRaw.verbosity as AgentPreferences['verbosity']) ?? DEFAULT_AGENT_PREFERENCES.verbosity,
    defaultThinkingLevel:
      (prefRaw.defaultThinkingLevel as AgentPreferences['defaultThinkingLevel']) ??
      DEFAULT_AGENT_PREFERENCES.defaultThinkingLevel,
    language:
      (prefRaw.language as AgentPreferences['language']) ?? DEFAULT_AGENT_PREFERENCES.language,
  };

  return {
    id: r.id,
    instanceId: r.instance_id,
    displayName: r.display_name,
    description: r.description ?? undefined,
    workspacePath: r.workspace_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    preferences,
    capabilities: r.capabilities_json,
    vinyanMdPath: r.vinyan_md_path ?? undefined,
    vinyanMdHash: r.vinyan_md_hash ?? undefined,
    // Phase 2: extended metadata (gracefully NULL for pre-migration rows)
    role: (row.role as string | null) ?? undefined,
    specialization: (row.specialization as string | null) ?? undefined,
    persona: (row.persona as string | null) ?? undefined,
  };
}

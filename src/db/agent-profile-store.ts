/**
 * AgentProfileStore — workspace-level singleton persistence for THE Vinyan Agent.
 *
 * CRUD for the `agent_profile` table (one row with `id = 'local'`).
 * Aggregate counters are computed on-demand from other stores with 60s cache,
 * matching the pattern of WorkerStore.getStats().
 *
 * Source of truth: AgentProfile ultraplan (docs/plans, approved).
 */
import type { Database } from 'bun:sqlite';
import type {
  AgentPreferences,
  AgentProfile,
  AgentProfileSummary,
} from '../orchestrator/types.ts';
import { DEFAULT_AGENT_PREFERENCES } from '../orchestrator/types.ts';
import { AgentProfileRowSchema } from './schemas.ts';

/**
 * Parameters for initial agent bootstrap. Called exactly once per workspace
 * (first run); subsequent calls no-op via INSERT OR IGNORE.
 */
export interface LoadOrCreateParams {
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
   */
  loadOrCreate(params: LoadOrCreateParams): AgentProfile {
    const existing = this.get();
    if (existing) return existing;

    const now = Date.now();
    const prefs = { ...DEFAULT_AGENT_PREFERENCES };

    this.db
      .prepare(
        `INSERT INTO agent_profile
         (id, instance_id, display_name, description, workspace_path,
          created_at, updated_at, preferences_json, capabilities_json,
          vinyan_md_path, vinyan_md_hash)
         VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );

    return this.get()!;
  }

  /** Read the singleton profile. Returns null only if not yet bootstrapped. */
  get(): AgentProfile | null {
    const row = this.db.prepare(`SELECT * FROM agent_profile WHERE id = 'local'`).get();
    if (!row) return null;
    return rowToProfile(row);
  }

  /**
   * Merge preference updates with existing values and bump updated_at.
   * Config-first precedence: factory calls this on every boot with
   * preferences from `vinyan.json` to keep DB in sync.
   */
  updatePreferences(partial: Partial<AgentPreferences>): void {
    const current = this.get();
    if (!current) return;
    const merged: AgentPreferences = { ...current.preferences, ...partial };
    this.db
      .prepare(
        `UPDATE agent_profile SET preferences_json = ?, updated_at = ? WHERE id = 'local'`,
      )
      .run(JSON.stringify(merged), Date.now());
    this.summaryCache = null;
  }

  /** Replace the declared capabilities list (idempotent; runs on every boot). */
  updateCapabilities(capabilities: string[]): void {
    const unique = Array.from(new Set(capabilities)).sort();
    this.db
      .prepare(
        `UPDATE agent_profile SET capabilities_json = ?, updated_at = ? WHERE id = 'local'`,
      )
      .run(JSON.stringify(unique), Date.now());
  }

  /** Update VINYAN.md link + hash (called on every boot to track freshness). */
  updateVinyanMdLink(path: string | null, hash: string | null): void {
    this.db
      .prepare(
        `UPDATE agent_profile SET vinyan_md_path = ?, vinyan_md_hash = ?, updated_at = ? WHERE id = 'local'`,
      )
      .run(path, hash, Date.now());
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
  const parsed = AgentProfileRowSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[AgentProfileStore] Invalid row shape, falling back to defaults:', parsed.error.issues);
    // Best-effort fallback so a corrupt row doesn't break bootstrap
    const row = raw as Record<string, unknown>;
    return {
      id: 'local',
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
    id: 'local',
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
  };
}

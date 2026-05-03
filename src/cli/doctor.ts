/**
 * vinyan doctor — workspace health check.
 *
 * Validates: config, database, migrations, oracles, LLM providers,
 * provider cooldowns, economy, sessions, scheduler, recorder, memory,
 * skills, profile isolation. Reports issues with actionable fix
 * suggestions.
 *
 * The check loop is exposed as `runDoctorChecks()` so the HTTP API can
 * reuse the same logic. The CLI entry point (`runDoctor`) wraps it with
 * console rendering and an exit code.
 *
 * Hermes lesson: doctor must distinguish "missing optional subsystem
 * (warn — capability degraded)" from "missing required subsystem
 * (fail — install / migrate first)". Secrets are NEVER printed —
 * presence-only signals.
 */

import { existsSync } from 'fs';
import { join } from 'path';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** Hint the operator can act on. Optional — short remediation only. */
  remediation?: string;
}

export interface DoctorOptions {
  /**
   * Reserved flag for future expensive probes. Currently a no-op — the
   * type-check probe was removed (project is Bun-first; `bun run check`
   * is the canonical type-check path, the doctor's purpose is workspace
   * runtime health).
   */
  deep?: boolean;
  /**
   * Optional runtime probes injected by the HTTP handler so doctor can
   * report on live state (provider cooldowns, recorder presence,
   * scheduler health) without re-importing the whole orchestrator.
   * Each is best-effort: missing → warn, present → check.
   */
  runtime?: {
    /** Provider health snapshot — `null` when no provider is in cooldown. */
    providerCooldowns?: () => ReadonlyArray<{
      providerId: string;
      cooldownUntil: number;
      reason: string;
    }>;
    /** True when `taskEventStore` is wired into the API server. */
    recorderActive?: boolean;
    /** True when `gatewayScheduleStore` is wired (durable scheduler). */
    schedulerActive?: boolean;
    /** Count of active scheduled jobs. Caller computes profile-scoped count. */
    activeScheduleCount?: number;
    /** True when `simpleSkillRegistry` or `skillArtifactStore` is wired. */
    skillsActive?: boolean;
    /**
     * Memory-wiki wiring + vault state. Replaces the older boolean
     * `memoryWikiActive`. Doctor merges this with the inline DB-count
     * read so the operator sees one row covering: wiring (routes
     * available?), vault scaffold (markdown projection on disk), and
     * content (pages/sources/findings).
     *
     * `wired=false` → warn (routes return 503). `wired=true` with zero
     * pages is still `ok` — empty wiki on a fresh install is valid.
     */
    memoryWikiActive?: boolean;
    /**
     * JSONL-side session storage probe. Caller (HTTP server) walks the
     * profile-resolved sessions dir and counts sessions that have an
     * `events.jsonl` log. Used to surface drift vs SQLite when the
     * hybrid storage modes are active. CLI invocations skip this and
     * the doctor reports "jsonl=not-introspected" in that case.
     */
    jsonlSessions?: () => {
      readonly sessionsDir: string;
      readonly sessionCount: number;
    } | null;
    /** Total in-flight tasks (zero is healthy). */
    inFlightTaskCount?: number;
    /** Number of orphaned tasks recovered at startup (large = degraded). */
    recoveredOrphanCount?: number;
    /**
     * Autogen policy snapshot — current threshold + signals + ledger
     * tail. Surfaced as a single check entry so an operator sees both
     * the live threshold and the queue signals that drove it.
     */
    autogenPolicy?: () => {
      readonly threshold: number;
      readonly enabled: boolean;
      readonly explanation: string;
      readonly pendingCount: number;
      readonly recentChanges: number;
    } | null;
    /**
     * Autogen tracker state — total durable rows, oldest carryover,
     * cooldown count. R3 visibility so the operator can see whether
     * the persistent tracker is healthy.
     */
    autogenTrackerState?: () => {
      readonly rows: number;
      readonly cooldownActive: number;
      readonly oldestSeen: number | null;
      readonly bootId: string | null;
    } | null;
  };
}

/**
 * Run all workspace health checks and return the structured result.
 * Never prints; never exits. Safe to call from HTTP handlers and tests.
 */
export async function runDoctorChecks(
  workspace: string,
  options: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Workspace
  checks.push(
    existsSync(workspace)
      ? { name: 'Workspace', status: 'ok', detail: workspace }
      : { name: 'Workspace', status: 'fail', detail: `Directory not found: ${workspace}` },
  );

  // 2. Config — lifted out of the try/catch scope so later checks
  // (Sessions storage mode in particular) can read `loadedConfig.session.*`.
  // `null` = config missing or invalid; downstream checks fall back to
  // safe defaults rather than crashing.
  const configPath = join(workspace, 'vinyan.json');
  let loadedConfig: import('../config/schema.ts').VinyanConfig | null = null;
  if (existsSync(configPath)) {
    try {
      const { loadConfig } = await import('../config/index.ts');
      loadedConfig = loadConfig(workspace);
      checks.push({ name: 'Config', status: 'ok', detail: `vinyan.json loaded` });

      // 2a. Oracles
      const oracles = loadedConfig.oracles ?? {};
      const enabledOracles = Object.entries(oracles).filter(([, v]) => (v as { enabled?: boolean })?.enabled);
      checks.push({
        name: 'Oracles',
        status: enabledOracles.length > 0 ? 'ok' : 'warn',
        detail: enabledOracles.length > 0
          ? `${enabledOracles.length} enabled: ${enabledOracles.map(([k]) => k).join(', ')}`
          : 'No oracles enabled — verification will be limited',
      });

      // 2b. Economy
      const econ = loadedConfig.economy;
      checks.push({
        name: 'Economy',
        status: econ?.enabled ? 'ok' : 'warn',
        detail: econ?.enabled
          ? `Enabled${econ.budgets ? ` — budgets: hourly=$${econ.budgets.hourly_usd}, daily=$${econ.budgets.daily_usd}` : ' — no budget limits'}`
          : 'Disabled — set economy.enabled: true in vinyan.json',
      });

      // 2c. Network/API
      const api = loadedConfig.network?.api;
      checks.push({
        name: 'API Server',
        status: api?.enabled !== false ? 'ok' : 'warn',
        detail: api?.enabled !== false ? `Port ${api?.port ?? 3927}` : 'Disabled',
      });
    } catch (err) {
      checks.push({ name: 'Config', status: 'fail', detail: `Invalid vinyan.json: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    checks.push({ name: 'Config', status: 'fail', detail: 'vinyan.json not found — run `vinyan init`' });
  }

  // 3. Database
  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      db.close();
      checks.push({ name: 'Database', status: 'ok', detail: `${tables.length} tables in vinyan.db` });
    } catch (err) {
      checks.push({ name: 'Database', status: 'fail', detail: `DB corrupt: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    checks.push({ name: 'Database', status: 'warn', detail: 'No database yet — will be created on first run' });
  }

  // 4. API Token
  const tokenPath = join(workspace, '.vinyan', 'api-token');
  checks.push(
    existsSync(tokenPath)
      ? { name: 'API Token', status: 'ok', detail: '.vinyan/api-token exists' }
      : { name: 'API Token', status: 'warn', detail: 'No API token — will be auto-generated on serve' },
  );

  // 5. LLM Provider (env vars)
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (hasOpenRouter || hasAnthropic) {
    const providers: string[] = [];
    if (hasOpenRouter) providers.push('OpenRouter');
    if (hasAnthropic) providers.push('Anthropic');
    checks.push({ name: 'LLM Provider', status: 'ok', detail: providers.join(' + ') });
  } else {
    checks.push({ name: 'LLM Provider', status: 'fail', detail: 'No OPENROUTER_API_KEY or ANTHROPIC_API_KEY — set in .env' });
  }

  // 6. Sessions — hybrid-aware. The architectural direction is per-
  // session JSONL as the source of truth with SQLite as a derived
  // index (`session.dualWrite.enabled`, `session.readFromJsonl.*`).
  // The doctor reports BOTH which mode is currently active and the
  // counts on each backing so an operator can spot drift. Reading
  // only `session_store` (older behaviour) hid the JSONL side and
  // misled when dualWrite was on.
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      // "active" / "suspended" mean LIVE in those lifecycle states —
      // archived sessions retain `status='active'` (the lifecycle column
      // tracks runtime state, archive is a visibility flag on its own
      // column). The earlier query missed `archived_at IS NULL`, so
      // archived sessions counted as active (verified live in L1).
      const active = db
        .query(
          "SELECT COUNT(*) as c FROM session_store WHERE status = 'active' AND deleted_at IS NULL AND archived_at IS NULL",
        )
        .get() as { c: number } | null;
      const suspended = db
        .query(
          "SELECT COUNT(*) as c FROM session_store WHERE status = 'suspended' AND deleted_at IS NULL AND archived_at IS NULL",
        )
        .get() as { c: number } | null;
      const archived = db
        .query('SELECT COUNT(*) as c FROM session_store WHERE archived_at IS NOT NULL AND deleted_at IS NULL')
        .get() as { c: number } | null;
      const total = db
        .query('SELECT COUNT(*) as c FROM session_store WHERE deleted_at IS NULL')
        .get() as { c: number } | null;
      db.close();

      const sessionCfg = loadedConfig?.session;
      const dualWrite = sessionCfg?.dualWrite?.enabled === true;
      const readJsonl = sessionCfg?.readFromJsonl
        ? Object.entries(sessionCfg.readFromJsonl).some(
            ([k, v]) => k !== 'fallbackToSqlite' && v === true,
          )
        : false;
      const mode: 'sqlite-only' | 'dual-write' | 'jsonl-primary' = readJsonl
        ? 'jsonl-primary'
        : dualWrite
          ? 'dual-write'
          : 'sqlite-only';

      const sqliteActive = active?.c ?? 0;
      const sqliteSuspended = suspended?.c ?? 0;
      const sqliteArchived = archived?.c ?? 0;
      const sqliteTotal = total?.c ?? 0;
      let detail = `mode=${mode} · sqlite=${sqliteActive} active, ${sqliteSuspended} suspended, ${sqliteArchived} archived`;
      let status: 'ok' | 'warn' = 'ok';
      let remediation: string | undefined;

      if (mode !== 'sqlite-only') {
        const jsonlProbe = options.runtime?.jsonlSessions?.();
        if (jsonlProbe) {
          const drift = Math.abs(jsonlProbe.sessionCount - sqliteTotal);
          detail += ` · jsonl=${jsonlProbe.sessionCount}`;
          if (drift > 0) {
            detail += ` · drift=${drift}`;
            status = 'warn';
            remediation =
              'Run the JSONL-vs-SQLite consistency rebuild (`session.dualWrite.verify=true`) or inspect the divergent sessions before relying on either side.';
          }
        } else {
          detail += ` · jsonl=not-introspected`;
        }
      }

      checks.push({
        name: 'Sessions',
        status,
        detail,
        ...(remediation ? { remediation } : {}),
      });
    } catch (err) {
      checks.push({
        name: 'Sessions',
        status: 'warn',
        detail: `cannot read session_store: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 7. Migrations — surface schema drift early so an old DB doesn't
  // silently miss FTS5 / scheduler / proposal tables. Compares the
  // applied version recorded in `schema_migrations` against the highest
  // version in `ALL_MIGRATIONS`.
  if (existsSync(dbPath)) {
    try {
      const { Database } = await import('bun:sqlite');
      const { ALL_MIGRATIONS } = await import('../db/migrations/index.ts');
      const db = new Database(dbPath, { readonly: true });
      const applied = db
        .query('SELECT MAX(version) as v FROM schema_version')
        .get() as { v: number | null } | null;
      db.close();
      const codeMax = Math.max(...ALL_MIGRATIONS.map((m) => m.version));
      const dbMax = applied?.v ?? 0;
      if (dbMax === codeMax) {
        checks.push({ name: 'Migrations', status: 'ok', detail: `up to date (v${dbMax})` });
      } else if (dbMax < codeMax) {
        checks.push({
          name: 'Migrations',
          status: 'warn',
          detail: `DB at v${dbMax}, code expects v${codeMax}`,
          remediation: 'Restart `vinyan serve` — migrations run on startup.',
        });
      } else {
        // dbMax > codeMax: someone downgraded code; flag as fail since
        // the runtime cannot guarantee the schema matches.
        checks.push({
          name: 'Migrations',
          status: 'fail',
          detail: `DB at v${dbMax} but code only knows up to v${codeMax}`,
          remediation: 'Upgrade Vinyan code or restore an older DB.',
        });
      }
    } catch (err) {
      checks.push({
        name: 'Migrations',
        status: 'warn',
        detail: `cannot read schema_version: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 8. Runtime probes — injected by the HTTP handler. Without them
  // doctor still works (warns where applicable) so the CLI path stays
  // identical to the original behaviour.
  const rt = options.runtime;
  if (rt) {
    if (typeof rt.recorderActive === 'boolean') {
      checks.push(
        rt.recorderActive
          ? { name: 'Event Recorder', status: 'ok', detail: 'task_events recorder wired' }
          : {
              name: 'Event Recorder',
              status: 'warn',
              detail: 'task_events recorder not wired — historical replay limited',
              remediation: 'Wire taskEventStore in cli/serve.ts.',
            },
      );
    }
    if (typeof rt.schedulerActive === 'boolean') {
      const count = rt.activeScheduleCount ?? 0;
      checks.push(
        rt.schedulerActive
          ? {
              name: 'Scheduler',
              status: 'ok',
              detail: `gatewayScheduleStore wired — ${count} active job${count === 1 ? '' : 's'}`,
            }
          : {
              name: 'Scheduler',
              status: 'warn',
              detail: 'scheduler store not wired — /api/v1/scheduler/jobs returns 503',
              remediation: 'Set gatewayScheduleStore on APIServerDeps.',
            },
      );
    }
    if (typeof rt.skillsActive === 'boolean') {
      checks.push(
        rt.skillsActive
          ? { name: 'Skills', status: 'ok', detail: 'skill registry wired' }
          : {
              name: 'Skills',
              status: 'warn',
              detail: 'no skill registry — /api/v1/skills will be empty',
            },
      );
    }
    if (typeof rt.memoryWikiActive === 'boolean') {
      // Memory Wiki is the markdown-vault projection of the wiki DB
      // (`.vinyan/wiki/` — pages, raw sources, MOC). The probe combines
      // three signals so the operator sees ONE row covering: routes
      // wired (HTTP 200 vs 503), vault scaffolded (markdown projection
      // on disk), and content (page/source/lint counts pulled from the
      // wiki tables). Empty content is OK on a fresh install — the
      // wired+scaffolded signal is what determines `ok` vs `warn`.
      const wired = rt.memoryWikiActive;
      const wikiVaultRoot = join(workspace, '.vinyan', 'wiki');
      const vaultScaffolded = existsSync(join(wikiVaultRoot, 'MEMORY_SCHEMA.md'));

      let pageCount = 0;
      let sourceCount = 0;
      let openLint = 0;
      let countsAvailable = false;
      if (existsSync(dbPath)) {
        try {
          const { Database } = await import('bun:sqlite');
          const db = new Database(dbPath, { readonly: true });
          pageCount =
            (db.query('SELECT COUNT(*) as c FROM memory_wiki_pages').get() as { c: number } | null)
              ?.c ?? 0;
          sourceCount =
            (db.query('SELECT COUNT(*) as c FROM memory_wiki_sources').get() as
              | { c: number }
              | null)?.c ?? 0;
          openLint =
            (db
              .query(
                'SELECT COUNT(*) as c FROM memory_wiki_lint_findings WHERE resolved_at IS NULL',
              )
              .get() as { c: number } | null)?.c ?? 0;
          db.close();
          countsAvailable = true;
        } catch {
          /* tables may not exist yet on a pre-migration DB; counts stay 0 */
        }
      }

      const parts: string[] = [];
      parts.push(wired ? 'wired' : 'not wired');
      parts.push(vaultScaffolded ? 'vault scaffolded' : 'vault missing');
      if (countsAvailable) {
        parts.push(`${pageCount} page${pageCount === 1 ? '' : 's'}`);
        parts.push(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`);
        if (openLint > 0) parts.push(`${openLint} open finding${openLint === 1 ? '' : 's'}`);
      }

      const status: 'ok' | 'warn' = wired && vaultScaffolded ? 'ok' : 'warn';
      const remediation = !wired
        ? 'Wire `memoryWiki` in cli/serve.ts via `MemoryWiki.create({ db, workspace, bus })`.'
        : !vaultScaffolded
          ? 'Restart `vinyan serve` — the bundle scaffolds `<workspace>/.vinyan/wiki/` on construction.'
          : sourceCount === 0
            ? 'No sources yet — the auto-feed bridge ingests on `session:archived` / `session:compacted`. Archive a session or POST `/api/v1/memory-wiki/ingest` to seed manually.'
            : undefined;

      checks.push({
        name: 'Memory Wiki',
        status,
        detail: parts.join(' · '),
        ...(remediation ? { remediation } : {}),
      });
    }
    if (rt.providerCooldowns) {
      try {
        const cooldowns = rt.providerCooldowns();
        if (cooldowns.length === 0) {
          checks.push({ name: 'Provider Health', status: 'ok', detail: 'no providers in cooldown' });
        } else {
          // Don't reveal full provider names if they could be sensitive
          // — list count + earliest reset only.
          const earliest = Math.min(...cooldowns.map((c) => c.cooldownUntil));
          const remainingMs = Math.max(0, earliest - Date.now());
          checks.push({
            name: 'Provider Health',
            status: 'warn',
            detail: `${cooldowns.length} provider(s) in cooldown, earliest reset in ${Math.round(remainingMs / 1000)}s`,
            remediation: 'Wait for cooldown or rotate API keys.',
          });
        }
      } catch (err) {
        checks.push({
          name: 'Provider Health',
          status: 'warn',
          detail: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    if (typeof rt.inFlightTaskCount === 'number') {
      checks.push({
        name: 'In-Flight Tasks',
        status: rt.inFlightTaskCount > 50 ? 'warn' : 'ok',
        detail: `${rt.inFlightTaskCount} task(s) in flight`,
        ...(rt.inFlightTaskCount > 50
          ? { remediation: 'Inspect /api/v1/tasks for stuck or runaway tasks.' }
          : {}),
      });
    }
    if (typeof rt.recoveredOrphanCount === 'number' && rt.recoveredOrphanCount > 0) {
      checks.push({
        name: 'Orphan Recovery',
        status: 'warn',
        detail: `${rt.recoveredOrphanCount} task(s) were marked failed at last startup`,
        remediation: 'Inspect /api/v1/tasks?status=failed for the recovered rows.',
      });
    }
    if (rt.autogenPolicy) {
      try {
        const snap = rt.autogenPolicy();
        if (snap) {
          checks.push({
            name: 'Autogen Threshold',
            status: 'ok',
            detail: snap.enabled
              ? `threshold=${snap.threshold} (adaptive · ${snap.recentChanges} changes recorded · ${snap.pendingCount} pending)`
              : `threshold=${snap.threshold} (static — adaptive policy disabled)`,
          });
        } else {
          checks.push({
            name: 'Autogen Threshold',
            status: 'warn',
            detail: 'autogen policy not wired — auto-generated proposals fall back to default',
          });
        }
      } catch (err) {
        checks.push({
          name: 'Autogen Threshold',
          status: 'warn',
          detail: `policy probe failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    if (rt.autogenTrackerState) {
      try {
        const state = rt.autogenTrackerState();
        if (state) {
          const oldestAge =
            state.oldestSeen != null ? Math.round((Date.now() - state.oldestSeen) / 60_000) : null;
          checks.push({
            name: 'Autogen Tracker',
            status: 'ok',
            detail: `${state.rows} signature${state.rows === 1 ? '' : 's'} tracked · ${
              state.cooldownActive
            } in cooldown · oldest ${oldestAge !== null ? `${oldestAge}m ago` : '—'} · boot ${
              state.bootId?.slice(0, 8) ?? '—'
            }`,
          });
        } else {
          checks.push({
            name: 'Autogen Tracker',
            status: 'warn',
            detail: 'tracker state not wired — restart will reset autogen progress',
          });
        }
      } catch (err) {
        checks.push({
          name: 'Autogen Tracker',
          status: 'warn',
          detail: `tracker probe failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return checks;
}

/** Overall verdict from a set of check results. */
export function summarizeChecks(checks: DoctorCheck[]): {
  status: 'healthy' | 'degraded' | 'critical';
  passed: number;
  total: number;
} {
  const total = checks.length;
  const passed = checks.filter((c) => c.status === 'ok').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;

  const status: 'healthy' | 'degraded' | 'critical' =
    failed > 0 ? 'critical' : warned > 0 ? 'degraded' : 'healthy';

  return { status, passed, total };
}

/** CLI entry point — runs the checks with deep mode and prints to console. */
export async function runDoctor(workspace: string): Promise<void> {
  const checks = await runDoctorChecks(workspace, { deep: true });

  console.log('\n  Vinyan Doctor — Health Check\n');

  let hasFailures = false;
  for (const check of checks) {
    const icon = check.status === 'ok' ? '\x1b[32m✓\x1b[0m' : check.status === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const color = check.status === 'ok' ? '' : check.status === 'warn' ? '\x1b[33m' : '\x1b[31m';
    const reset = check.status === 'ok' ? '' : '\x1b[0m';
    console.log(`  ${icon} ${check.name.padEnd(14)} ${color}${check.detail}${reset}`);
    if (check.status === 'fail') hasFailures = true;
  }

  const { passed, total } = summarizeChecks(checks);
  console.log(`\n  ${passed}/${total} checks passed\n`);

  if (hasFailures) process.exit(1);
}

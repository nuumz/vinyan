/**
 * CLI: vinyan serve — start the API server.
 *
 * Creates an Orchestrator and wraps it with the HTTP API server.
 * If network.instances.enabled, also creates and starts the A2AManager
 * to enable multi-instance coordination.
 *
 * Zombie-free guarantees:
 *   1. Phase-aware error gating — startup errors are fatal, steady-state
 *      worker crashes are non-fatal. Prevents "server died but process
 *      idles forever" pattern.
 *   2. Port preflight via server.start() try/catch — EADDRINUSE exits(78)
 *      immediately with a clear message including the holding PID.
 *   3. PID file at .vinyan/serve.pid — enables external tooling
 *      (systemd / launchd / manual cleanup) and stale-PID detection
 *      on next start.
 *   4. Parent-death watchdog — when run as a supervised child
 *      (VINYAN_SUPERVISOR_PID set), polls the supervisor and self-
 *      terminates if it disappears, so a SIGKILL'd supervisor cannot
 *      orphan us.
 *   5. Early signal handlers — SIGINT/SIGTERM/SIGHUP registered BEFORE
 *      orchestrator init + server start, closing the startup-window
 *      hole where default signal behavior would apply.
 *   6. Per-step shutdown timeouts — each cleanup step wrapped in
 *      withTimeout(label, ms, promise). If any step hangs we log
 *      which one, and the global 8s force-exit still fires.
 *   7. process.on('exit') last-resort sync cleanup — remove PID file
 *      even if we exit uncleanly.
 */

import { unlinkSync } from 'node:fs';
import { join } from 'path';
import { type A2AManagerImpl, createA2AManager } from '../a2a/a2a-manager.ts';
import { VinyanAPIServer } from '../api/server.ts';
import { SessionManager } from '../api/session-manager.ts';
import { loadConfig } from '../config/index.ts';
import { resolveProfile } from '../config/profile-resolver.ts';
import { SessionStore } from '../db/session-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { createOrchestrator } from '../orchestrator/factory.ts';
import { createTaskQueue } from '../orchestrator/task-queue.ts';
import {
  EXIT_CODE_STARTUP_FATAL,
  findPortHolder,
  readPidFile,
  recoverStaleInstance,
  writePidFile,
} from './_serve-lifecycle.ts';

/** Hard wall-clock deadline for the entire shutdown sequence. */
const SHUTDOWN_FORCE_EXIT_MS = 8_000;
/** Per-step soft deadline — if exceeded we log which step hung, the global deadline still applies. */
const STEP_TIMEOUT_MS = {
  a2a_stop: 2_000,
  server_stop: 3_000,
  orchestrator_close: 2_000,
  db_close: 1_000,
};
/**
 * Parent-death watchdog starts tight so early orphaned children exit quickly,
 * then backs off during long idle uptime to reduce always-on wakeups.
 */
const PARENT_WATCHDOG_INITIAL_INTERVAL_MS = 1_000;
const PARENT_WATCHDOG_MAX_INTERVAL_MS = 30_000;
const PARENT_WATCHDOG_BACKOFF_AFTER_MS = 60_000;

/**
 * Error codes that must ALWAYS be fatal regardless of phase. These indicate
 * a misconfiguration the process cannot recover from — silently "continuing"
 * just creates a zombie that holds nothing useful.
 */
const ALWAYS_FATAL_CODES = new Set([
  'EADDRINUSE',
  'EACCES',
  'EROFS',
  'SQLITE_BUSY',
  'SQLITE_CANTOPEN',
  'SQLITE_READONLY',
  'MODULE_NOT_FOUND',
]);
/** Error codes that are always OK to log + ignore (transient I/O hiccups from subprocesses / dropped clients). */
const TRANSIENT_IO_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED']);

type Phase = 'startup' | 'steady' | 'shutting_down';

/**
 * Options plumbed in from the top-level CLI entry (src/cli/index.ts).
 *
 * `profile` is the already-resolved profile name (flag > env > 'default').
 * Forwarded into the API server so inbound requests that don't supply
 * their own profile header/body default to this one — matching
 * `vinyan serve -p <name>` semantics.
 */
export interface ServeOptions {
  profile?: string;
}

export function nextParentWatchdogIntervalMs(currentMs: number, uptimeMs: number): number {
  if (uptimeMs < PARENT_WATCHDOG_BACKOFF_AFTER_MS) return PARENT_WATCHDOG_INITIAL_INTERVAL_MS;
  return Math.min(Math.max(currentMs * 2, PARENT_WATCHDOG_INITIAL_INTERVAL_MS), PARENT_WATCHDOG_MAX_INTERVAL_MS);
}

export async function serve(workspace: string, opts: ServeOptions = {}): Promise<void> {
  // Re-run resolveProfile so the result is a concrete, validated name.
  // When called from the CLI this is redundant (index.ts already ran it)
  // but direct callers + tests benefit from the guarantee.
  const resolvedProfile = resolveProfile({ flag: opts.profile });
  // ── Phase tracker ───────────────────────────────────────────────
  // Mutable — flipped to 'steady' at the end of serve() after a clean
  // startup, then to 'shutting_down' when shutdown fires.
  let phase: Phase = 'startup';

  // ── Resilience safety nets, phase-aware ─────────────────────────
  // Must be installed BEFORE any other init so early errors (config
  // parse, DB open) are handled uniformly.
  installProcessSafetyNets(() => phase);

  // ── Signal handlers: register FIRST, stand-in handler that kicks
  //    us into the real shutdown once it's defined. Closes the
  //    startup-window hole where Ctrl+C between `serve()` start and
  //    handler registration would terminate via the default handler
  //    and strand resources.
  let shutdownFn: (() => Promise<void>) | null = null;
  const earlySignalHandler = (signal: NodeJS.Signals) => {
    if (shutdownFn) {
      void shutdownFn();
    } else {
      console.error(`[vinyan] Received ${signal} during startup — exiting`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => earlySignalHandler('SIGINT'));
  process.on('SIGTERM', () => earlySignalHandler('SIGTERM'));
  process.on('SIGHUP', () => earlySignalHandler('SIGHUP'));

  // ── Load config early so we know the port for recovery ─────────
  const vinyanConfigEarly = loadConfig(workspace);
  const portEarly = vinyanConfigEarly.network?.api?.port ?? 3927;

  // ── Auto-recovery of stale instances ───────────────────────────
  //
  // Under supervisor: recovery already ran in supervise.ts before we
  // were spawned, so skip. Direct / --no-supervise: WE must do it,
  // otherwise a previous zombie still holding the port would block us.
  //
  // The recovery kills any lingering vinyan-serve process for THIS
  // workspace (SIGTERM → 3s → SIGKILL), releases the port, cleans up
  // stale PID files, and proceeds. The user never has to manually
  // hunt down a zombie — zombie-free under any circumstance.
  const pidFilePath = join(workspace, '.vinyan', 'serve.pid');
  const supervisorPidPath = join(workspace, '.vinyan', 'supervisor.pid');
  const supervisorPid = parseInt(process.env.VINYAN_SUPERVISOR_PID ?? '0', 10);

  if (!process.env.VINYAN_SUPERVISED) {
    const { foreignHolders } = await recoverStaleInstance({
      workspace,
      port: portEarly,
      supervisorPidPath,
      servePidPath: pidFilePath,
      logPrefix: '[vinyan]',
      protectedPids: supervisorPid > 0 ? [supervisorPid] : undefined,
    });
    if (foreignHolders.length > 0) {
      console.error(`[vinyan] Port ${portEarly} held by non-vinyan process(es): ${foreignHolders.join(', ')}.`);
      console.error('[vinyan] Stop them first or pick a different port in vinyan.json.');
      process.exit(EXIT_CODE_STARTUP_FATAL);
    }
  } else {
    // Under supervisor: quickly double-check there's no stale serve.pid
    // pointing at a dead process — can happen after a SIGKILL of a
    // previous child that bypassed our exit handler.
    const stalePid = readPidFile(pidFilePath);
    if (stalePid !== null && stalePid !== process.pid && stalePid !== supervisorPid) {
      try {
        process.kill(stalePid, 0);
        // Alive AND not our supervisor — supervisor should have run
        // recovery first. Refuse to start so two children cannot race
        // for the port.
        console.error(`[vinyan] Stale child still alive (pid ${stalePid}); supervisor should have cleaned this up.`);
        process.exit(EXIT_CODE_STARTUP_FATAL);
      } catch {
        // Dead — remove stale PID file.
        try {
          unlinkSync(pidFilePath);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  // ── Parent-death watchdog (supervised mode only) ────────────────
  // When run as a child of supervise.ts, the supervisor exports its
  // PID via VINYAN_SUPERVISOR_PID. If the supervisor is SIGKILL'd
  // (or crashes) before it can signal us, we would otherwise orphan.
  // Polling process.kill(pid, 0) lets us self-terminate cleanly. The
  // interval adapts after the first minute to keep long idle servers quiet.
  if (supervisorPid > 0) {
    const startedAt = Date.now();
    let intervalMs = PARENT_WATCHDOG_INITIAL_INTERVAL_MS;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const scheduleWatchdog = () => {
      watchdog = setTimeout(() => {
        try {
          process.kill(supervisorPid, 0);
        } catch {
          console.error(`[vinyan] Supervisor (pid ${supervisorPid}) is gone — self-terminating`);
          process.exit(1);
        }
        intervalMs = nextParentWatchdogIntervalMs(intervalMs, Date.now() - startedAt);
        scheduleWatchdog();
      }, intervalMs);
      (watchdog as { unref?: () => void }).unref?.();
    };
    scheduleWatchdog();
    process.once('exit', () => {
      if (watchdog) clearTimeout(watchdog);
    });
  }

  // ── Shared DB + session store wiring ────────────────────────────
  // Must exist before createOrchestrator so core-loop deps.sessionManager
  // is populated; without it the creative-clarification gate, pending-
  // clarification lookup, root-goal walk-back, and working-memory hydrate
  // paths all silently no-op and treat every POST /messages as a fresh
  // session (re-asking the same clarifications forever).
  //
  // The same VinyanDB handle is injected into createOrchestrator so the
  // factory reuses it instead of opening a second bun:sqlite connection on
  // the same WAL file. Double-open doubled migration passes and left each
  // connection with its own cache/journal snapshot — transient SQLITE_BUSY
  // would hit ALWAYS_FATAL_CODES here and crash the server.
  const db = new VinyanDB(join(workspace, '.vinyan', 'vinyan.db'));
  const sessionStore = new SessionStore(db.getDb());
  const sessionManager = new SessionManager(sessionStore);

  // Phase 2 hybrid storage: when `session.dualWrite.enabled=true`, every
  // SessionManager mutator appends a JSONL line first then writes SQLite.
  // The default is OFF — flip via `vinyan.json` (`session.dualWrite.enabled`)
  // until production wiring (this PR) is verified end-to-end.
  if (vinyanConfigEarly.session?.dualWrite?.enabled === true) {
    const { JsonlAppender } = await import('../db/session-jsonl/appender.ts');
    const { IndexRebuilder } = await import('../db/session-jsonl/rebuild-index.ts');
    const layout = { sessionsDir: resolvedProfile.paths.sessionsDir };
    const jsonlAppender = new JsonlAppender({ layout });
    const indexRebuilder = new IndexRebuilder(db.getDb(), layout);
    sessionManager.attachJsonlLayer(jsonlAppender, indexRebuilder);
  }

  // ── Orchestrator + server wiring ────────────────────────────────
  const orchestrator = createOrchestrator({ workspace, sessionManager, db });

  // Late-bind the TraceStore so `getConversationHistoryDetailed` can build
  // `traceSummary` (model + agent + routing-level chips) for every
  // historical assistant message. Without this hookup the chat UI shows
  // bare bubbles with no provenance metadata.
  if (orchestrator.traceStore) {
    sessionManager.attachTraceStore(orchestrator.traceStore);
  }

  // Sweep tasks left in `pending` / `running` from the previous run.
  // The in-memory inFlightTasks Map is reset on every start, so without
  // this sweep the row stays orphaned: chat history shows the user
  // message with no agent reply, runningTaskCount counts a phantom row,
  // and the user can't tell whether the task is still going or stuck.
  // MUST run BEFORE server.start() so clients never see the half-state.
  const orphans = sessionManager.recoverOrphanedTasks();
  if (orphans.recovered > 0) {
    console.log(
      `[vinyan-api] Recovered ${orphans.recovered} orphan task${orphans.recovered === 1 ? '' : 's'} ` +
        `across ${orphans.sessions.length} session${orphans.sessions.length === 1 ? '' : 's'} ` +
        `(marked failed + assistant turn explaining the interruption)`,
    );
  }

  // K2.2: Bounded concurrent task dispatch (default 4 concurrent top-level tasks)
  const taskQueue = createTaskQueue({ maxConcurrent: 4 });

  // Reuse the config we loaded early for port preflight.
  const network = vinyanConfigEarly.network;

  // Create A2AManager if multi-instance is enabled
  let a2aManager: A2AManagerImpl | undefined;
  if (network?.instances?.enabled) {
    a2aManager = createA2AManager({
      workspace,
      bus: orchestrator.bus,
      network,
    });
  }

  const port = network?.api?.port ?? 3927;
  const bind = network?.api?.bind ?? '127.0.0.1';
  const authEnabled = network?.api?.auth_required ?? true;

  const server = new VinyanAPIServer(
    {
      port,
      bind,
      tokenPath: join(workspace, '.vinyan', 'api-token'),
      authRequired: authEnabled,
      rateLimitEnabled: network?.api?.rate_limit_enabled ?? true,
    },
    {
      bus: orchestrator.bus,
      executeTask: (input) => taskQueue.enqueue(() => orchestrator.executeTask(input)),
      sessionManager,
      traceStore: orchestrator.traceStore,
      taskEventStore: orchestrator.taskEventStore,
      ruleStore: orchestrator.ruleStore,
      workerStore: orchestrator.workerStore,
      engineRegistry: orchestrator.engineRegistry,
      llmRegistry: orchestrator.llmRegistry,
      worldGraph: orchestrator.worldGraph,
      metricsCollector: orchestrator.metricsCollector,
      degradationStatus: orchestrator.degradationStatus,
      a2aManager,
      costLedger: orchestrator.costLedger,
      budgetEnforcer: orchestrator.budgetEnforcer,
      approvalGate: orchestrator.approvalGate,
      agentProfileStore: orchestrator.agentProfileStore,
      skillStore: orchestrator.skillStore,
      // Hybrid skills — surface the simple loader + heavy artifact store so
      // the unified Skill Library at /api/v1/skills can list and detail
      // simple/heavy/cached items in one place. CRUD writes go to
      // <workspace>/.vinyan/skills (project) or ~/.vinyan/skills (user).
      simpleSkillRegistry: orchestrator.simpleSkillRegistry,
      skillArtifactStore: orchestrator.skillArtifactStore,
      patternStore: orchestrator.patternStore,
      agentContextStore: orchestrator.agentContextStore,
      agentRegistry: orchestrator.agentRegistry,
      mcpClientPool: orchestrator.mcpClientPool,
      oracleAccuracyStore: orchestrator.oracleAccuracyStore,
      sleepCycleRunner: orchestrator.sleepCycleRunner,
      shadowStore: orchestrator.shadowStore,
      predictionLedger: orchestrator.predictionLedger,
      providerTrustStore: orchestrator.providerTrustStore,
      federationBudgetPool: orchestrator.federationBudgetPool,
      marketScheduler: orchestrator.marketScheduler,
      capabilityModel: orchestrator.capabilityModel,
      // External Coding CLI — surfaces /api/v1/coding-cli/* (sessions,
      // approvals, follow-up messages, event replay) when the controller
      // is constructed by the factory.
      codingCliController: orchestrator.codingCliController,
      codingCliStore: orchestrator.codingCliStore,
      gatewayScheduleStore: orchestrator.gatewayScheduleStore,
      skillProposalStore: orchestrator.skillProposalStore,
      skillAutogenStateStore: orchestrator.skillAutogenStateStore,
      parameterLedger: orchestrator.parameterLedger,
      workspace,
      defaultProfile: resolvedProfile.name,
    },
  );

  // ── Skill proposal autogen — wire `skill:outcome` → quarantined
  //    proposal after N successes per (agentId, taskSignature).
  //    Round 4 hardening: pass the durable state store + parameter
  //    ledger so promotion survives restarts AND the threshold tunes
  //    itself from queue health (R1 + R3).
  //    Best-effort: wiring failure must not block startup.
  let skillAutogenOff: (() => void) | null = null;
  if (orchestrator.skillProposalStore) {
    try {
      const { wireSkillProposalAutogen } = await import('../skills/proposal-autogen.ts');
      skillAutogenOff = wireSkillProposalAutogen({
        bus: orchestrator.bus,
        store: orchestrator.skillProposalStore,
        ...(orchestrator.skillAutogenStateStore ? { stateStore: orchestrator.skillAutogenStateStore } : {}),
        ...(orchestrator.parameterLedger ? { ledger: orchestrator.parameterLedger } : {}),
        defaultProfile: resolvedProfile.name,
      });
    } catch (err) {
      console.warn('[vinyan] skill-proposal autogen wiring failed:', err);
    }
  }

  // ── Shutdown machinery ──────────────────────────────────────────
  let shutdownRequested = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownRequested) {
      console.log('[vinyan] Forced exit');
      process.exit(1);
    }
    shutdownRequested = true;
    phase = 'shutting_down';
    console.log('[vinyan] Shutting down... (repeat signal to force exit)');

    // Global deadline. Clears if every step completes first. unref()
    // so the timer alone never holds the process alive.
    const forceExit = setTimeout(() => {
      console.error(`[vinyan] Cleanup exceeded ${SHUTDOWN_FORCE_EXIT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    (forceExit as { unref?: () => void }).unref?.();

    try {
      skillAutogenOff?.();
    } catch {
      /* best-effort */
    }
    try {
      sessionManager.suspendAll();
    } catch {
      /* best-effort */
    }
    if (a2aManager) {
      await withTimeout(
        'a2a.stop',
        STEP_TIMEOUT_MS.a2a_stop,
        Promise.resolve().then(() => a2aManager!.stop()),
      );
    }
    await withTimeout('server.stop', STEP_TIMEOUT_MS.server_stop, server.stop());
    await withTimeout(
      'orchestrator.close',
      STEP_TIMEOUT_MS.orchestrator_close,
      Promise.resolve().then(() => orchestrator.close()),
    );
    await withTimeout(
      'db.close',
      STEP_TIMEOUT_MS.db_close,
      Promise.resolve().then(() => db.close()),
    );

    clearTimeout(forceExit);
    try {
      unlinkSync(pidFilePath);
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  shutdownFn = shutdown;

  // ── Last-resort sync cleanup on any exit path ───────────────────
  // `exit` handlers MUST be synchronous — no awaits, no promises.
  // Guarantees PID-file removal and one more attempt to nuke worker
  // subprocesses even if cleanup was bypassed (force-exit, uncaught
  // error, process.exit from deep in the code).
  process.on('exit', () => {
    try {
      unlinkSync(pidFilePath);
    } catch {
      /* already removed */
    }
  });

  // ── Server start — synchronous throw on EADDRINUSE etc. ─────────
  try {
    server.start();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'EADDRINUSE') {
      const holder = await findPortHolder(port);
      console.error(`[vinyan] Port ${bind}:${port} is already in use${holder ? ` (pid ${holder})` : ''}.`);
      console.error(`[vinyan] Stop the other instance first: kill ${holder ?? '<pid>'}`);
      process.exit(EXIT_CODE_STARTUP_FATAL);
    }
    console.error(`[vinyan] FATAL: server.start() failed (${code ?? 'unknown'}): ${msg}`);
    process.exit(EXIT_CODE_STARTUP_FATAL);
  }

  // Server is bound — safe to claim the PID file. Write AFTER start()
  // so a failed start never leaves a stale PID on disk.
  writePidFile(pidFilePath);

  // Startup banner
  console.log(`[vinyan] Server listening on http://${bind}:${port} (pid ${process.pid})`);
  console.log(`[vinyan]   Auth: ${authEnabled ? 'enabled' : 'disabled'} | A2A: ${a2aManager ? 'enabled' : 'disabled'}`);

  // Start A2A after server is listening (peers need our endpoint up)
  if (a2aManager) {
    try {
      await a2aManager.start();
      console.log(`[vinyan]   A2A instance: ${a2aManager.identity.instanceId}`);
    } catch (err) {
      console.error('[vinyan] FATAL: A2A start failed:', err);
      process.exit(EXIT_CODE_STARTUP_FATAL);
    }
  }

  // Recover suspended sessions from previous run
  try {
    const recovered = sessionManager.recover();
    if (recovered.length > 0) {
      console.log(`[vinyan]   Recovered ${recovered.length} suspended session(s)`);
    }
  } catch (err) {
    // Session recovery failure is not fatal — the server can still
    // accept new requests. Log and continue.
    console.error('[vinyan] Session recovery failed (continuing):', err);
  }

  // Transition to steady-state — from here on, subprocess crashes
  // are recoverable (logged but not fatal), while ALWAYS_FATAL codes
  // still exit.
  phase = 'steady';
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Wrap a promise with a diagnostic timeout. If the promise hasn't resolved
 * within `ms`, log which step is stuck. Does NOT cancel the underlying
 * work — that's the hard-exit timer's job. Purpose is visibility: users
 * learn which cleanup step actually hung instead of staring at a generic
 * "Forcing exit" message.
 */
async function withTimeout<T>(label: string, ms: number, promise: Promise<T>): Promise<void> {
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      console.error(`[vinyan] shutdown step "${label}" exceeded ${ms}ms (still waiting)`);
    }
  }, ms);
  (timer as { unref?: () => void }).unref?.();
  try {
    await promise;
  } catch (err) {
    console.error(`[vinyan] shutdown step "${label}" errored:`, err);
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

// ── Process-level resilience ─────────────────────────────────────────

let safetyNetsInstalled = false;

/**
 * Install process-level handlers so transient subprocess errors (EPIPE,
 * worker crashes) never take down the API server — BUT ensure that
 * errors during startup are always fatal, and always-fatal codes (port
 * bind, DB lock, etc.) exit no matter what phase we're in.
 *
 * The anti-pattern we're avoiding: the previous implementation caught
 * EVERY uncaughtException post-boot. If `Bun.serve()` threw EADDRINUSE
 * asynchronously, the server was never actually listening but the
 * process would idle forever, holding nothing useful — creating a
 * zombie on every port conflict.
 *
 * Idempotent: safe to call multiple times.
 */
function installProcessSafetyNets(getPhase: () => Phase): void {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;

  const handle = (kind: 'uncaughtException' | 'unhandledRejection', err: unknown) => {
    const code = (err as { code?: string } | null)?.code;
    const msg = err instanceof Error ? err.message : String(err);

    // Always-fatal misconfigurations — exit regardless of phase.
    if (code && ALWAYS_FATAL_CODES.has(code)) {
      console.error(`[vinyan] FATAL ${code}: ${msg}`);
      process.exit(EXIT_CODE_STARTUP_FATAL);
    }

    // Transient I/O from subprocess pipes / dropped clients — always OK.
    if (code && TRANSIENT_IO_CODES.has(code)) {
      console.error(`[vinyan] Non-fatal ${code}: ${msg} (server continues)`);
      return;
    }

    // During startup, any unexpected error is fatal — better to fail
    // loudly and let the supervisor / user see it than to idle silently.
    const phase = getPhase();
    if (phase === 'startup') {
      console.error(`[vinyan] FATAL ${kind} during startup:`, err);
      process.exit(1);
    }

    // Steady-state: log but continue. The orchestrator has its own
    // retry/escalation paths for actual task failures.
    console.error(`[vinyan] ${kind} (steady-state, continuing):`, err);
  };

  process.on('uncaughtException', (err) => handle('uncaughtException', err));
  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason));
}

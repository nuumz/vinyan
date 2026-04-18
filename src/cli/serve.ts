/**
 * CLI: vinyan serve — start the API server.
 *
 * Creates an Orchestrator and wraps it with the HTTP API server.
 * If network.instances.enabled, also creates and starts the A2AManager
 * to enable multi-instance coordination.
 * SIGTERM/SIGINT trigger graceful shutdown.
 */

import { join } from 'path';
import { createA2AManager, type A2AManagerImpl } from '../a2a/a2a-manager.ts';
import { VinyanAPIServer } from '../api/server.ts';
import { SessionManager } from '../api/session-manager.ts';
import { loadConfig } from '../config/index.ts';
import { SessionStore } from '../db/session-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { createOrchestrator } from '../orchestrator/factory.ts';
import { createTaskQueue } from '../orchestrator/task-queue.ts';

export async function serve(workspace: string): Promise<void> {
  // ── Resilience: never die from a stray error in a subprocess handler ──
  // Worker subprocesses (agent-worker-entry, oracle subprocesses, etc.) can
  // crash/close stdin mid-write. Those throw EPIPE / unhandled rejections
  // which would otherwise kill the API server. Log and keep serving —
  // the orchestrator already tracks task failures via its own error paths.
  installProcessSafetyNets();

  const orchestrator = createOrchestrator({ workspace });

  // K2.2: Bounded concurrent task dispatch (default 4 concurrent top-level tasks)
  const taskQueue = createTaskQueue({ maxConcurrent: 4 });

  // Load network config for A2A multi-instance
  const vinyanConfig = loadConfig(workspace);
  const network = vinyanConfig.network;

  // Create A2AManager if multi-instance is enabled
  let a2aManager: A2AManagerImpl | undefined;
  if (network?.instances?.enabled) {
    a2aManager = createA2AManager({
      workspace,
      bus: orchestrator.bus,
      network,
    });
  }

  // Set up session store
  const db = new VinyanDB(join(workspace, '.vinyan', 'vinyan.db'));
  const sessionStore = new SessionStore(db.getDb());
  const sessionManager = new SessionManager(sessionStore);

  const server = new VinyanAPIServer(
    {
      port: network?.api?.port ?? 3927,
      bind: network?.api?.bind ?? '127.0.0.1',
      tokenPath: join(workspace, '.vinyan', 'api-token'),
      authRequired: network?.api?.auth_required ?? true,
      rateLimitEnabled: network?.api?.rate_limit_enabled ?? true,
    },
    {
      bus: orchestrator.bus,
      executeTask: (input) => taskQueue.enqueue(() => orchestrator.executeTask(input)),
      sessionManager,
      traceStore: orchestrator.traceStore,
      ruleStore: orchestrator.ruleStore,
      workerStore: orchestrator.workerStore,
      worldGraph: orchestrator.worldGraph,
      metricsCollector: orchestrator.metricsCollector,
      a2aManager,
      costLedger: orchestrator.costLedger,
      budgetEnforcer: orchestrator.budgetEnforcer,
      approvalGate: orchestrator.approvalGate,
      agentProfileStore: orchestrator.agentProfileStore,
      skillStore: orchestrator.skillStore,
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
      workspace,
    },
  );

  // Graceful shutdown — suspend sessions before closing DB.
  //
  // CRITICAL: register SIGINT/SIGTERM handlers BEFORE server.start()
  // and BEFORE the synchronous sessionManager.recover() call. During
  // startup there is a window where the child is fully async-scheduled
  // but signal handlers have not been installed — Bun's default
  // behavior would either ignore or terminate without running our
  // cleanup. Registering early eliminates that window.
  let shutdownRequested = false;
  const FORCE_EXIT_MS = 8_000;
  const shutdown = async () => {
    if (shutdownRequested) {
      console.log('[vinyan] Forced exit');
      process.exit(1);
    }
    shutdownRequested = true;
    console.log('[vinyan] Shutting down... (repeat signal to force exit)');

    // Backstop: even if any cleanup step hangs (Bun.serve.stop awaiting
    // a stuck connection, SQLite checkpoint blocked on disk, worker
    // that won't die), force exit after FORCE_EXIT_MS so the user does
    // not have to send a second signal. unref() so this timer itself
    // never keeps the process alive once cleanup completes.
    const forceExit = setTimeout(() => {
      console.error(`[vinyan] Cleanup exceeded ${FORCE_EXIT_MS}ms — forcing exit`);
      process.exit(1);
    }, FORCE_EXIT_MS);
    (forceExit as { unref?: () => void }).unref?.();

    try {
      sessionManager.suspendAll();
    } catch {
      /* best-effort */
    }
    try {
      if (a2aManager) await a2aManager.stop();
    } catch {
      /* best-effort */
    }
    try {
      await server.stop();
    } catch {
      /* best-effort */
    }
    try {
      orchestrator.close();
    } catch {
      /* best-effort */
    }
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.start();

  // Startup banner
  const port = network?.api?.port ?? 3927;
  const bind = network?.api?.bind ?? '127.0.0.1';
  const authEnabled = network?.api?.auth_required ?? true;
  console.log(`[vinyan] Server listening on http://${bind}:${port}`);
  console.log(`[vinyan]   Auth: ${authEnabled ? 'enabled' : 'disabled'} | A2A: ${a2aManager ? 'enabled' : 'disabled'}`);

  // Start A2A after server is listening (peers need our endpoint up)
  if (a2aManager) {
    await a2aManager.start();
    console.log(`[vinyan]   A2A instance: ${a2aManager.identity.instanceId}`);
  }

  // Recover suspended sessions from previous run
  const recovered = sessionManager.recover();
  if (recovered.length > 0) {
    console.log(`[vinyan]   Recovered ${recovered.length} suspended session(s)`);
  }
}

// ── Process-level resilience ─────────────────────────────────────────

let safetyNetsInstalled = false;

/**
 * Install process-level handlers so transient subprocess errors (EPIPE,
 * worker crashes, orphaned promise rejections) never take down the API
 * server. Fatal errors (out-of-memory, stack overflow) still exit —
 * those indicate real bugs that need external restart.
 *
 * Idempotent: safe to call multiple times.
 */
function installProcessSafetyNets(): void {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;

  process.on('uncaughtException', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    // EPIPE = worker subprocess closed stdin before we finished writing.
    // ECONNRESET = a client/peer dropped a socket mid-response.
    // Both are recoverable — the request/task layer has its own retry.
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
      console.error(`[vinyan] Non-fatal ${code}: ${msg} (server continues)`);
      return;
    }
    console.error('[vinyan] uncaughtException:', err);
    console.error('[vinyan] Server continues — investigate the cause above.');
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const code = (reason as { code?: string } | null)?.code;
    if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED') {
      console.error(`[vinyan] Non-fatal ${code}: ${msg} (server continues)`);
      return;
    }
    console.error('[vinyan] unhandledRejection:', reason);
  });
}

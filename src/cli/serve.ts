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
    },
  );

  server.start();

  // Start A2A after server is listening (peers need our endpoint up)
  if (a2aManager) {
    await a2aManager.start();
    console.log(`[vinyan] A2A multi-instance: ${a2aManager.identity.instanceId}`);
  }

  // Recover suspended sessions from previous run
  const recovered = sessionManager.recover();
  if (recovered.length > 0) {
    console.log(`[vinyan] Recovered ${recovered.length} suspended sessions`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    if (a2aManager) await a2aManager.stop();
    await server.stop();
    orchestrator.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

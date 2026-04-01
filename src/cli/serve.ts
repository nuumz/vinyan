/**
 * CLI: vinyan serve — start the API server.
 *
 * Creates an Orchestrator and wraps it with the HTTP API server.
 * SIGTERM/SIGINT trigger graceful shutdown.
 */

import { join } from 'path';
import { VinyanAPIServer } from '../api/server.ts';
import { SessionManager } from '../api/session-manager.ts';
import { SessionStore } from '../db/session-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';
import { createOrchestrator } from '../orchestrator/factory.ts';

export async function serve(workspace: string): Promise<void> {
  const orchestrator = createOrchestrator({ workspace });

  // Set up session store
  const db = new VinyanDB(join(workspace, '.vinyan', 'vinyan.db'));
  const sessionStore = new SessionStore(db.getDb());
  const sessionManager = new SessionManager(sessionStore);

  const server = new VinyanAPIServer(
    {
      port: 3927,
      bind: '127.0.0.1',
      tokenPath: join(workspace, '.vinyan', 'api-token'),
      authRequired: true,
      rateLimitEnabled: true,
    },
    {
      bus: orchestrator.bus,
      executeTask: (input) => orchestrator.executeTask(input),
      sessionManager,
      traceStore: orchestrator.traceStore,
      ruleStore: orchestrator.ruleStore,
      workerStore: orchestrator.workerStore,
      worldGraph: orchestrator.worldGraph,
      metricsCollector: orchestrator.metricsCollector,
    },
  );

  server.start();

  // Recover suspended sessions from previous run
  const recovered = sessionManager.recover();
  if (recovered.length > 0) {
    console.log(`[vinyan] Recovered ${recovered.length} suspended sessions`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    await server.stop();
    orchestrator.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

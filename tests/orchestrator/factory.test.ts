import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBus } from '../../src/core/bus.ts';
import { WORKER_SCHEMA_SQL } from '../../src/db/worker-schema.ts';
import { WorkerStore } from '../../src/db/worker-store.ts';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { EngineProfile, LLMProvider, LLMRequest } from '../../src/orchestrator/types.ts';
import { FileWatcher } from '../../src/world-graph/file-watcher.ts';

// Re-implement autoRegisterWorkers test harness — the function is module-private,
// so we test the behavior by mimicking its logic against real stores.

const WORKER_MODEL_ALLOWLIST = ['claude-', 'gpt-', 'gemini-', 'mock/', 'openrouter/'];

function mockLlmProvider(id: string): LLMProvider {
  return {
    name: id,
    generate: async (_req: LLMRequest) => ({ content: '', tokensUsed: { input: 0, output: 0 } }),
    supportedModels: () => [id],
    id,
    maxContextTokens: 100_000,
  } as any;
}

describe('autoRegisterWorkers logic', () => {
  let db: Database;
  let workerStore: WorkerStore;
  let _bus: ReturnType<typeof createBus>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(WORKER_SCHEMA_SQL);
    workerStore = new WorkerStore(db);
    _bus = createBus();
  });

  afterEach(() => {
    db.close();
  });

  test('allowlisted model (claude-sonnet) → registered as active worker', () => {
    const registry = new LLMProviderRegistry();
    const provider = mockLlmProvider('claude-sonnet-4');
    registry.register(provider);

    // Simulate autoRegisterWorkers logic
    for (const p of registry.listProviders()) {
      const allowlisted = WORKER_MODEL_ALLOWLIST.some((prefix) => p.id.startsWith(prefix));
      if (!allowlisted) continue;
      const workerId = `worker-${p.id}`;
      const existing = workerStore.findById(workerId);
      if (existing) continue;
      const profile: EngineProfile = {
        id: workerId,
        config: {
          modelId: p.id,
          temperature: 0.7,
          systemPromptTemplate: 'default',
          maxContextTokens: p.maxContextTokens,
        },
        status: 'active',
        createdAt: Date.now(),
        demotionCount: 0,
      };
      workerStore.insert(profile);
    }

    const worker = workerStore.findById('worker-claude-sonnet-4');
    expect(worker).toBeDefined();
    expect(worker!.status).toBe('active');
  });

  test('non-allowlisted model → skipped', () => {
    const registry = new LLMProviderRegistry();
    const provider = mockLlmProvider('custom-model-v1');
    registry.register(provider);

    for (const p of registry.listProviders()) {
      const allowlisted = WORKER_MODEL_ALLOWLIST.some((prefix) => p.id.startsWith(prefix));
      if (!allowlisted) continue;
      const workerId = `worker-${p.id}`;
      const existing = workerStore.findById(workerId);
      if (existing) continue;
      workerStore.insert({
        id: workerId,
        config: { modelId: p.id, temperature: 0.7, systemPromptTemplate: 'default', maxContextTokens: 100_000 },
        status: 'active',
        createdAt: Date.now(),
        demotionCount: 0,
      });
    }

    const worker = workerStore.findById('worker-custom-model-v1');
    expect(worker).toBeNull();
  });

  test('re-registration of existing worker → no duplicate', () => {
    const registry = new LLMProviderRegistry();
    const provider = mockLlmProvider('claude-haiku');
    registry.register(provider);

    // First registration
    workerStore.insert({
      id: 'worker-claude-haiku',
      config: { modelId: 'claude-haiku', temperature: 0.5, systemPromptTemplate: 'custom', maxContextTokens: 50_000 },
      status: 'active',
      createdAt: Date.now(),
      demotionCount: 0,
    });

    // Simulate re-registration — should skip
    for (const p of registry.listProviders()) {
      const allowlisted = WORKER_MODEL_ALLOWLIST.some((prefix) => p.id.startsWith(prefix));
      if (!allowlisted) continue;
      const workerId = `worker-${p.id}`;
      const existing = workerStore.findById(workerId);
      if (existing) continue;
      workerStore.insert({
        id: workerId,
        config: { modelId: p.id, temperature: 0.7, systemPromptTemplate: 'default', maxContextTokens: 100_000 },
        status: 'active',
        createdAt: Date.now(),
        demotionCount: 0,
      });
    }

    // Original config preserved (temperature=0.5, not overwritten to 0.7)
    const worker = workerStore.findById('worker-claude-haiku');
    expect(worker).toBeDefined();
    expect(worker!.config.temperature).toBe(0.5);
  });

  test('multiple providers: only allowlisted ones registered', () => {
    const registry = new LLMProviderRegistry();
    registry.register(mockLlmProvider('claude-opus'));
    registry.register(mockLlmProvider('gpt-4-turbo'));
    registry.register(mockLlmProvider('unknown-model'));

    for (const p of registry.listProviders()) {
      const allowlisted = WORKER_MODEL_ALLOWLIST.some((prefix) => p.id.startsWith(prefix));
      if (!allowlisted) continue;
      const workerId = `worker-${p.id}`;
      const existing = workerStore.findById(workerId);
      if (existing) continue;
      workerStore.insert({
        id: workerId,
        config: { modelId: p.id, temperature: 0.7, systemPromptTemplate: 'default', maxContextTokens: 100_000 },
        status: 'active',
        createdAt: Date.now(),
        demotionCount: 0,
      });
    }

    expect(workerStore.findById('worker-claude-opus')).toBeDefined();
    expect(workerStore.findById('worker-gpt-4-turbo')).toBeDefined();
    expect(workerStore.findById('worker-unknown-model')).toBeNull();
  });
});

describe('startup worker promotion sweep', () => {
  test('probation worker with sufficient successful traces is promoted at createOrchestrator time', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-factory-promotion-'));
    const startSpy = spyOn(FileWatcher.prototype, 'start').mockImplementation(() => {});

    try {
      // First boot creates the DB with full migrations.
      const first = createOrchestrator({
        workspace,
        registry: new LLMProviderRegistry(),
        useSubprocess: false,
        watchWorkspace: false,
      });
      await first.close();

      // Seed a probation worker with enough successful trace evidence to pass
      // the Wilson-LB promotion gate (fresh install: zero active workers →
      // active median = 0, so any positive success record qualifies).
      const dbPath = join(workspace, '.vinyan', 'vinyan.db');
      const seedDb = new Database(dbPath);
      const seedStore = new WorkerStore(seedDb);
      seedStore.insert({
        id: 'worker-claude-probation',
        config: {
          modelId: 'claude-test',
          temperature: 0.7,
          systemPromptTemplate: 'default',
          maxContextTokens: 100_000,
        },
        status: 'probation',
        createdAt: Date.now(),
        demotionCount: 0,
      });
      const insertTrace = seedDb.prepare(`
        INSERT INTO execution_traces
          (id, task_id, worker_id, timestamp, routing_level, approach, model_used,
           tokens_consumed, duration_ms, outcome, oracle_verdicts, affected_files)
        VALUES (?, ?, ?, ?, 1, 'seed', 'claude-test', 100, 50, 'success', '{}', '[]')
      `);
      for (let i = 0; i < 35; i++) {
        insertTrace.run(`trace-promo-${i}`, `task-promo-${i}`, 'worker-claude-probation', Date.now() - i * 1000);
      }
      seedDb.close();

      // Second boot must run the startup promotion sweep against persisted evidence.
      const second = createOrchestrator({
        workspace,
        registry: new LLMProviderRegistry(),
        useSubprocess: false,
        watchWorkspace: false,
      });
      await second.close();

      const checkDb = new Database(dbPath);
      const row = checkDb.prepare(`SELECT status FROM worker_profiles WHERE id = 'worker-claude-probation'`).get() as {
        status: string;
      } | null;
      checkDb.close();
      expect(row?.status).toBe('active');
    } finally {
      startSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('createOrchestrator workspace watching', () => {
  test('skips file watcher startup when watchWorkspace=false', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-factory-watch-off-'));
    const startSpy = spyOn(FileWatcher.prototype, 'start').mockImplementation(() => {});

    try {
      const orchestrator = createOrchestrator({
        workspace,
        registry: new LLMProviderRegistry(),
        useSubprocess: false,
        watchWorkspace: false,
      });

      await orchestrator.close();
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('starts file watcher by default', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-factory-watch-on-'));
    const startSpy = spyOn(FileWatcher.prototype, 'start').mockImplementation(() => {});

    try {
      const orchestrator = createOrchestrator({
        workspace,
        registry: new LLMProviderRegistry(),
        useSubprocess: false,
      });

      await orchestrator.close();
      expect(startSpy).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('createOrchestrator lifecycle cleanup', () => {
  test('close detaches factory-owned bus listeners', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vinyan-factory-listeners-'));
    const bus = createBus();

    try {
      const orchestrator = createOrchestrator({
        workspace,
        bus,
        registry: new LLMProviderRegistry(),
        useSubprocess: false,
        watchWorkspace: false,
      });

      expect(bus.listenerCount('selfmodel:predict')).toBeGreaterThan(0);
      expect(bus.listenerCount('shadow:complete')).toBeGreaterThan(0);
      expect(bus.listenerCount('shadow:enqueue')).toBeGreaterThan(0);

      await orchestrator.close();

      expect(bus.listenerCount('selfmodel:predict')).toBe(0);
      expect(bus.listenerCount('shadow:complete')).toBe(0);
      expect(bus.listenerCount('shadow:enqueue')).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('repeated create/close cycles do not accumulate listeners on a shared bus', async () => {
    const bus = createBus();

    for (let i = 0; i < 3; i++) {
      const workspace = mkdtempSync(join(tmpdir(), `vinyan-factory-cycle-${i}-`));
      try {
        const orchestrator = createOrchestrator({
          workspace,
          bus,
          registry: new LLMProviderRegistry(),
          useSubprocess: false,
          watchWorkspace: false,
        });

        expect(bus.listenerCount('selfmodel:predict')).toBeGreaterThan(0);
        await orchestrator.close();

        expect(bus.listenerCount('selfmodel:predict')).toBe(0);
        expect(bus.listenerCount('shadow:complete')).toBe(0);
        expect(bus.listenerCount('shadow:enqueue')).toBe(0);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  });
});

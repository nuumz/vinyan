/**
 * Engine lifecycle bus listener — pins live sync between
 * `engineRegistry` and `workerStore`.
 *
 * Without this listener, engines registered AFTER startup (synthetic
 * agents, dynamically-wired Z3, Human-ECP) had no worker profile until
 * the next process restart. The dashboard then surfaced them as phantom
 * "active" rows from the registry-only fallback in `composeEngineList`.
 *
 * These tests exercise `tryRegisterEngineAsWorker` and
 * `attachEngineLifecycleListener` directly so the contract is codified
 * independently of the factory's startup wiring.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { WORKER_SCHEMA_SQL } from '../../src/db/worker-schema.ts';
import { WorkerStore } from '../../src/db/worker-store.ts';
import {
  attachEngineLifecycleListener,
  tryRegisterEngineAsWorker,
} from '../../src/orchestrator/factory.ts';
import { workerIdForEngine } from '../../src/orchestrator/llm/engine-worker-binding.ts';
import { ReasoningEngineRegistry } from '../../src/orchestrator/llm/llm-reasoning-engine.ts';
import type { ReasoningEngine } from '../../src/orchestrator/types.ts';

function makeEngine(over: Partial<ReasoningEngine> & Pick<ReasoningEngine, 'id'>): ReasoningEngine {
  return {
    engineType: 'llm',
    capabilities: ['reasoning'],
    tier: 'balanced',
    async execute() {
      throw new Error('not used in these tests');
    },
    ...over,
  };
}

let db: Database;
let workerStore: WorkerStore;
let bus: ReturnType<typeof createBus>;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(WORKER_SCHEMA_SQL);
  workerStore = new WorkerStore(db);
  bus = createBus();
});

afterEach(() => {
  db.close();
});

describe('tryRegisterEngineAsWorker', () => {
  it("creates a worker profile under the canonical 'worker-' id", () => {
    const engine = makeEngine({ id: 'openrouter/balanced/anthropic/claude-sonnet-4.6' });
    const outcome = tryRegisterEngineAsWorker(engine, {
      workerStore,
      bus,
      allowlist: [],
      resolveBootstrapStatus: () => 'probation',
    });
    expect(outcome).toBe('created');
    const found = workerStore.findById(workerIdForEngine(engine.id));
    expect(found).not.toBeNull();
    expect(found!.config.modelId).toBe(engine.id);
    expect(found!.config.tier).toBe('balanced');
    expect(found!.status).toBe('probation');
  });

  it('is idempotent — calling twice returns "already-exists" the second time', () => {
    const engine = makeEngine({ id: 'engine-1' });
    const deps = { workerStore, bus, allowlist: [], resolveBootstrapStatus: () => 'probation' as const };
    expect(tryRegisterEngineAsWorker(engine, deps)).toBe('created');
    expect(tryRegisterEngineAsWorker(engine, deps)).toBe('already-exists');
  });

  it("excludes 'tool-uses' tier and demotes any stale worker entry", () => {
    const engine = makeEngine({ id: 'openrouter/tool-uses/x', tier: 'tool-uses' });
    // Pre-seed an active stale worker for this engine — the helper should
    // demote it on the exclusion path.
    workerStore.insert({
      id: workerIdForEngine(engine.id),
      config: { modelId: engine.id, temperature: 0.7 },
      status: 'active',
      createdAt: 1_700_000_000_000,
      demotionCount: 0,
    });
    const outcome = tryRegisterEngineAsWorker(engine, {
      workerStore,
      bus,
      allowlist: [],
      resolveBootstrapStatus: () => 'active',
    });
    expect(outcome).toBe('excluded-utility-tier');
    const after = workerStore.findById(workerIdForEngine(engine.id));
    expect(after?.status).toBe('demoted');
  });

  it('respects the model allowlist', () => {
    const engine = makeEngine({ id: 'novel-vendor/some-model' });
    const outcome = tryRegisterEngineAsWorker(engine, {
      workerStore,
      bus,
      allowlist: ['openrouter/', 'anthropic/'],
      resolveBootstrapStatus: () => 'probation',
    });
    expect(outcome).toBe('excluded-by-allowlist');
    expect(workerStore.findById(workerIdForEngine(engine.id))).toBeNull();
  });
});

describe('attachEngineLifecycleListener', () => {
  it('creates a worker on engine:registered events emitted post-startup', () => {
    const registry = new ReasoningEngineRegistry();
    registry.setBus(bus);
    const detach = attachEngineLifecycleListener(registry, {
      workerStore,
      bus,
      allowlist: [],
      resolveBootstrapStatus: () => 'probation',
    });

    // Simulate Z3 / Human-ECP / dynamic synthetic agent registration.
    const engine = makeEngine({ id: 'z3-solver', engineType: 'symbolic', tier: undefined });
    registry.register(engine);

    expect(workerStore.findById(workerIdForEngine(engine.id))).not.toBeNull();
    detach();
  });

  it('marks the worker retired on engine:deregistered', () => {
    const registry = new ReasoningEngineRegistry();
    registry.setBus(bus);
    const detach = attachEngineLifecycleListener(registry, {
      workerStore,
      bus,
      allowlist: [],
      resolveBootstrapStatus: () => 'active',
    });

    const engine = makeEngine({ id: 'temp-engine', engineType: 'symbolic', tier: undefined });
    registry.register(engine);
    expect(workerStore.findById(workerIdForEngine(engine.id))?.status).toBe('active');

    registry.deregister(engine.id);
    expect(workerStore.findById(workerIdForEngine(engine.id))?.status).toBe('retired');
    detach();
  });

  it('detach unsubscribes — no further events update the store', () => {
    const registry = new ReasoningEngineRegistry();
    registry.setBus(bus);
    const detach = attachEngineLifecycleListener(registry, {
      workerStore,
      bus,
      allowlist: [],
      resolveBootstrapStatus: () => 'probation',
    });
    detach();

    registry.register(makeEngine({ id: 'after-detach' }));
    expect(workerStore.findById(workerIdForEngine('after-detach'))).toBeNull();
  });
});

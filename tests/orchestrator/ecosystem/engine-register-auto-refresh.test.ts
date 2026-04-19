import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { createBus } from '../../../src/core/bus.ts';
import { ReasoningEngineRegistry } from '../../../src/orchestrator/llm/llm-reasoning-engine.ts';
import { buildEcosystem } from '../../../src/orchestrator/ecosystem/index.ts';
import { migration031 } from '../../../src/db/migrations/031_add_agent_runtime.ts';
import { migration032 } from '../../../src/db/migrations/032_add_commitments.ts';
import { migration033 } from '../../../src/db/migrations/033_add_teams.ts';
import { migration034 } from '../../../src/db/migrations/034_add_volunteer.ts';
import type { ReasoningEngine, RERequest, REResponse } from '../../../src/orchestrator/types.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration031.up(db);
  migration032.up(db);
  migration033.up(db);
  migration034.up(db);
  return db;
}

function stubEngine(id: string, capabilities: string[]): ReasoningEngine {
  return {
    id,
    engineType: 'llm',
    tier: 'balanced',
    capabilities,
    execute: async (_req: RERequest): Promise<REResponse> => ({
      content: '',
      toolCalls: [],
      tokensUsed: { input: 0, output: 0 },
      engineId: id,
      terminationReason: 'completed',
    }),
  };
}

describe('Engine registry auto-refresh', () => {
  it('emits engine:registered when setBus is wired before register()', () => {
    const bus = createBus();
    const reg = new ReasoningEngineRegistry();
    const seen: Array<{ engineId: string; capabilities: readonly string[] }> = [];
    bus.on('engine:registered', (p) => seen.push(p));

    reg.setBus(bus);
    reg.register(stubEngine('e1', ['code-generation']));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.engineId).toBe('e1');
    expect(seen[0]!.capabilities).toEqual(['code-generation']);
  });

  it('does not emit when bus is not wired', () => {
    const bus = createBus();
    const reg = new ReasoningEngineRegistry();
    const seen: unknown[] = [];
    bus.on('engine:registered', (p) => seen.push(p));

    reg.register(stubEngine('quiet', ['x']));
    expect(seen).toHaveLength(0);
  });

  it('EcosystemCoordinator auto-adds new engines to department index and runtime FSM', () => {
    const db = makeDb();
    const bus = createBus();
    const reg = new ReasoningEngineRegistry();
    reg.setBus(bus);

    const { coordinator, runtime, departments } = buildEcosystem({
      db,
      bus,
      departments: [
        { id: 'code', anchorCapabilities: ['code-generation'], minMatchCount: 1 },
      ],
      taskResolver: () => null,
      engineRoster: () => reg.listEngines(),
    });
    coordinator.start();

    // Initially no engines — department empty, runtime has nothing.
    expect(departments.getEnginesInDepartment('code')).toHaveLength(0);

    // Register a new engine AFTER coordinator is running.
    reg.register(stubEngine('late-joiner', ['code-generation']));

    // The coordinator picked up the event synchronously.
    expect(departments.getEnginesInDepartment('code')).toContain('late-joiner');
    expect(runtime.get('late-joiner')).not.toBeNull();
    expect(runtime.get('late-joiner')!.state).toBe('standby');

    coordinator.stop();
  });

  it('deregister flips runtime to dormant and removes from department index', () => {
    const db = makeDb();
    const bus = createBus();
    const reg = new ReasoningEngineRegistry();
    reg.setBus(bus);

    const { coordinator, runtime, departments } = buildEcosystem({
      db,
      bus,
      departments: [
        { id: 'code', anchorCapabilities: ['code-generation'], minMatchCount: 1 },
      ],
      taskResolver: () => null,
      engineRoster: () => reg.listEngines(),
    });
    coordinator.start();

    reg.register(stubEngine('transient', ['code-generation']));
    expect(departments.getEnginesInDepartment('code')).toContain('transient');

    const removed = reg.deregister('transient');
    expect(removed).toBe(true);
    expect(departments.getEnginesInDepartment('code')).not.toContain('transient');
    expect(runtime.get('transient')!.state).toBe('dormant');

    coordinator.stop();
  });

  it('stop() unsubscribes so post-stop registrations are ignored', () => {
    const db = makeDb();
    const bus = createBus();
    const reg = new ReasoningEngineRegistry();
    reg.setBus(bus);

    const { coordinator, runtime, departments } = buildEcosystem({
      db,
      bus,
      departments: [
        { id: 'code', anchorCapabilities: ['code-generation'], minMatchCount: 1 },
      ],
      taskResolver: () => null,
      engineRoster: () => reg.listEngines(),
    });
    coordinator.start();
    coordinator.stop();

    reg.register(stubEngine('post-stop', ['code-generation']));
    expect(departments.getEnginesInDepartment('code')).not.toContain('post-stop');
    expect(runtime.get('post-stop')).toBeNull();
  });
});

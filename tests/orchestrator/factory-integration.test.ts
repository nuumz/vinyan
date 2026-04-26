/**
 * Factory integration — W2 plugin wiring behind the `config.plugins.enabled`
 * feature flag.
 *
 * Goals:
 *   - When the flag is OFF, the orchestrator shape is unchanged
 *     (`pluginRegistry`, `messagingLifecycle`, `pluginsReady`, `pluginWarnings`
 *     are all `undefined`).
 *   - When the flag is ON, `pluginsReady` resolves; `pluginRegistry` exposes
 *     an active memory plugin; the three SKILL.md tools are callable via the
 *     ToolExecutor.
 *   - Building the factory twice on the same workspace does not double-migrate
 *     or duplicate plugin slots (idempotent).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-factory-int-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeRegistry() {
  const registry = new LLMProviderRegistry();
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: '{}' }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: '{}' }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: '{}' }));
  return registry;
}

function writeConfig(enabled: boolean): void {
  const plugins = enabled
    ? {
        enabled: true,
        activateMemory: true,
        registerSkillTools: true,
        autoActivateMessagingAdapters: false,
        permissive: false,
        extraDiscoveryPaths: [],
      }
    : { enabled: false };
  writeFileSync(
    join(tempDir, 'vinyan.json'),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
      plugins,
    }),
  );
}

function writeConfigWithGateway(): void {
  writeFileSync(
    join(tempDir, 'vinyan.json'),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
      plugins: {
        enabled: true,
        activateMemory: false,
        registerSkillTools: false,
        autoActivateMessagingAdapters: false,
        permissive: false,
        extraDiscoveryPaths: [],
      },
      // Telegram sub-block OFF so we don't need to mock fetch — we're only
      // asserting that the dispatcher is built and the deferred executeTask
      // closure is reachable via the bus.
      gateway: { enabled: true, telegram: { enabled: false, allowedChats: [], pollTimeoutSec: 30 } },
    }),
  );
}

describe('Factory — W2 plugin integration', () => {
  test('flag OFF: orchestrator shape is unchanged (no plugin fields)', async () => {
    writeConfig(false);
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    try {
      expect(orchestrator.pluginRegistry).toBeUndefined();
      expect(orchestrator.messagingLifecycle).toBeUndefined();
      expect(orchestrator.pluginsReady).toBeUndefined();
      expect(orchestrator.pluginWarnings).toBeUndefined();
    } finally {
      await orchestrator.close();
    }
  });

  test('flag ON: pluginsReady resolves; registry has active memory; skill tools registered', async () => {
    writeConfig(true);
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    try {
      expect(orchestrator.pluginsReady).toBeDefined();
      const init = await orchestrator.pluginsReady!;
      expect(init.registry).toBeDefined();
      expect(init.memoryRegistered).toBe(true);
      expect(init.memoryActivated).toBe(true);
      expect(init.skillToolsRegistered).toBe(true);

      // After init resolves, the orchestrator's optional fields are populated.
      expect(orchestrator.pluginRegistry).toBeDefined();
      expect(orchestrator.messagingLifecycle).toBeDefined();

      // Memory plugin is active.
      const active = orchestrator.pluginRegistry!.activeIn('memory');
      expect(active.map((s) => s.manifest.pluginId)).toEqual(['vinyan.default.memory']);

      // Orchestrator is fully wired (executeTask exposed) — the tool
      // registration is synchronous w/ the pluginsReady resolution. The
      // cleanest probe without running the full pipeline is to assert that
      // the init surfaced no skill-tool-related warnings.
      expect(typeof orchestrator.executeTask).toBe('function');

      // Also: no spurious warnings about skill tool registration.
      const skillWarnings = (orchestrator.pluginWarnings ?? []).filter((w) => w.includes('skill'));
      expect(skillWarnings).toEqual([]);
    } finally {
      await orchestrator.close();
    }
  });

  test('gateway enabled: factory threads executeTask closure + config into initializePlugins', async () => {
    writeConfigWithGateway();
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    try {
      const init = await orchestrator.pluginsReady!;
      // Dispatcher constructed — proves factory passed executeTask through.
      expect(init.dispatcher).toBeDefined();
      // No `executeTask not provided` warning (that path would've fired if
      // the factory forgot to thread the closure).
      const bad = init.warnings.find((w) => w.includes('executeTask not provided'));
      expect(bad).toBeUndefined();

      // Stub executeTask on the live orchestrator. The factory's deferred
      // closure re-reads `orchestrator.executeTask` at dispatch time, so our
      // replacement is honoured even though it was set AFTER the factory
      // returned.
      const calls: string[] = [];
      orchestrator.executeTask = async (input) => {
        calls.push(input.source ?? '');
        return {
          id: input.id,
          status: 'completed',
          response: 'ok',
          routingLevel: 0,
          artifacts: [],
          traceId: 't',
        } as never;
      };

      // Emit a paired inbound envelope directly — no adapter running, but
      // the dispatcher is subscribed to the bus and that's what we want to
      // verify. The bus event is typed against the structural minimum; the
      // dispatcher re-parses via Zod so we need the fuller shape. Cast
      // bridges the declared-narrower-vs-wider gap.
      orchestrator.bus.emit('gateway:inbound', {
        envelope: {
          envelopeId: '00000000-0000-4000-8000-000000000042',
          platform: 'telegram',
          profile: 'default',
          receivedAt: Date.now(),
          text: 'ping',
          chat: { id: '1', kind: 'dm' },
          sender: {
            platformUserId: 'u-1',
            displayName: 'T',
            gatewayUserId: null,
            trustTier: 'paired',
          },
          message: { text: 'ping', attachments: [] },
          hypothesis: {
            claim: 'ping',
            confidence: 'unknown',
            evidence: [{ kind: 'user-message', hash: 'h' }],
          },
        } as never,
      });

      // Give the dispatcher's async handler a tick.
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toEqual(['gateway-telegram']);
    } finally {
      await orchestrator.close();
    }
  });

  test('building factory twice does not duplicate plugin slots or double-migrate', async () => {
    writeConfig(true);
    const orch1 = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    await orch1.pluginsReady;
    await orch1.close();

    const orch2 = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    await orch2.pluginsReady;

    try {
      // Second build still produces a registry with exactly one active memory.
      const active = orch2.pluginRegistry!.activeIn('memory');
      expect(active).toHaveLength(1);
      expect(active[0]!.manifest.pluginId).toBe('vinyan.default.memory');
      // List should contain the single internal memory plugin; no dupes.
      const memSlots = orch2.pluginRegistry!.list().filter((s) => s.manifest.pluginId === 'vinyan.default.memory');
      expect(memSlots).toHaveLength(1);
    } finally {
      await orch2.close();
    }
  });
});

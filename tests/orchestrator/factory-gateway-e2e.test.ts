/**
 * Factory ↔ Gateway end-to-end — closes the last W2 integration seam.
 *
 * Goal: prove that `createOrchestrator` alone is sufficient to stand up a
 * working Telegram gateway. Specifically, when a workspace enables
 * `plugins.enabled` + `gateway.enabled` + `gateway.telegram.{enabled,botToken}`,
 * the factory must:
 *   1. Thread `executeTask` + `gatewayConfig` into `initializePlugins` so the
 *      dispatcher is constructed.
 *   2. Call `lifecycle.startAll()` after plugins resolve so the bundled
 *      Telegram adapter enters its poll loop (observable via mock fetch).
 *   3. Route the dispatcher's `executeTask` call back through the live
 *      orchestrator — i.e. the deferred closure is wired.
 *   4. Deliver replies through `lifecycle.deliver` → adapter.deliver →
 *      Telegram sendMessage.
 *   5. On `close()`, stop adapters (no lingering polls) and unsubscribe the
 *      dispatcher from the bus.
 *
 * The test uses an injectable fetch that records calls so we can assert the
 * HTTP shape without touching the real network. `orchestrator.executeTask`
 * is replaced after construction — the factory's deferred closure re-reads
 * the field at call time so test stubs are honoured.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

let tempDir: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-factory-gw-e2e-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterEach(() => {
  // Restore fetch in case a test swapped it on the global.
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

function makeRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: '{}' }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: '{}' }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: '{}' }));
  return registry;
}

function writeGatewayConfig(): void {
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
      gateway: {
        enabled: true,
        telegram: {
          enabled: true,
          botToken: 'test-token',
          allowedChats: [],
          pollTimeoutSec: 1,
        },
      },
    }),
  );
}

// ── Recording mock fetch ─────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: unknown;
}

function makeMockFetch(): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  // Typed as `unknown` → `typeof fetch` cast because Bun's `fetch` type
  // carries a `preconnect` side-channel that's irrelevant here.
  const mockFetch = (async (input: string | Request | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const bodyRaw = init?.body;
    const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : bodyRaw;
    calls.push({ url, body });

    // getUpdates — return an empty list forever (adapter keeps polling).
    // Small delay mimics Telegram's long-poll behaviour; without it the
    // adapter's poll loop would spin instantly and starve the event loop.
    if (url.includes('/getUpdates')) {
      await new Promise((r) => {
        const t = setTimeout(r, 50);
        (t as unknown as { unref?: () => void }).unref?.();
      });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // deleteWebhook — return OK.
    if (url.includes('/deleteWebhook')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // sendMessage — return a canned message id so the adapter's deliver()
    // succeeds.
    if (url.includes('/sendMessage')) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 12345,
            chat: { id: 111, type: 'private' },
            from: { id: 222, is_bot: true, username: 'vinyan_bot' },
            date: Math.floor(Date.now() / 1000),
            text: 'x',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // Default — 404 so anything unexpected fails visibly.
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetch: mockFetch, calls };
}

// Give the pair-and-deliver async chain enough ticks to settle.
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe('Factory ↔ Gateway e2e', () => {
  test('gateway enabled: plugin wiring, startAll, dispatcher → executeTask → reply', async () => {
    writeGatewayConfig();

    const mock = makeMockFetch();
    // The bundled TelegramAdapter is constructed inside plugin-init without
    // a chance to pass `fetchImpl`. Swapping `globalThis.fetch` is the
    // least-invasive way to substitute the HTTP surface.
    globalThis.fetch = mock.fetch;

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });

    try {
      // Wait for plugin init to resolve.
      expect(orchestrator.pluginsReady).toBeDefined();
      await orchestrator.pluginsReady!;

      // Telegram adapter should be registered + active in the registry.
      const active = orchestrator.pluginRegistry!.activeIn('messaging-adapter');
      expect(active.map((s) => s.manifest.pluginId)).toContain('vinyan.bundled.telegram');

      // `startAll()` fires asynchronously inside factory; wait for at least
      // one `getUpdates` call to confirm the adapter's poll loop is live.
      const polled = await waitUntil(() => mock.calls.some((c) => c.url.includes('/getUpdates')), 2_000);
      expect(polled).toBe(true);

      // Stub executeTask on the live orchestrator — the factory's deferred
      // closure re-reads this at call time, so the dispatcher sees our stub.
      const executeCalls: TaskInput[] = [];
      const originalExecute = orchestrator.executeTask.bind(orchestrator);
      orchestrator.executeTask = async (input: TaskInput): Promise<TaskResult> => {
        executeCalls.push(input);
        return {
          id: input.id,
          status: 'completed',
          response: 'gateway-reply',
          routingLevel: 0,
          artifacts: [],
          traceId: 't-1',
        } as unknown as TaskResult;
      };
      // Keep `originalExecute` alive as a local reference so eslint doesn't
      // complain and so the test documents the shadowing pattern.
      void originalExecute;

      // Drive an inbound envelope through the bus directly — Telegram's
      // adapter always tags messages with `trustTier:'unknown'`, which would
      // detour through the pairing flow. The contract we're validating here
      // is the factory's wiring (dispatcher subscribed + executeTask routed
      // + reply delivered), so we hand the dispatcher a paired envelope.
      const inbound = {
        envelopeId: '00000000-0000-4000-8000-00000000abcd',
        platform: 'telegram' as const,
        profile: 'default',
        receivedAt: Date.now(),
        text: 'hello from test',
        chat: { id: '111', kind: 'dm' as const },
        sender: {
          platformUserId: 'user-1',
          displayName: 'Tester',
          gatewayUserId: null,
          trustTier: 'paired' as const,
        },
        message: {
          text: 'hello from test',
          attachments: [],
        },
        hypothesis: {
          claim: 'hello from test',
          confidence: 'unknown' as const,
          evidence: [{ kind: 'user-message' as const, hash: 'abc' }],
        },
      };
      orchestrator.bus.emit('gateway:inbound', { envelope: inbound as never });

      // executeTask should fire.
      const delivered = await waitUntil(
        () => executeCalls.length >= 1 && mock.calls.some((c) => c.url.includes('/sendMessage')),
        2_000,
      );
      expect(delivered).toBe(true);

      expect(executeCalls).toHaveLength(1);
      expect(executeCalls[0]!.source).toBe('gateway-telegram');
      expect(executeCalls[0]!.profile).toBe('default');
      expect(executeCalls[0]!.goal).toBe('hello from test');

      const sendCall = mock.calls.find((c) => c.url.includes('/sendMessage'));
      expect(sendCall).toBeDefined();
      const sendBody = sendCall!.body as { chat_id: string; text: string };
      expect(sendBody.chat_id).toBe('111');
      expect(sendBody.text).toContain('gateway-reply');
    } finally {
      await orchestrator.close();
    }

    // After close(), the adapter should have stopped polling — no fresh
    // `getUpdates` calls after a short settle period.
    const closedAt = mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    const newCalls = mock.calls.length - closedAt;
    // We accept 0 or a very small number (an in-flight poll that finishes).
    expect(newCalls).toBeLessThanOrEqual(1);
  });

  test('gateway enabled but botToken missing: factory still bootable; warnings record the miss', async () => {
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
        gateway: {
          enabled: true,
          telegram: {
            enabled: true,
            // botToken intentionally omitted
            allowedChats: [],
            pollTimeoutSec: 1,
          },
        },
      }),
    );

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
    });
    try {
      const init = await orchestrator.pluginsReady!;
      // Dispatcher is still built (gateway.enabled=true + executeTask wired);
      // only the telegram adapter was skipped.
      expect(init.dispatcher).toBeDefined();
      const warnings = init.warnings.join(' | ');
      expect(warnings).toContain('botToken absent');
      // No active messaging-adapter plugins because registration never
      // happened.
      expect(init.registry.activeIn('messaging-adapter')).toHaveLength(0);
    } finally {
      await orchestrator.close();
    }
  });
});

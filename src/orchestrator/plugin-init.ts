/**
 * plugin-init — assemble the W2 PluginRegistry + its bundled providers.
 *
 * Pure helper called by `factory.ts` only when `config.plugins.enabled` is
 * true. Separating this out keeps the factory's existing assembly path
 * byte-for-byte untouched for callers that leave the feature flag off.
 *
 * What this module does (in spec order):
 *   1. Build `PluginAuditStore(db)`.
 *   2. Build `InprocLoader({ allowedVinyanApi, log })`.
 *   3. Build a permissive-aware `TrustConfig` (empty publishers in MVP).
 *   4. Build `PluginRegistry({ loader, trust, auditStore, profile })`.
 *   5. Optionally register + activate `DefaultMemoryProvider` via
 *      `registerDefaultMemory(...)` (now backed by `ingestInternal`).
 *   6. Optionally register the three SKILL.md tools onto the provided
 *      toolRegistry.
 *   7. Discover external plugins and `registry.ingest(...)` them.
 *      Optionally auto-activate each `messaging-adapter` plugin loaded.
 *   8. Build a `MessagingAdapterLifecycleManager`.
 *
 * Any failure at step 5/6/7 is captured in `warnings` (never thrown) —
 * the factory must remain bootable even if one plugin misbehaves.
 *
 * Axioms touched:
 *   A3 — orchestration of construction is deterministic: fixed ordering,
 *        rule-based cardinality. No LLM.
 *   A5 — internal `DefaultMemoryProvider` lands with `deterministic` tier;
 *        external plugins get their tier from
 *        `effectiveTrustTier(integrity, signature, permissive)`.
 *   A6 — permissive external loads demote to `speculative` — never elevated.
 */
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { GatewayConfig, PluginsConfig } from '../config/schema.ts';
import type { VinyanBus } from '../core/bus.ts';
import { GatewayIdentityStore } from '../db/gateway-identity-store.ts';
import { PluginAuditStore } from '../db/plugin-audit-store.ts';
import { TelegramAdapter } from '../gateway/adapters/telegram.ts';
import { GatewayDispatcher } from '../gateway/dispatcher.ts';
import { MessagingAdapterLifecycleManager } from '../gateway/lifecycle.ts';
import { registerTelegramAdapter } from '../gateway/register-telegram.ts';
import { GatewayRateLimiter, type RateLimitConfig } from '../gateway/security/rate-limiter.ts';
import type { GatewayInboundEnvelopeMinimal } from '../gateway/types.ts';
import { DefaultMemoryProvider } from '../memory/provider/default-provider.ts';
import { registerDefaultMemory } from '../memory/provider/register.ts';
import { discoverPlugins } from '../plugin/discovery.ts';
import { InprocLoader } from '../plugin/loader.ts';
import { PluginRegistry } from '../plugin/registry.ts';
import type { TrustConfig } from '../plugin/signature.ts';
import { DiscordAdapter } from '../gateway/adapters/discord.ts';
import { SlackAdapter } from '../gateway/adapters/slack.ts';
import { registerDiscordAdapter } from '../gateway/register-discord.ts';
import { registerSlackAdapter } from '../gateway/register-slack.ts';
import { SkillArtifactStore } from '../skills/artifact-store.ts';
import { registerSessionSearchTool } from './tools/register-session-search.ts';
import { registerSkillTools } from './tools/register-skill-tools.ts';
import type { Tool } from './tools/tool-interface.ts';
import type { TaskInput, TaskResult } from './types.ts';

// ── Types ────────────────────────────────────────────────────────────────

export interface PluginInitOptions {
  readonly db: Database;
  readonly profile: string;
  readonly bus: VinyanBus;
  /** Built-in tool registry. `registerSkillTools` mutates this map. */
  readonly toolRegistry: Map<string, Tool>;
  readonly pluginConfig: PluginsConfig;
  /**
   * Gateway config. Optional — when absent or `gateway.enabled=false`,
   * the gateway is left un-wired and `result.dispatcher` is `undefined`. The
   * lifecycle manager is still returned so bundled adapters could be
   * discovered via plugin config alone (rare, but supported).
   */
  readonly gatewayConfig?: GatewayConfig;
  /**
   * Reply path into the core loop. Required when `gateway.enabled=true` in
   * order to construct the `GatewayDispatcher`. When omitted AND Gateway is
   * enabled, we log a warning and skip dispatcher construction rather than
   * throwing — keeps the factory bootable during the wiring transition. See
   * follow-up task #18: factory is expected to supply this closure.
   */
  readonly executeTask?: (input: TaskInput) => Promise<TaskResult>;
  /** Resolved $VINYAN_HOME (absolute). Used for discovery path #2. */
  readonly vinyanHome: string;
  /** Resolved profile root. Skill artifacts live under `<profileRoot>/skills`. */
  readonly profileRoot: string;
  /** Current Vinyan API version (for `vinyanApi` matching in InprocLoader). */
  readonly vinyanApiVersion?: string;
  /**
   * Optional cwd override for external plugin discovery. Defaults to
   * `process.cwd()`. Exposed for tests that need to point discovery at a
   * synthetic fixture directory without chdir'ing the test process.
   */
  readonly discoveryCwd?: string;
}

export interface PluginInitResult {
  readonly registry: PluginRegistry;
  readonly lifecycle: MessagingAdapterLifecycleManager;
  readonly memoryRegistered: boolean;
  readonly memoryActivated: boolean;
  readonly skillToolsRegistered: boolean;
  readonly sessionSearchRegistered: boolean;
  /**
   * Gateway dispatcher, constructed only when `gateway.enabled=true` AND an
   * `executeTask` closure was provided. Callers wire teardown via
   * `dispatcher.stop()` in their shutdown path.
   */
  readonly dispatcher?: GatewayDispatcher;
  readonly warnings: readonly string[];
}

// ── Entry ────────────────────────────────────────────────────────────────

/**
 * Assemble the plugin subsystem. Call only when
 * `config.plugins?.enabled === true`. Returns a fully-constructed registry
 * and a lifecycle manager ready to `startAll()`.
 */
export async function initializePlugins(opts: PluginInitOptions): Promise<PluginInitResult> {
  const warnings: string[] = [];
  const log = makeLogSink();

  // 1. Audit store — writes plugin_audit rows on every FSM transition.
  const auditStore = new PluginAuditStore(opts.db);

  // 2. Loader — integrity + signature + API-version gate for external plugins.
  const loader = new InprocLoader({
    allowedVinyanApi: opts.vinyanApiVersion ?? '*',
  });

  // 3. Trust config — empty publishers in MVP (signature verification is a
  // stub; see src/plugin/signature.ts docblock). Permissive flag demotes
  // unsigned plugins to `speculative` instead of refusing them.
  const trust: TrustConfig = {
    publishers: [],
    permissive: opts.pluginConfig.permissive,
  };

  // 4. Registry — FSM + cardinality + audit.
  const registry = new PluginRegistry({
    loader,
    trust,
    auditStore,
    profile: opts.profile,
  });

  // 5. DefaultMemoryProvider registration.
  let memoryRegistered = false;
  let memoryActivated = false;
  if (opts.pluginConfig.activateMemory) {
    try {
      const provider = new DefaultMemoryProvider({ db: opts.db });
      const result = await registerDefaultMemory({
        registry,
        provider,
        activate: true,
      });
      memoryRegistered = result.registered;
      memoryActivated = result.activated;
      if (!result.registered && result.pending) {
        warnings.push(`memory provider not registered: ${result.pending}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`memory provider registration failed: ${msg}`);
    }
  }

  // 6. Skill tools.
  let skillToolsRegistered = false;
  if (opts.pluginConfig.registerSkillTools) {
    try {
      const artifactStore = new SkillArtifactStore({
        rootDir: join(opts.profileRoot, 'skills'),
      });
      registerSkillTools({
        toolRegistry: opts.toolRegistry,
        deps: { artifactStore },
      });
      skillToolsRegistered = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`skill tools registration failed: ${msg}`);
    }
  }

  // 6.5. Session search tool — FTS5 over memory_records (migration 003).
  // User-invocable historical recall without cluttering active memory (A4).
  let sessionSearchRegistered = false;
  if (opts.pluginConfig.registerSessionSearch !== false) {
    try {
      registerSessionSearchTool({
        toolRegistry: opts.toolRegistry,
        deps: { db: opts.db },
      });
      sessionSearchRegistered = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`session_search registration failed: ${msg}`);
    }
  }

  // 7. External plugin discovery + ingest.
  try {
    const discovered = await discoverPlugins({
      cwd: opts.discoveryCwd ?? process.cwd(),
      vinyanHome: opts.vinyanHome,
      onWarn: (w) => warnings.push(`plugin discovery (${w.source}): ${w.kind} — ${w.detail}`),
    });
    if (discovered.length > 0) {
      await registry.ingest(discovered);
    }
    if (opts.pluginConfig.autoActivateMessagingAdapters) {
      for (const slot of registry.list()) {
        if (slot.manifest.category !== 'messaging-adapter') continue;
        if (slot.state !== 'loaded') continue;
        try {
          await registry.activate(slot.manifest.pluginId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`auto-activate '${slot.manifest.pluginId}' failed: ${msg}`);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`plugin discovery/ingest failed: ${msg}`);
  }

  // 8. Lifecycle manager — wires onInbound to the bus.
  const lifecycle = new MessagingAdapterLifecycleManager({
    registry,
    profile: opts.profile,
    log,
    onInbound: (envelope: GatewayInboundEnvelopeMinimal) => {
      opts.bus.emit('gateway:inbound', { envelope });
    },
  });

  // 9. Messaging gateway — register bundled Telegram + construct dispatcher.
  //
  // The dispatcher closes the ivory-tower loop: adapters publish envelopes to
  // the bus, the dispatcher is the ONLY subscriber, and it routes replies back
  // through `lifecycle.deliver`. Wiring order matters — the dispatcher's
  // `deliverReply` callback must resolve to a lifecycle that's already
  // constructed, hence step 9 follows step 8.
  const dispatcher = opts.gatewayConfig?.enabled
    ? await wireGateway({
        gatewayConfig: opts.gatewayConfig,
        executeTask: opts.executeTask,
        registry,
        lifecycle,
        bus: opts.bus,
        db: opts.db,
        log,
        warnings,
      })
    : undefined;

  return {
    registry,
    lifecycle,
    memoryRegistered,
    memoryActivated,
    skillToolsRegistered,
    sessionSearchRegistered,
    dispatcher,
    warnings,
  };
}

// ── Gateway wiring helpers ───────────────────────────────────────────────

type LogSink = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;

interface WireGatewayInput {
  readonly gatewayConfig: GatewayConfig;
  readonly executeTask?: (input: TaskInput) => Promise<TaskResult>;
  readonly registry: PluginRegistry;
  readonly lifecycle: MessagingAdapterLifecycleManager;
  readonly bus: VinyanBus;
  readonly db: Database;
  readonly log: LogSink;
  readonly warnings: string[];
}

/**
 * Construct the messaging gateway: register the bundled Telegram adapter when
 * configured, then build + start the dispatcher. Every failure is captured
 * into `warnings` — the host must remain bootable even when the gateway misbehaves.
 */
async function wireGateway(input: WireGatewayInput): Promise<GatewayDispatcher | undefined> {
  await maybeRegisterTelegram(input);
  await maybeRegisterSlack(input);
  await maybeRegisterDiscord(input);

  // Dispatcher — needs `executeTask` to dispatch inbound envelopes through
  // the core loop. When the caller hasn't threaded `executeTask` through yet
  // (factory wiring is a follow-up), we skip dispatcher construction and
  // record a warning. Adapters still register, envelopes still land on the
  // bus; they just don't trigger task execution.
  if (!input.executeTask) {
    input.warnings.push(
      'gateway.enabled but executeTask not provided — dispatcher not constructed; ' +
        'inbound envelopes will emit to bus with no converger',
    );
    return undefined;
  }

  try {
    return buildDispatcher({ ...input, executeTask: input.executeTask });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.warnings.push(`gateway dispatcher construction failed: ${msg}`);
    return undefined;
  }
}

/**
 * Best-effort bundled Telegram adapter registration. Missing token is a
 * warning, not a hard error — the gateway still starts; the adapter just
 * won't register.
 */
async function maybeRegisterTelegram(input: WireGatewayInput): Promise<void> {
  const telegramCfg = input.gatewayConfig.telegram;
  if (!telegramCfg?.enabled) return;

  if (!telegramCfg.botToken) {
    input.warnings.push('gateway.telegram.enabled but botToken absent — telegram adapter not registered');
    return;
  }

  try {
    const adapter = new TelegramAdapter({
      botToken: telegramCfg.botToken,
      allowedChats: telegramCfg.allowedChats,
      pollTimeoutSec: telegramCfg.pollTimeoutSec,
    });
    const result = await registerTelegramAdapter({
      registry: input.registry,
      adapter,
      activate: true,
    });
    if (!result.registered && result.pending) {
      input.warnings.push(`telegram adapter not registered: ${result.pending}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.warnings.push(`telegram adapter registration failed: ${msg}`);
  }
}

/**
 * Best-effort bundled Slack adapter registration. Mirrors Telegram path.
 * Missing tokens → warn + skip (gateway still starts with whatever succeeded).
 */
async function maybeRegisterSlack(input: WireGatewayInput): Promise<void> {
  const slackCfg = input.gatewayConfig.slack;
  if (!slackCfg?.enabled) return;

  if (!slackCfg.appToken || !slackCfg.botToken) {
    input.warnings.push(
      'gateway.slack.enabled but appToken and/or botToken absent — slack adapter not registered',
    );
    return;
  }

  try {
    const adapter = new SlackAdapter({
      appToken: slackCfg.appToken,
      botToken: slackCfg.botToken,
      allowedChannels: slackCfg.allowedChannels,
    });
    const result = await registerSlackAdapter({
      registry: input.registry,
      adapter,
      activate: true,
    });
    if (!result.registered) {
      input.warnings.push('slack adapter not registered (registry refused activation)');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.warnings.push(`slack adapter registration failed: ${msg}`);
  }
}

/**
 * Best-effort bundled Discord adapter registration. Mirrors Telegram path.
 */
async function maybeRegisterDiscord(input: WireGatewayInput): Promise<void> {
  const discordCfg = input.gatewayConfig.discord;
  if (!discordCfg?.enabled) return;

  if (!discordCfg.botToken) {
    input.warnings.push(
      'gateway.discord.enabled but botToken absent — discord adapter not registered',
    );
    return;
  }

  try {
    const adapter = new DiscordAdapter({
      botToken: discordCfg.botToken,
      intents: discordCfg.intents,
      allowedGuilds: discordCfg.allowedGuilds,
    });
    const result = await registerDiscordAdapter({
      registry: input.registry,
      adapter,
      activate: true,
    });
    if (!result.registered) {
      input.warnings.push('discord adapter not registered (registry refused activation)');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    input.warnings.push(`discord adapter registration failed: ${msg}`);
  }
}

/**
 * Construct the dispatcher and start it subscribing to `gateway:inbound`.
 * Separated from `wireGateway` so the complexity stays local — identity store,
 * rate limiter, and the bus-surface cast are all encapsulated here.
 */
function buildDispatcher(
  input: WireGatewayInput & {
    readonly executeTask: (i: TaskInput) => Promise<TaskResult>;
  },
): GatewayDispatcher {
  const identityStore = new GatewayIdentityStore(input.db);
  // Build the rate-limit config as a fresh object — `RateLimitConfig`'s
  // fields are `readonly`, so we can't assign onto a partial in place. Only
  // include sub-buckets the operator actually specified so the limiter falls
  // back to its own defaults.
  const rateLimitOpts: Partial<RateLimitConfig> = {
    ...(input.gatewayConfig.rateLimit?.paired ? { pairedBucket: input.gatewayConfig.rateLimit.paired } : {}),
    ...(input.gatewayConfig.rateLimit?.unpaired ? { unpairedBucket: input.gatewayConfig.rateLimit.unpaired } : {}),
  };
  const rateLimiter = new GatewayRateLimiter(rateLimitOpts);

  // Cast to the dispatcher's structural bus surface. `VinyanBus`'s
  // `gateway:inbound` payload uses the structural minimum, while the
  // dispatcher internally types the subscriber against the full
  // `InboundEnvelope` (since it re-parses via Zod on receipt). The runtime
  // shapes are compatible; the cast only bridges the declared narrower-vs-
  // wider types.
  const dispatcher = new GatewayDispatcher({
    bus: input.bus as unknown as import('../gateway/dispatcher.ts').StructuralBus,
    executeTask: input.executeTask,
    identityStore,
    rateLimiter,
    log: input.log,
    deliverReply: async (env) => {
      await input.lifecycle.deliver(env);
    },
  });
  dispatcher.start();
  return dispatcher;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeLogSink(): (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>,
) => void {
  return (level, msg, meta) => {
    const prefix = `[vinyan:plugins]`;
    const payload = meta ? ` ${JSON.stringify(meta)}` : '';
    if (level === 'error') {
      console.error(`${prefix} ${msg}${payload}`);
    } else if (level === 'warn') {
      console.warn(`${prefix} ${msg}${payload}`);
    } else if (level === 'info') {
      // Silent for normal info — factory callers don't need a chatty startup.
      // Tests can still observe state via return value + audit store.
    } else {
      // debug — silent by default.
    }
  };
}

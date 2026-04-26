/**
 * Gateway — public surface.
 *
 * Consumers (factory, CLI, tests) import from this barrel; internal files
 * are not considered public API.
 */

// Contract surface (shared — owned by factory-integration track)
export {
  isGatewayAdapter,
  type GatewayAdapter,
  type GatewayAdapterContext,
  type GatewayAdapterHealth,
  type GatewayDeliveryReceipt,
  type GatewayInboundEnvelopeMinimal,
  type GatewayOutboundEnvelope,
  type GatewayPlatform,
} from './types.ts';

// Envelope Zod schemas + builder
export {
  AttachmentSchema,
  InboundEnvelopeSchema,
  OutboundEnvelopeSchema,
  MAX_ENVELOPE_ATTACHMENTS,
  MAX_ENVELOPE_TEXT_LEN,
  buildInboundEnvelope,
  toMinimalInbound,
  toMinimalOutbound,
  type Attachment,
  type InboundEnvelope,
  type OutboundEnvelope,
} from './envelope.ts';

// Dispatcher
export {
  GatewayDispatcher,
  type GatewayDispatcherDeps,
  type StructuralBus,
  type LogLevel,
} from './dispatcher.ts';

// Rate limiter
export {
  GatewayRateLimiter,
  type RateLimitBucketConfig,
  type RateLimitConfig,
} from './security/rate-limiter.ts';

// Telegram adapter + API wrapper
export { TelegramAdapter, type TelegramAdapterOptions, splitForTelegram } from './adapters/telegram.ts';
export {
  TelegramApi,
  TelegramApiError,
  type TelegramApiOptions,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramChat,
  type TelegramUser,
  type SendMessageOptions,
} from './adapters/telegram-api.ts';

// Slack adapter + API wrapper
export { SlackAdapter, type SlackAdapterOptions, splitForSlack } from './adapters/slack.ts';
export {
  SlackApi,
  SlackApiError,
  mapSlackChannelKind,
  type SlackApiOptions,
  type SlackConnectionsOpenResult,
  type SlackPostMessageResult,
  type SlackSocketEnvelope,
  type SlackEvent,
  type SlackWebSocketLike,
  type SlackWebSocketCtor,
} from './adapters/slack-api.ts';

// Discord adapter + API wrapper
export { DiscordAdapter, type DiscordAdapterOptions, splitForDiscord } from './adapters/discord.ts';
export {
  DiscordApi,
  DiscordApiError,
  DISCORD_INTENT_BITS,
  computeIntents,
  type DiscordApiOptions,
  type DiscordMessageResult,
  type DiscordGatewayPayload,
  type DiscordMessageCreateData,
  type DiscordWebSocketLike,
  type DiscordWebSocketCtor,
} from './adapters/discord-api.ts';

// Bundled registration helpers
export {
  registerTelegramAdapter,
  buildTelegramManifest,
  type RegisterTelegramAdapterOptions,
  type RegisterTelegramAdapterResult,
} from './register-telegram.ts';
export {
  registerSlackAdapter,
  buildSlackManifest,
  type RegisterSlackAdapterOptions,
  type RegisterSlackAdapterResult,
} from './register-slack.ts';
export {
  registerDiscordAdapter,
  buildDiscordManifest,
  type RegisterDiscordAdapterOptions,
  type RegisterDiscordAdapterResult,
} from './register-discord.ts';

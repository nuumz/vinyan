/**
 * Gateway — public surface.
 *
 * Consumers (factory, CLI, tests) import from this barrel; internal files
 * are not considered public API.
 */

// Discord adapter + API wrapper
export { DiscordAdapter, type DiscordAdapterOptions, splitForDiscord } from './adapters/discord.ts';
export {
  computeIntents,
  DISCORD_INTENT_BITS,
  DiscordApi,
  DiscordApiError,
  type DiscordApiOptions,
  type DiscordGatewayPayload,
  type DiscordMessageCreateData,
  type DiscordMessageResult,
  type DiscordWebSocketCtor,
  type DiscordWebSocketLike,
} from './adapters/discord-api.ts';
// Slack adapter + API wrapper
export { SlackAdapter, type SlackAdapterOptions, splitForSlack } from './adapters/slack.ts';
export {
  mapSlackChannelKind,
  SlackApi,
  SlackApiError,
  type SlackApiOptions,
  type SlackConnectionsOpenResult,
  type SlackEvent,
  type SlackPostMessageResult,
  type SlackSocketEnvelope,
  type SlackWebSocketCtor,
  type SlackWebSocketLike,
} from './adapters/slack-api.ts';

// Telegram adapter + API wrapper
export { splitForTelegram, TelegramAdapter, type TelegramAdapterOptions } from './adapters/telegram.ts';
export {
  type SendMessageOptions,
  TelegramApi,
  TelegramApiError,
  type TelegramApiOptions,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './adapters/telegram-api.ts';
// Dispatcher
export {
  GatewayDispatcher,
  type GatewayDispatcherDeps,
  type LogLevel,
  type StructuralBus,
} from './dispatcher.ts';
// Envelope Zod schemas + builder
export {
  type Attachment,
  AttachmentSchema,
  buildInboundEnvelope,
  type InboundEnvelope,
  InboundEnvelopeSchema,
  MAX_ENVELOPE_ATTACHMENTS,
  MAX_ENVELOPE_TEXT_LEN,
  type OutboundEnvelope,
  OutboundEnvelopeSchema,
  toMinimalInbound,
  toMinimalOutbound,
} from './envelope.ts';
export {
  buildDiscordManifest,
  type RegisterDiscordAdapterOptions,
  type RegisterDiscordAdapterResult,
  registerDiscordAdapter,
} from './register-discord.ts';
export {
  buildSlackManifest,
  type RegisterSlackAdapterOptions,
  type RegisterSlackAdapterResult,
  registerSlackAdapter,
} from './register-slack.ts';

// Bundled registration helpers
export {
  buildTelegramManifest,
  type RegisterTelegramAdapterOptions,
  type RegisterTelegramAdapterResult,
  registerTelegramAdapter,
} from './register-telegram.ts';
// Rate limiter
export {
  GatewayRateLimiter,
  type RateLimitBucketConfig,
  type RateLimitConfig,
} from './security/rate-limiter.ts';
// Contract surface (shared — owned by factory-integration track)
export {
  type GatewayAdapter,
  type GatewayAdapterContext,
  type GatewayAdapterHealth,
  type GatewayDeliveryReceipt,
  type GatewayInboundEnvelopeMinimal,
  type GatewayOutboundEnvelope,
  type GatewayPlatform,
  isGatewayAdapter,
} from './types.ts';

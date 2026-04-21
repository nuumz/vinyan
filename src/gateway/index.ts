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

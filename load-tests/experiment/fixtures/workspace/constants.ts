export const MAX_ORDER_ITEMS = 50;
export const MIN_PASSWORD_LENGTH = 8;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ORDER_STATUSES = ['pending', 'shipped', 'delivered'] as const;
export const USER_ROLES = ['admin', 'user'] as const;
export const DEFAULT_CURRENCY = 'USD';
export const MAX_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;

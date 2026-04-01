import { EMAIL_REGEX, MAX_ORDER_ITEMS } from './constants.ts';
import type { Order, ValidationResult } from './types.ts';

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

export function validateUser(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['Data must be an object'] };
  }
  const record = data as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.length === 0) {
    errors.push('Name is required');
  }
  if (typeof record.email !== 'string') {
    errors.push('Valid email is required');
  } else if (!isValidEmail(record.email)) {
    errors.push('Valid email is required');
  }
  return { valid: errors.length === 0, errors };
}

export function validateOrder(order: Order): ValidationResult {
  const errors: string[] = [];
  if (order.items.length === 0) {
    errors.push('Order must have at least one item');
  }
  if (order.items.length > MAX_ORDER_ITEMS) {
    errors.push(`Order cannot have more than ${MAX_ORDER_ITEMS} items`);
  }
  if (order.total < 0) {
    errors.push('Order total cannot be negative');
  }
  for (const item of order.items) {
    if (item.quantity <= 0) {
      errors.push(`Item ${item.name} must have positive quantity`);
    }
    if (item.price < 0) {
      errors.push(`Item ${item.name} cannot have negative price`);
    }
  }
  return { valid: errors.length === 0, errors };
}

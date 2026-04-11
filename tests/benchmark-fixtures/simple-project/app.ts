import { divide, PI } from './math.ts';
import type { Result, User } from './types.ts';
import { product, sum } from './utils.ts';

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: 'Cannot average empty array' };
  }
  return { ok: true, value: divide(sum(values), values.length) };
}

export function calculateProduct(values: number[]): number {
  return product(values);
}

export function circleArea(radius: number): number {
  return PI * radius * radius;
}

export function createUser(id: number, name: string, email: string): User {
  return { id, name, email, active: true };
}

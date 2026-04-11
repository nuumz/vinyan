import { add, multiply } from './math.ts';

export function sum(values: number[]): number {
  return values.reduce((acc, v) => add(acc, v), 0);
}

export function product(values: number[]): number {
  return values.reduce((acc, v) => multiply(acc, v), 1);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(x: number, y: number): number {
  return x * y;
}

export function divide(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error("Division by zero");
  return numerator / denominator;
}

export const PI = 3.14159;

import { greet } from './helpers.ts';

// Intentional type error: passing number where string expected
const message: string = greet(42 as unknown as string);

// Intentional type error: assigning string to number
const count: number = 'not a number' as unknown as number;

export { count, message };

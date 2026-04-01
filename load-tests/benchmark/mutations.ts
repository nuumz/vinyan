/**
 * Benchmark mutation cases for Oracle Gate validation.
 * Each case defines a code mutation, which oracles to run, and expected outcome.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface MutationCase {
  id: string;
  description: string;
  workspace: string;
  category: 'valid' | 'invalid';
  setup: (workspace: string) => void;
  teardown: (workspace: string) => void;
  expectedResult: 'valid' | 'invalid';
  oracles: ('ast' | 'type' | 'dep')[];
}

// --- Helpers to snapshot and restore files ---

const snapshots = new Map<string, string>();

function snapshot(workspace: string, relPath: string): void {
  const fullPath = join(workspace, relPath);
  if (existsSync(fullPath)) {
    snapshots.set(fullPath, readFileSync(fullPath, 'utf-8'));
  }
}

function restore(workspace: string, relPath: string): void {
  const fullPath = join(workspace, relPath);
  const original = snapshots.get(fullPath);
  if (original !== undefined) {
    writeFileSync(fullPath, original);
    snapshots.delete(fullPath);
  } else if (existsSync(fullPath)) {
    // File was created by mutation — remove it
    unlinkSync(fullPath);
  }
}

function overwrite(workspace: string, relPath: string, content: string): void {
  snapshot(workspace, relPath);
  writeFileSync(join(workspace, relPath), content);
}

function removeFile(workspace: string, relPath: string): void {
  snapshot(workspace, relPath);
  const fullPath = join(workspace, relPath);
  if (existsSync(fullPath)) unlinkSync(fullPath);
}

function createNewFile(workspace: string, relPath: string, content: string): void {
  // No snapshot since file doesn't exist yet — teardown just removes it
  writeFileSync(join(workspace, relPath), content);
}

// =============================================================================
// VALID mutations — should NOT be blocked (test for false positives)
// =============================================================================

const validMutations: Omit<MutationCase, 'workspace'>[] = [
  {
    id: 'V01',
    description: 'Add new exported function (no callers yet)',
    category: 'valid',
    setup: (ws) => {
      const original = readFileSync(join(ws, 'math.ts'), 'utf-8');
      snapshot(ws, 'math.ts');
      writeFileSync(
        join(ws, 'math.ts'),
        `${original}\nexport function square(n: number): number {\n  return n * n;\n}\n`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V02',
    description: 'Add optional parameter to function',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'math.ts',
        `export function add(a: number, b: number, c?: number): number {
  return a + b + (c ?? 0);
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V03',
    description: 'Rename local variable (no export change)',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'utils.ts',
        `import { add, multiply } from "./math.ts";

export function sum(values: number[]): number {
  return values.reduce((accumulator, val) => add(accumulator, val), 0);
}

export function product(values: number[]): number {
  return values.reduce((accumulator, val) => multiply(accumulator, val), 1);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'utils.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V04',
    description: 'Add new import that exists',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'server.ts',
        `import { createUser } from "./app.ts";
import { capitalize } from "./utils.ts";
import type { Config } from "./types.ts";

const defaultConfig: Config = {
  port: 3000,
  debug: false,
  database: "sqlite://local.db",
};

export function startServer(config: Config = defaultConfig): void {
  const admin = createUser(1, capitalize("admin"), "admin@example.com");
  console.log(\`Server starting on port \${config.port}\`, admin);
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'server.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V05',
    description: 'Add return type annotation',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'utils.ts',
        `import { add, multiply } from "./math.ts";

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
`,
      );
    },
    teardown: (ws) => restore(ws, 'utils.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V06',
    description: 'Extract inline logic to helper function',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

function safeDiv(a: number, b: number): Result<number> {
  if (b === 0) return { ok: false, error: "Division by zero" };
  return { ok: true, value: divide(a, b) };
}

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
  }
  return safeDiv(sum(values), values.length);
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V07',
    description: 'Add new file with new exports',
    category: 'valid',
    setup: (ws) => {
      createNewFile(
        ws,
        'logger.ts',
        `export function log(message: string): void {
  console.log(\`[\${new Date().toISOString()}] \${message}\`);
}

export function error(message: string): void {
  console.error(\`[ERROR] \${message}\`);
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'logger.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V08',
    description: 'Add new interface to types file',
    category: 'valid',
    setup: (ws) => {
      const original = readFileSync(join(ws, 'types.ts'), 'utf-8');
      snapshot(ws, 'types.ts');
      writeFileSync(
        join(ws, 'types.ts'),
        `${original}\nexport interface Session {\n  token: string;\n  expiresAt: number;\n}\n`,
      );
    },
    teardown: (ws) => restore(ws, 'types.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V09',
    description: 'Add default parameter value',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'utils.ts',
        `import { add, multiply } from "./math.ts";

export function sum(values: number[]): number {
  return values.reduce((acc, v) => add(acc, v), 0);
}

export function product(values: number[]): number {
  return values.reduce((acc, v) => multiply(acc, v), 1);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function clamp(value: number, min: number = 0, max: number = 100): number {
  return Math.min(Math.max(value, min), max);
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'utils.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V10',
    description: 'Add JSDoc comments to functions',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'math.ts',
        `/** Add two numbers */
export function add(a: number, b: number): number {
  return a + b;
}

/** Subtract b from a */
export function subtract(a: number, b: number): number {
  return a - b;
}

/** Multiply two numbers */
export function multiply(x: number, y: number): number {
  return x * y;
}

/** Divide numerator by denominator */
export function divide(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error("Division by zero");
  return numerator / denominator;
}

export const PI = 3.14159;
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V11',
    description: 'Change function implementation without changing signature',
    category: 'valid',
    setup: (ws) => {
      overwrite(
        ws,
        'math.ts',
        `export function add(a: number, b: number): number {
  // Optimized implementation
  return Number(a) + Number(b);
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V12',
    description: 'Add type guard function',
    category: 'valid',
    setup: (ws) => {
      const original = readFileSync(join(ws, 'types.ts'), 'utf-8');
      snapshot(ws, 'types.ts');
      writeFileSync(
        join(ws, 'types.ts'),
        original +
          "\nexport function isUser(value: unknown): value is User {\n  return typeof value === 'object' && value !== null && 'id' in value && 'name' in value;\n}\n",
      );
    },
    teardown: (ws) => restore(ws, 'types.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'V13',
    description: 'Add enum declaration',
    category: 'valid',
    setup: (ws) => {
      const original = readFileSync(join(ws, 'types.ts'), 'utf-8');
      snapshot(ws, 'types.ts');
      writeFileSync(
        join(ws, 'types.ts'),
        `${original}\nexport enum Status {\n  Active = 'active',\n  Inactive = 'inactive',\n}\n`,
      );
    },
    teardown: (ws) => restore(ws, 'types.ts'),
    expectedResult: 'valid',
    oracles: ['ast', 'type'],
  },
];

// =============================================================================
// INVALID mutations — should be caught (test for true positives)
// =============================================================================

const invalidMutations: Omit<MutationCase, 'workspace'>[] = [
  {
    id: 'I01',
    description: "Reference function that doesn't exist",
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
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

// BUG: nonExistentFunction doesn't exist anywhere
export const result = nonExistentFunction(42);
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I02',
    description: 'Wrong number of arguments to function call',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
  }
  // BUG: add takes 2 args, calling with 3
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

// BUG: divide takes 2 args, calling with 3
export const badCall = divide(1, 2, 3);
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I03',
    description: 'Import from non-existent module',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import { phantom } from "./phantom.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'I04',
    description: 'Type mismatch in function argument',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
  }
  // BUG: passing string where number expected
  const label: string = "ten";
  return { ok: true, value: divide(label, values.length) };
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I05',
    description: 'Remove exported function still used by importers',
    category: 'invalid',
    setup: (ws) => {
      // Remove 'add' from math.ts but utils.ts still imports it
      overwrite(
        ws,
        'math.ts',
        `export function subtract(a: number, b: number): number {
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'invalid',
    oracles: ['ast', 'type', 'dep'],
  },
  {
    id: 'I06',
    description: 'Change function signature breaking callers (add required param)',
    category: 'invalid',
    setup: (ws) => {
      // Change add to require 3 args, but callers (utils.ts) still call with 2
      overwrite(
        ws,
        'math.ts',
        `export function add(a: number, b: number, c: number): number {
  return a + b + c;
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'invalid',
    oracles: ['ast', 'type', 'dep'],
  },
  {
    id: 'I07',
    description: 'Add circular import',
    category: 'invalid',
    setup: (ws) => {
      // math.ts imports from utils.ts, and utils.ts already imports from math.ts
      overwrite(
        ws,
        'math.ts',
        `import { capitalize } from "./utils.ts";

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

export const label = capitalize("math");
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'invalid',
    oracles: ['dep'],
  },
  {
    id: 'I08',
    description: 'Assign string to number variable',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

// BUG: string assigned to number
const myNumber: number = "not a number";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I09',
    description: 'Delete file that others import',
    category: 'invalid',
    setup: (ws) => {
      // Remove math.ts — utils.ts, app.ts, server.ts all depend on it (directly or transitively)
      removeFile(ws, 'math.ts');
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'invalid',
    oracles: ['type', 'dep'],
  },
  {
    id: 'I10',
    description: 'Rename export without updating importers',
    category: 'invalid',
    setup: (ws) => {
      // Rename 'add' to 'addNumbers' in math.ts but utils.ts still imports 'add'
      overwrite(
        ws,
        'math.ts',
        `export function addNumbers(a: number, b: number): number {
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
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'invalid',
    oracles: ['ast', 'type'],
  },
  {
    id: 'I11',
    description: 'Import non-exported symbol',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'server.ts',
        `import { createUser } from "./app.ts";
import { internalHelper } from "./utils.ts";
import type { Config } from "./types.ts";

const defaultConfig: Config = {
  port: 3000,
  debug: false,
  database: "sqlite://local.db",
};

export function startServer(config: Config = defaultConfig): void {
  const admin = createUser(1, "admin", "admin@example.com");
  console.log(\`Server starting on port \${config.port}\`, admin);
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'server.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I12',
    description: 'Duplicate export name',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'math.ts',
        `export function add(a: number, b: number): number {
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

// BUG: duplicate function name
export function add(x: number, y: number): number {
  return x + y;
}

export const PI = 3.14159;
`,
      );
    },
    teardown: (ws) => restore(ws, 'math.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I13',
    description: 'Return type mismatch (number returned as string)',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
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

// BUG: returns number where string is declared
export function getData(): string {
  return 42;
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I14',
    description: "Use interface field that doesn't exist",
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
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

// BUG: User interface has no 'role' field
export function getUserRole(user: User): string {
  return user.role;
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I15',
    description: 'Return wrong type from function',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'utils.ts',
        `import { add, multiply } from "./math.ts";

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

// BUG: returns number where string is declared
export function formatValue(n: number): string {
  return n * 2;
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'utils.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I16',
    description: 'Remove required field from object literal matching interface',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
  }
  return { ok: true, value: divide(sum(values), values.length) };
}

export function calculateProduct(values: number[]): number {
  return product(values);
}

export function circleArea(radius: number): number {
  return PI * radius * radius;
}

// BUG: missing 'email' and 'active' fields required by User interface
export function createUser(id: number, name: string, email: string): User {
  return { id, name };
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
  {
    id: 'I17',
    description: 'Call method on possibly undefined value',
    category: 'invalid',
    setup: (ws) => {
      overwrite(
        ws,
        'app.ts',
        `import { sum, product } from "./utils.ts";
import { divide, PI } from "./math.ts";
import type { User, Result } from "./types.ts";

export function calculateAverage(values: number[]): Result<number> {
  if (values.length === 0) {
    return { ok: false, error: "Cannot average empty array" };
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

// BUG: accessing property on possibly undefined (strict + noUncheckedIndexedAccess)
export function getFirst(arr: number[]): string {
  return arr[0].toFixed(2);
}
`,
      );
    },
    teardown: (ws) => restore(ws, 'app.ts'),
    expectedResult: 'invalid',
    oracles: ['type'],
  },
];

/** Build all mutation cases bound to a specific workspace path. */
export function buildMutationCases(workspace: string): MutationCase[] {
  return [...validMutations.map((m) => ({ ...m, workspace })), ...invalidMutations.map((m) => ({ ...m, workspace }))];
}

export const VALID_COUNT = validMutations.length;
export const INVALID_COUNT = invalidMutations.length;
export const TOTAL_COUNT = validMutations.length + invalidMutations.length;

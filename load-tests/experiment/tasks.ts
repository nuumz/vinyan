// ============================================================================
// Vinyan Phase 0 — A/B Experiment Coding Tasks
// 50 tasks, 10 per error category
// ============================================================================

export interface Mutation {
  /** Relative file path within the workspace */
  file: string;
  /** Full file content after this mutation */
  content: string;
}

export interface CodingTask {
  id: string;
  description: string;
  /** Mutation that an ideal agent would produce — must compile cleanly */
  correctMutation: Mutation;
  /** Mutation that a hallucinating agent would produce — must have a structural error */
  incorrectMutation: Mutation;
  /** Category of the structural error in incorrectMutation */
  errorCategory: 'symbol-resolution' | 'signature-mismatch' | 'import-dependency' | 'type-system' | 'structural';
  /** Specific error description */
  errorDetail: string;
}

// ============================================================================
// Task Definitions
// ============================================================================

export const CODING_TASKS: CodingTask[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // Category 1: symbol-resolution (T01–T10)
  // Incorrect mutations reference functions/methods/properties that don't exist
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'T01',
    description: 'Create a helper that fetches a user via UserService',
    correctMutation: {
      file: 'order-helpers.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function fetchUser(svc: UserService, id: number): User | undefined {',
        '  return svc.getUser(id);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'order-helpers.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function fetchUser(svc: UserService, id: number): User | undefined {',
        '  return svc.findUser(id);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'findUser does not exist on UserService; correct method is getUser',
  },

  {
    id: 'T02',
    description: 'Create a function to display an order total as a string',
    correctMutation: {
      file: 'order-display.ts',
      content: [
        'import type { Order } from "./types.ts";',
        '',
        'export function displayTotal(order: Order): string {',
        '  return "Total: " + String(order.total);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'order-display.ts',
      content: [
        'import type { Order } from "./types.ts";',
        '',
        'export function displayTotal(order: Order): string {',
        '  return "Total: " + String(order.amount);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'amount does not exist on Order; correct property is total',
  },

  {
    id: 'T03',
    description: 'Create a currency formatter wrapper using utils',
    correctMutation: {
      file: 'formatters.ts',
      content: [
        'import { formatCurrency } from "./utils.ts";',
        '',
        'export function formatPrice(amount: number): string {',
        '  return "Price: " + formatCurrency(amount);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'formatters.ts',
      content: [
        'import { formatMoney } from "./utils.ts";',
        '',
        'export function formatPrice(amount: number): string {',
        '  return "Price: " + formatMoney(amount);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'formatMoney does not exist in utils; correct function is formatCurrency',
  },

  {
    id: 'T04',
    description: 'Create a function that builds a user greeting',
    correctMutation: {
      file: 'user-greeting.ts',
      content: [
        'import type { User } from "./types.ts";',
        '',
        'export function greetUser(user: User): string {',
        '  return "Hello, " + user.name;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-greeting.ts',
      content: [
        'import type { User } from "./types.ts";',
        '',
        'export function greetUser(user: User): string {',
        '  return "Hello, " + user.username;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'username does not exist on User; correct property is name',
  },

  {
    id: 'T05',
    description: 'Create a request validator that uses the validators module',
    correctMutation: {
      file: 'request-validator.ts',
      content: [
        'import type { ValidationResult } from "./types.ts";',
        'import { validateUser } from "./validators.ts";',
        '',
        'export function validateRequest(body: unknown): ValidationResult {',
        '  return validateUser(body);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'request-validator.ts',
      content: [
        'import type { ValidationResult } from "./types.ts";',
        'import { validateInput } from "./validators.ts";',
        '',
        'export function validateRequest(body: unknown): ValidationResult {',
        '  return validateInput(body);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'validateInput does not exist in validators; correct function is validateUser',
  },

  {
    id: 'T06',
    description: 'Create a helper to generate unique identifiers for entities',
    correctMutation: {
      file: 'id-helper.ts',
      content: [
        'import { generateId } from "./utils.ts";',
        '',
        'export function createEntityId(prefix: string): string {',
        '  return prefix + "-" + String(generateId());',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'id-helper.ts',
      content: [
        'import { createId } from "./utils.ts";',
        '',
        'export function createEntityId(prefix: string): string {',
        '  return prefix + "-" + String(createId());',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'createId does not exist in utils; correct function is generateId',
  },

  {
    id: 'T07',
    description: 'Create a report function that computes order totals via OrderService',
    correctMutation: {
      file: 'reports.ts',
      content: [
        'import type { OrderItem } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function getItemsTotal(svc: OrderService, items: OrderItem[]): number {',
        '  return svc.calculateTotal(items);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'reports.ts',
      content: [
        'import type { OrderItem } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function getItemsTotal(svc: OrderService, items: OrderItem[]): number {',
        '  return svc.computeTotal(items);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'computeTotal does not exist on OrderService; correct method is calculateTotal',
  },

  {
    id: 'T08',
    description: 'Create an error wrapping utility using AppError',
    correctMutation: {
      file: 'error-wrapper.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        '',
        'export function wrapError(err: unknown): AppError {',
        '  if (err instanceof AppError) return err;',
        '  const msg = err instanceof Error ? err.message : "Unknown";',
        '  return new AppError(msg, "WRAPPED", 500);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'error-wrapper.ts',
      content: [
        'import { ApplicationError } from "./errors.ts";',
        '',
        'export function wrapError(err: unknown): ApplicationError {',
        '  if (err instanceof ApplicationError) return err;',
        '  const msg = err instanceof Error ? err.message : "Unknown";',
        '  return new ApplicationError(msg, "WRAPPED", 500);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'ApplicationError does not exist in errors; correct class is AppError',
  },

  {
    id: 'T09',
    description: 'Create a function that safely gets a user or throws',
    correctMutation: {
      file: 'user-checker.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function requireUser(svc: UserService, id: number): User {',
        '  return svc.getUserOrThrow(id);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-checker.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function requireUser(svc: UserService, id: number): User {',
        '  return svc.getOrFail(id);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'getOrFail does not exist on UserService; correct method is getUserOrThrow',
  },

  {
    id: 'T10',
    description: 'Create an email validation helper using validators module',
    correctMutation: {
      file: 'email-checker.ts',
      content: [
        'import { isValidEmail } from "./validators.ts";',
        '',
        'export function checkEmails(emails: string[]): string[] {',
        '  return emails.filter((e) => isValidEmail(e));',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'email-checker.ts',
      content: [
        'import { checkEmail } from "./validators.ts";',
        '',
        'export function checkEmails(emails: string[]): string[] {',
        '  return emails.filter((e) => checkEmail(e));',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'symbol-resolution',
    errorDetail: 'checkEmail does not exist in validators; correct function is isValidEmail',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Category 2: signature-mismatch (T11–T20)
  // Incorrect mutations call functions with wrong number/types of parameters
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'T11',
    description: 'Create an admin module that provisions new users',
    correctMutation: {
      file: 'admin.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function provisionUser(svc: UserService, name: string, email: string): User {',
        '  return svc.createUser(name, email);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'admin.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function provisionUser(svc: UserService, name: string, email: string): User {',
        '  return svc.createUser(name);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'createUser requires 2 arguments (name, email) but was called with 1',
  },

  {
    id: 'T12',
    description: 'Create a checkout module that creates orders',
    correctMutation: {
      file: 'checkout.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function placeOrder(svc: OrderService, userId: number, items: OrderItem[]): Order {',
        '  return svc.createOrder(userId, items);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'checkout.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function placeOrder(svc: OrderService, userId: number, items: OrderItem[]): Order {',
        '  return svc.createOrder(userId);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'createOrder requires 2 arguments (userId, items) but was called with 1',
  },

  {
    id: 'T13',
    description: 'Create a total calculator that computes order totals',
    correctMutation: {
      file: 'total-calc.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function computeOrderTotal(svc: OrderService, items: OrderItem[]): number {',
        '  return svc.calculateTotal(items);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'total-calc.ts',
      content: [
        'import type { Order } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function computeOrderTotal(svc: OrderService, order: Order): number {',
        '  return svc.calculateTotal(order);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'calculateTotal expects OrderItem[] but was called with Order',
  },

  {
    id: 'T14',
    description: 'Create a user lookup function',
    correctMutation: {
      file: 'user-lookup.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function lookupUser(svc: UserService, id: number): User | undefined {',
        '  return svc.getUser(id);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-lookup.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function lookupUser(svc: UserService, id: string): User | undefined {',
        '  return svc.getUser(id);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'getUser expects number but was called with string',
  },

  {
    id: 'T15',
    description: 'Create a price display function using formatCurrency',
    correctMutation: {
      file: 'price-display.ts',
      content: [
        'import { formatCurrency } from "./utils.ts";',
        '',
        'export function showPrice(amount: number): string {',
        '  return formatCurrency(amount);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'price-display.ts',
      content: [
        'import { formatCurrency } from "./utils.ts";',
        '',
        'export function showPrice(amount: string): string {',
        '  return formatCurrency(amount);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'formatCurrency expects number but was called with string',
  },

  {
    id: 'T16',
    description: 'Create an error factory for not-found errors',
    correctMutation: {
      file: 'error-factory.ts',
      content: [
        'import { NotFoundError } from "./errors.ts";',
        '',
        'export function createNotFound(resource: string, id: number): NotFoundError {',
        '  return new NotFoundError(resource, id);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'error-factory.ts',
      content: [
        'import { NotFoundError } from "./errors.ts";',
        '',
        'export function createNotFound(resource: string, id: number): NotFoundError {',
        '  return new NotFoundError(resource);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'NotFoundError constructor requires 2 arguments (resource, id) but was called with 1',
  },

  {
    id: 'T17',
    description: 'Create a validation error factory',
    correctMutation: {
      file: 'validation-factory.ts',
      content: [
        'import { ValidationError } from "./errors.ts";',
        '',
        'export function createValidationError(messages: string[]): ValidationError {',
        '  return new ValidationError(messages);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'validation-factory.ts',
      content: [
        'import { ValidationError } from "./errors.ts";',
        '',
        'export function createValidationError(message: string): ValidationError {',
        '  return new ValidationError(message);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'ValidationError constructor expects string[] but was called with string',
  },

  {
    id: 'T18',
    description: 'Create an analytics function that groups order items',
    correctMutation: {
      file: 'analytics.ts',
      content: [
        'import type { OrderItem } from "./types.ts";',
        'import { groupBy } from "./utils.ts";',
        '',
        'export function groupItemsByName(items: OrderItem[]): Record<string, OrderItem[]> {',
        '  return groupBy(items, "name");',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'analytics.ts',
      content: [
        'import type { OrderItem } from "./types.ts";',
        'import { groupBy } from "./utils.ts";',
        '',
        'export function groupItemsByName(items: OrderItem[]): Record<string, OrderItem[]> {',
        '  return groupBy(items);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'groupBy requires 2 arguments (items, key) but was called with 1',
  },

  {
    id: 'T19',
    description: 'Create a retry wrapper with configurable attempts',
    correctMutation: {
      file: 'retry-wrapper.ts',
      content: [
        'import { withRetry } from "./middleware.ts";',
        '',
        'export async function retryFetch(url: string): Promise<string> {',
        '  return withRetry(async () => {',
        '    return url;',
        '  }, 5);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'retry-wrapper.ts',
      content: [
        'import { withRetry } from "./middleware.ts";',
        '',
        'export async function retryFetch(url: string): Promise<string> {',
        '  return withRetry(async () => {',
        '    return url;',
        '  }, "5");',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'withRetry maxRetries parameter expects number but was called with string',
  },

  {
    id: 'T20',
    description: 'Create an error throwing utility using AppError',
    correctMutation: {
      file: 'error-thrower.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        '',
        'export function throwServerError(message: string): never {',
        '  throw new AppError(message, "SERVER_ERROR", 500);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'error-thrower.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        '',
        'export function throwServerError(message: string): never {',
        '  throw new AppError(message, 500);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'signature-mismatch',
    errorDetail: 'AppError constructor requires 3 arguments (message, code, statusCode) but was called with 2',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Category 3: import-dependency (T21–T30)
  // Incorrect mutations import from wrong paths or non-existent modules
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'T21',
    description: 'Create a type re-export module for user types',
    correctMutation: {
      file: 'user-models.ts',
      content: [
        'import type { User, UserRole } from "./types.ts";',
        '',
        'export type { User, UserRole };',
        '',
        'export function isAdmin(user: User): boolean {',
        '  return user.role === "admin";',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-models.ts',
      content: [
        'import type { User, UserRole } from "./models.ts";',
        '',
        'export type { User, UserRole };',
        '',
        'export function isAdmin(user: User): boolean {',
        '  return user.role === "admin";',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'Module ./models.ts does not exist; correct path is ./types.ts',
  },

  {
    id: 'T22',
    description: 'Create an error utility that wraps unknown errors',
    correctMutation: {
      file: 'error-utils.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        '',
        'export function toAppError(err: unknown): AppError {',
        '  const msg = err instanceof Error ? err.message : "Unknown error";',
        '  return new AppError(msg, "UNKNOWN", 500);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'error-utils.ts',
      content: [
        'import { AppError } from "./error.ts";',
        '',
        'export function toAppError(err: unknown): AppError {',
        '  const msg = err instanceof Error ? err.message : "Unknown error";',
        '  return new AppError(msg, "UNKNOWN", 500);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'Module ./error.ts does not exist; correct path is ./errors.ts',
  },

  {
    id: 'T23',
    description: 'Create a date formatting helper using utils',
    correctMutation: {
      file: 'date-helper.ts',
      content: [
        'import { formatCurrency } from "./utils.ts";',
        '',
        'export function formatAmount(cents: number): string {',
        '  return formatCurrency(cents / 100);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'date-helper.ts',
      content: [
        'import { formatDate } from "./utils.ts";',
        '',
        'export function formatAmount(cents: number): string {',
        '  return formatDate(cents / 100);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail:
      'formatDate does not exist in ./utils.ts; it only exports formatCurrency, generateId, deepClone, groupBy',
  },

  {
    id: 'T24',
    description: 'Create a service loader that initializes OrderService',
    correctMutation: {
      file: 'service-loader.ts',
      content: [
        'import { OrderService } from "./order-service.ts";',
        'import { UserService } from "./user-service.ts";',
        '',
        'export function createServices() {',
        '  const userService = new UserService();',
        '  const orderService = new OrderService(userService);',
        '  return { userService, orderService };',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'service-loader.ts',
      content: [
        'import { OrderService } from "./services.ts";',
        'import { UserService } from "./user-service.ts";',
        '',
        'export function createServices() {',
        '  const userService = new UserService();',
        '  const orderService = new OrderService(userService);',
        '  return { userService, orderService };',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'Module ./services.ts does not exist; correct path is ./order-service.ts',
  },

  {
    id: 'T25',
    description: 'Create middleware that catches errors and wraps them',
    correctMutation: {
      file: 'catch-middleware.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        '',
        'export function safeParse(json: string): unknown {',
        '  try {',
        '    return JSON.parse(json) as unknown;',
        '  } catch {',
        '    throw new AppError("Invalid JSON", "PARSE_ERROR", 400);',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'catch-middleware.ts',
      content: [
        '',
        'export function safeParse(json: string): unknown {',
        '  try {',
        '    return JSON.parse(json) as unknown;',
        '  } catch {',
        '    throw new AppError("Invalid JSON", "PARSE_ERROR", 400);',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'AppError is used but not imported; missing import from ./errors.ts',
  },

  {
    id: 'T26',
    description: 'Create a validation utility that checks user input',
    correctMutation: {
      file: 'validation-utils.ts',
      content: [
        'import { validateUser } from "./validators.ts";',
        'import type { ValidationResult } from "./types.ts";',
        '',
        'export function checkUserInput(data: unknown): ValidationResult {',
        '  return validateUser(data);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'validation-utils.ts',
      content: [
        'import { validateUser } from "./validator.ts";',
        'import type { ValidationResult } from "./types.ts";',
        '',
        'export function checkUserInput(data: unknown): ValidationResult {',
        '  return validateUser(data);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'Module ./validator.ts does not exist; correct path is ./validators.ts',
  },

  {
    id: 'T27',
    description: 'Create a limits module that re-exports order constraints',
    correctMutation: {
      file: 'limits.ts',
      content: [
        'import { MAX_ORDER_ITEMS } from "./constants.ts";',
        '',
        'export function isWithinLimit(count: number): boolean {',
        '  return count <= MAX_ORDER_ITEMS;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'limits.ts',
      content: [
        'import { MAX_ITEMS } from "./constants.ts";',
        '',
        'export function isWithinLimit(count: number): boolean {',
        '  return count <= MAX_ITEMS;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'MAX_ITEMS does not exist in ./constants.ts; correct export is MAX_ORDER_ITEMS',
  },

  {
    id: 'T28',
    description: 'Create a user adapter that wraps UserService',
    correctMutation: {
      file: 'user-adapter.ts',
      content: [
        'import { UserService } from "./user-service.ts";',
        'import type { User } from "./types.ts";',
        '',
        'export class UserAdapter {',
        '  private svc = new UserService();',
        '  find(id: number): User | undefined { return this.svc.getUser(id); }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-adapter.ts',
      content: [
        'import { UserRepository } from "./user-service.ts";',
        'import type { User } from "./types.ts";',
        '',
        'export class UserAdapter {',
        '  private svc = new UserRepository();',
        '  find(id: number): User | undefined { return this.svc.getUser(id); }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'UserRepository does not exist in ./user-service.ts; correct export is UserService',
  },

  {
    id: 'T29',
    description: 'Create a deep clone utility wrapper',
    correctMutation: {
      file: 'clone-utils.ts',
      content: [
        'import { deepClone } from "./utils.ts";',
        'import type { User } from "./types.ts";',
        '',
        'export function cloneUser(user: User): User {',
        '  return deepClone(user);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'clone-utils.ts',
      content: [
        'import { deepCopy } from "./utils.ts";',
        'import type { User } from "./types.ts";',
        '',
        'export function cloneUser(user: User): User {',
        '  return deepCopy(user);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'deepCopy does not exist in ./utils.ts; correct export is deepClone',
  },

  {
    id: 'T30',
    description: 'Create a config reader module',
    correctMutation: {
      file: 'config-reader.ts',
      content: [
        'import { MAX_RETRIES, RETRY_DELAY_MS } from "./constants.ts";',
        '',
        'export function getRetryConfig() {',
        '  return { maxRetries: MAX_RETRIES, delayMs: RETRY_DELAY_MS };',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'config-reader.ts',
      content: [
        'import { MAX_RETRIES, RETRY_DELAY_MS } from "./config.ts";',
        '',
        'export function getRetryConfig() {',
        '  return { maxRetries: MAX_RETRIES, delayMs: RETRY_DELAY_MS };',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'import-dependency',
    errorDetail: 'Module ./config.ts does not exist; correct path is ./constants.ts',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Category 4: type-system (T31–T40)
  // Incorrect mutations have type mismatches
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'T31',
    description: 'Create a counter that returns the number of users',
    correctMutation: {
      file: 'counter.ts',
      content: [
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function countUsers(svc: UserService): number {',
        '  return svc.listUsers().length;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'counter.ts',
      content: [
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function countUsers(svc: UserService): number {',
        '  return "count: " + String(svc.listUsers().length);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'Function return type is number but returns a string',
  },

  {
    id: 'T32',
    description: 'Create a converter that extracts user from an order context',
    correctMutation: {
      file: 'converter.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import type { UserService } from "./user-service.ts";',
        '',
        'export function getOrderUser(svc: UserService, userId: number): User | undefined {',
        '  const user: User | undefined = svc.getUser(userId);',
        '  return user;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'converter.ts',
      content: [
        'import type { User, Order } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function getOrderUser(svc: OrderService, orderId: number): User | undefined {',
        '  const user: User | undefined = svc.getOrder(orderId);',
        '  return user;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'getOrder returns Order | undefined but is assigned to User | undefined',
  },

  {
    id: 'T33',
    description: 'Create a processor that validates an order',
    correctMutation: {
      file: 'processor.ts',
      content: [
        'import type { Order, ValidationResult } from "./types.ts";',
        'import { validateOrder } from "./validators.ts";',
        '',
        'export function processOrder(order: Order): ValidationResult {',
        '  return validateOrder(order);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'processor.ts',
      content: [
        'import type { OrderItem, ValidationResult } from "./types.ts";',
        'import { validateOrder } from "./validators.ts";',
        '',
        'export function processOrder(item: OrderItem): ValidationResult {',
        '  return validateOrder(item);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'validateOrder expects Order but was called with OrderItem',
  },

  {
    id: 'T34',
    description: 'Create a user factory that builds user objects',
    correctMutation: {
      file: 'user-factory.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import { generateId } from "./utils.ts";',
        '',
        'export function buildUser(name: string, email: string): User {',
        '  return { id: generateId(), name, email, role: "user" };',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-factory.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import { generateId } from "./utils.ts";',
        '',
        'export function buildUser(name: string, email: string): User {',
        '  return { id: generateId(), name, email };',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'Missing required property role when constructing User',
  },

  {
    id: 'T35',
    description: 'Create an order factory with a specific status',
    correctMutation: {
      file: 'order-factory.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import { generateId } from "./utils.ts";',
        '',
        'export function buildOrder(userId: number, items: OrderItem[], total: number): Order {',
        '  return { id: generateId(), userId, items, total, status: "pending" };',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'order-factory.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import { generateId } from "./utils.ts";',
        '',
        'export function buildOrder(userId: number, items: OrderItem[], total: number): Order {',
        '  return { id: generateId(), userId, items, total, status: "processing" };',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: '"processing" is not assignable to OrderStatus ("pending" | "shipped" | "delivered")',
  },

  {
    id: 'T36',
    description: 'Create a function that retrieves an order and asserts it exists',
    correctMutation: {
      file: 'order-getter.ts',
      content: [
        'import type { Order } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function mustGetOrder(svc: OrderService, id: number): Order | undefined {',
        '  return svc.getOrder(id);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'order-getter.ts',
      content: [
        'import type { Order } from "./types.ts";',
        'import type { OrderService } from "./order-service.ts";',
        '',
        'export function mustGetOrder(svc: OrderService, id: number): Order {',
        '  return svc.getOrder(id);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'getOrder returns Order | undefined but function signature promises Order (no undefined)',
  },

  {
    id: 'T37',
    description: 'Create a user updater that changes the user name',
    correctMutation: {
      file: 'user-updater.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import { deepClone } from "./utils.ts";',
        '',
        'export function renameUser(user: User, newName: string): User {',
        '  const clone = deepClone(user);',
        '  clone.name = newName;',
        '  return clone;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-updater.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import { deepClone } from "./utils.ts";',
        '',
        'export function renameUser(user: User, newName: number): User {',
        '  const clone = deepClone(user);',
        '  clone.name = newName;',
        '  return clone;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'name is string but newName is number; Type number is not assignable to type string',
  },

  {
    id: 'T38',
    description: 'Create a user Map with correct key types',
    correctMutation: {
      file: 'user-map.ts',
      content: [
        'import type { User } from "./types.ts";',
        '',
        'export function createUserMap(users: User[]): Map<number, User> {',
        '  const map = new Map<number, User>();',
        '  for (const u of users) { map.set(u.id, u); }',
        '  return map;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-map.ts',
      content: [
        'import type { User } from "./types.ts";',
        '',
        'export function createUserMap(users: User[]): Map<number, User> {',
        '  const map = new Map<string, User>();',
        '  for (const u of users) { map.set(u.id, u); }',
        '  return map;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'Map<string, User> is not assignable to Map<number, User>; id is number but map key is string',
  },

  {
    id: 'T39',
    description: 'Create a function that builds an item list for an order',
    correctMutation: {
      file: 'item-list.ts',
      content: [
        'import type { OrderItem } from "./types.ts";',
        '',
        'export function createItems(): OrderItem[] {',
        '  const items: OrderItem[] = [',
        '    { productId: 1, name: "Widget", quantity: 2, price: 9.99 },',
        '  ];',
        '  return items;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'item-list.ts',
      content: [
        'import type { OrderItem, User } from "./types.ts";',
        '',
        'export function createItems(): OrderItem[] {',
        '  const items: OrderItem[] = [',
        '    { id: 1, name: "Alice", email: "a@b.com", role: "user" as const },',
        '  ];',
        '  return items;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'Object literal with User shape is not assignable to OrderItem (missing productId, quantity, price)',
  },

  {
    id: 'T40',
    description: 'Create a mapper that transforms users to display names',
    correctMutation: {
      file: 'user-mapper.ts',
      content: [
        'import type { User } from "./types.ts";',
        '',
        'export function mapToNames(users: User[]): string[] {',
        '  return users.map((u: User): string => u.name);',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'user-mapper.ts',
      content: [
        'import type { User } from "./types.ts";',
        '',
        'export function mapToNames(users: User[]): string[] {',
        '  return users.map((u: User): string => u.id);',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'type-system',
    errorDetail: 'Callback return type is string but u.id is number',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Category 5: structural (T41–T50)
  // Incorrect mutations have structural TypeScript errors
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: 'T41',
    description: 'Create a re-export module for error classes',
    correctMutation: {
      file: 'error-exports.ts',
      content: [
        'export { AppError, NotFoundError } from "./errors.ts";',
        'export { ValidationError } from "./errors.ts";',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'error-exports.ts',
      content: [
        'export { AppError, NotFoundError } from "./errors.ts";',
        'export { AppError } from "./errors.ts";',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'Duplicate identifier AppError — exported twice from the same file',
  },

  {
    id: 'T42',
    description: 'Create a custom error class that extends AppError',
    correctMutation: {
      file: 'custom-error.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        '',
        'export class TimeoutError extends AppError {',
        '  constructor(operation: string) {',
        '    super("Operation " + operation + " timed out", "TIMEOUT", 408);',
        '    this.name = "TimeoutError";',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'custom-error.ts',
      content: [
        'import { AppError } from "./errors.ts";',
        'import { OrderService } from "./order-service.ts";',
        '',
        'export class TimeoutError extends OrderService {',
        '  constructor(operation: string) {',
        '    super("Operation " + operation + " timed out", "TIMEOUT", 408);',
        '    this.name = "TimeoutError";',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail:
      'TimeoutError extends OrderService which expects UserService in constructor, not (string, string, number)',
  },

  {
    id: 'T43',
    description: 'Create an abstract base service with a concrete implementation',
    correctMutation: {
      file: 'base-service.ts',
      content: [
        'export abstract class BaseService {',
        '  abstract getName(): string;',
        '  abstract getVersion(): number;',
        '  describe(): string {',
        '    return this.getName() + " v" + String(this.getVersion());',
        '  }',
        '}',
        '',
        'export class ConcreteService extends BaseService {',
        '  getName(): string { return "MyService"; }',
        '  getVersion(): number { return 1; }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'base-service.ts',
      content: [
        'export abstract class BaseService {',
        '  abstract getName(): string;',
        '  abstract getVersion(): number;',
        '  describe(): string {',
        '    return this.getName() + " v" + String(this.getVersion());',
        '  }',
        '}',
        '',
        'export class ConcreteService extends BaseService {',
        '  getName(): string { return "MyService"; }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'ConcreteService does not implement abstract method getVersion from BaseService',
  },

  {
    id: 'T44',
    description: 'Create an enhanced user service that extends UserService',
    correctMutation: {
      file: 'enhanced-user.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import { UserService } from "./user-service.ts";',
        '',
        'export class EnhancedUserService extends UserService {',
        '  getUser(id: number): User | undefined {',
        '    const user = super.getUser(id);',
        '    return user;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'enhanced-user.ts',
      content: [
        'import type { User } from "./types.ts";',
        'import { UserService } from "./user-service.ts";',
        '',
        'export class EnhancedUserService extends UserService {',
        '  getUser(id: string): User | undefined {',
        '    const user = super.getUser(Number(id));',
        '    return user;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'getUser(id: string) has incompatible signature with base class getUser(id: number)',
  },

  {
    id: 'T45',
    description: 'Create a class that implements a Serializable interface',
    correctMutation: {
      file: 'serializable.ts',
      content: [
        'export interface Serializable {',
        '  serialize(): string;',
        '  deserialize(data: string): void;',
        '}',
        '',
        'export class JsonSerializable implements Serializable {',
        '  private data: Record<string, unknown> = {};',
        '  serialize(): string { return JSON.stringify(this.data); }',
        '  deserialize(data: string): void { this.data = JSON.parse(data) as Record<string, unknown>; }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'serializable.ts',
      content: [
        'export interface Serializable {',
        '  serialize(): string;',
        '  deserialize(data: string): void;',
        '}',
        '',
        'export class JsonSerializable implements Serializable {',
        '  private data: Record<string, unknown> = {};',
        '  serialize(): string { return JSON.stringify(this.data); }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'JsonSerializable implements Serializable but does not implement deserialize method',
  },

  {
    id: 'T46',
    description: 'Create a combined export module for services',
    correctMutation: {
      file: 'all-services.ts',
      content: [
        'export { UserService } from "./user-service.ts";',
        'export { OrderService } from "./order-service.ts";',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'all-services.ts',
      content: [
        'export { UserService } from "./user-service.ts";',
        'export { OrderService } from "./order-service.ts";',
        'export { UserService as UserService } from "./user-service.ts";',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'Duplicate export: UserService is exported twice causing a module re-export conflict',
  },

  {
    id: 'T47',
    description: 'Create an immutable config object with readonly properties',
    correctMutation: {
      file: 'immutable-config.ts',
      content: [
        'export interface AppConfig {',
        '  readonly host: string;',
        '  readonly port: number;',
        '}',
        '',
        'export function createConfig(): AppConfig {',
        '  return { host: "localhost", port: 3000 };',
        '}',
        '',
        'export function getPort(config: AppConfig): number {',
        '  return config.port;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'immutable-config.ts',
      content: [
        'export interface AppConfig {',
        '  readonly host: string;',
        '  readonly port: number;',
        '}',
        '',
        'export function createConfig(): AppConfig {',
        '  return { host: "localhost", port: 3000 };',
        '}',
        '',
        'export function setPort(config: AppConfig, port: number): void {',
        '  config.port = port;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'Cannot assign to port because it is a read-only property',
  },

  {
    id: 'T48',
    description: 'Create a status handler using discriminated unions',
    correctMutation: {
      file: 'status-handler.ts',
      content: [
        'type Result = { kind: "ok"; value: string } | { kind: "error"; message: string };',
        '',
        'export function handleResult(result: Result): string {',
        '  if (result.kind === "ok") {',
        '    return result.value;',
        '  }',
        '  return result.message;',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'status-handler.ts',
      content: [
        'type Result = { kind: "ok"; value: string } | { kind: "error"; message: string };',
        '',
        'export function handleResult(result: Result): string {',
        '  if (result.kind === "ok") {',
        '    return result.message;',
        '  }',
        '  return result.value;',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail:
      'Property message does not exist on type { kind: "ok"; value: string }; discriminant narrowing violation',
  },

  {
    id: 'T49',
    description: 'Create a subclass of OrderService with custom order creation',
    correctMutation: {
      file: 'custom-order-service.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import { OrderService } from "./order-service.ts";',
        '',
        'export class CustomOrderService extends OrderService {',
        '  createOrder(userId: number, items: OrderItem[]): Order {',
        '    const order = super.createOrder(userId, items);',
        '    return order;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'custom-order-service.ts',
      content: [
        'import type { Order, OrderItem } from "./types.ts";',
        'import { OrderService } from "./order-service.ts";',
        '',
        'export class CustomOrderService extends OrderService {',
        '  createOrder(userId: string, items: OrderItem[]): Order {',
        '    const order = super.createOrder(Number(userId), items);',
        '    return order;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail:
      'createOrder(userId: string, ...) is incompatible with base class signature createOrder(userId: number, ...)',
  },

  {
    id: 'T50',
    description: 'Create a generic repository with type constraints',
    correctMutation: {
      file: 'repository.ts',
      content: [
        'interface HasId { id: number; }',
        '',
        'export class Repository<T extends HasId> {',
        '  private items = new Map<number, T>();',
        '  add(item: T): void { this.items.set(item.id, item); }',
        '  get(id: number): T | undefined { return this.items.get(id); }',
        '  all(): T[] { return Array.from(this.items.values()); }',
        '}',
        '',
      ].join('\n'),
    },
    incorrectMutation: {
      file: 'repository.ts',
      content: [
        'interface HasId { id: number; }',
        '',
        'export class Repository<T extends HasId> {',
        '  private items = new Map<number, T>();',
        '  add(item: T): void { this.items.set(item.id, item); }',
        '  get(id: number): T | undefined { return this.items.get(id); }',
        '  all(): T[] { return Array.from(this.items.values()); }',
        '}',
        '',
        'const repo = new Repository<string>();',
        '',
      ].join('\n'),
    },
    errorCategory: 'structural',
    errorDetail: 'Type string does not satisfy constraint HasId (string does not have id: number property)',
  },
]; // end-of-tasks

export const TASK_COUNT = 50;

/**
 * API Input Guardrails — validate and sanitize task inputs at the API boundary.
 *
 * Combines Zod validation with path traversal and injection detection.
 * Reuses guardrail scanners from src/guardrails/.
 *
 * Source of truth: spec/tdd.md §22 (API security), Decision A6 (zero-trust)
 */

import { z } from 'zod/v4';
import { containsBypassAttempt } from '../guardrails/bypass-detection.ts';
import { detectPromptInjection } from '../guardrails/prompt-injection.ts';

// ── Limits ────────────────────────────────────────────────────────────

const MAX_GOAL_LENGTH = 10_000;
const MAX_TARGET_FILES = 50;
const MAX_FILE_PATH_LENGTH = 500;
const MAX_CONSTRAINTS = 20;
const MAX_CONSTRAINT_LENGTH = 1_000;

// ── Path Traversal Detection ──────────────────────────────────────────

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//, // ../
  /\.\.\\/, // ..\
  /\/\.\.\//, // /../
  /^\//, // absolute path (leading /)
  /^[A-Za-z]:\\/, // Windows drive letter
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control chars in paths is a security measure
  /[\x00-\x1f]/, // control characters
  /~\//, // home directory reference
];

function containsPathTraversal(filePath: string): boolean {
  return PATH_TRAVERSAL_PATTERNS.some((p) => p.test(filePath));
}

// ── Sanitized Input Schema ────────────────────────────────────────────

const SanitizedTaskInputSchema = z.object({
  goal: z.string().min(1).max(MAX_GOAL_LENGTH),
  targetFiles: z.array(z.string().min(1).max(MAX_FILE_PATH_LENGTH)).max(MAX_TARGET_FILES).optional(),
  constraints: z.array(z.string().min(1).max(MAX_CONSTRAINT_LENGTH)).max(MAX_CONSTRAINTS).optional(),
});

export type SanitizedTaskInput = z.infer<typeof SanitizedTaskInputSchema>;

// ── Sanitization Result ───────────────────────────────────────────────

export interface SanitizeResult {
  valid: boolean;
  input?: SanitizedTaskInput;
  errors: string[];
}

// ── Main Entry Point ──────────────────────────────────────────────────

/**
 * Validate and sanitize raw task input from the API boundary.
 *
 * Checks:
 * 1. Zod schema validation (types, lengths)
 * 2. Path traversal in targetFiles
 * 3. Prompt injection in goal string
 * 4. Bypass attempts in goal/constraints
 */
export function sanitizeTaskInput(input: unknown): SanitizeResult {
  const errors: string[] = [];

  // Step 1: Zod validation
  const parsed = SanitizedTaskInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const data = parsed.data;

  // Step 2: Path traversal check
  if (data.targetFiles) {
    for (const fp of data.targetFiles) {
      if (containsPathTraversal(fp)) {
        errors.push(`Path traversal detected in targetFiles: "${fp}"`);
      }
    }
  }

  // Step 3: Injection detection on goal
  const injection = detectPromptInjection(data.goal);
  if (injection.detected) {
    errors.push(`Prompt injection detected in goal: [${injection.patterns.join(', ')}]`);
  }

  // Step 4: Bypass detection on goal + constraints
  const bypass = containsBypassAttempt(data.goal);
  if (bypass.detected) {
    errors.push(`Bypass attempt detected in goal: [${bypass.patterns.join(', ')}]`);
  }

  if (data.constraints) {
    for (let i = 0; i < data.constraints.length; i++) {
      const cInj = detectPromptInjection(data.constraints[i]!);
      if (cInj.detected) {
        errors.push(`Prompt injection in constraints[${i}]: [${cInj.patterns.join(', ')}]`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, input: data, errors: [] };
}

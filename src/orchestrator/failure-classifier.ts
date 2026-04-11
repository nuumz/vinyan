/**
 * Failure Classifier — parses OracleVerdict into typed, structured errors.
 *
 * Transforms flat "oracle rejected" strings into actionable ClassifiedFailure objects
 * with category, file:line, and suggested fixes. Deterministic (A3-safe).
 *
 * Used by core-loop to enrich WorkingMemory.recordFailedApproach() so that the LLM
 * receives structured failure feedback instead of flat strings.
 */
import type { OracleVerdict } from '../core/types.ts';

// ── Types ──────────────────────────────────────────────────────

export type FailureCategory =
  | 'type_error'
  | 'lint_violation'
  | 'test_failure'
  | 'ast_error'
  | 'goal_misalignment'
  | 'hallucination_file'
  | 'hallucination_import'
  | 'hallucination_tool_call'
  | 'hallucination_symbol'
  | 'overconfidence'
  | 'unknown';

export interface ClassifiedFailure {
  category: FailureCategory;
  file?: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning';
  suggestedFix?: string;
}

// ── File:line extraction patterns ──────────────────────────────

// Matches patterns like "src/foo.ts(42,5)" or "src/foo.ts:42:5" or "src/foo.ts:42"
const FILE_LINE_PATTERNS = [
  /([^\s:()]+\.(?:ts|js|tsx|jsx|mts|cts))\((\d+),\d+\)/, // tsc style: file(line,col)
  /([^\s:()]+\.(?:ts|js|tsx|jsx|mts|cts)):(\d+):\d+/, // eslint/ruff style: file:line:col
  /([^\s:()]+\.(?:ts|js|tsx|jsx|mts|cts)):(\d+)/, // simple: file:line
];

function extractFileLine(text: string): { file?: string; line?: number } {
  for (const pattern of FILE_LINE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { file: match[1], line: parseInt(match[2] ?? '0', 10) };
    }
  }
  return {};
}

// ── Classification rules ───────────────────────────────────────

function classifyTypeError(verdict: OracleVerdict): ClassifiedFailure[] {
  const failures: ClassifiedFailure[] = [];
  const reason = verdict.reason ?? '';

  // Parse tsc-style error messages from reason
  // Example: "src/foo.ts(42,5): error TS2339: Property 'bar' does not exist on type 'Foo'"
  const tscErrorPattern = /([^\s]+\.(?:ts|tsx))\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)/g;
  for (const match of reason.matchAll(tscErrorPattern)) {
    failures.push({
      category: 'type_error',
      file: match[1],
      line: parseInt(match[2] ?? '0', 10),
      message: `${match[3]}: ${match[4]}`,
      severity: 'error',
    });
  }

  // If no structured errors found, create one from the reason
  if (failures.length === 0 && reason) {
    const { file, line } = extractFileLine(reason);
    failures.push({
      category: 'type_error',
      file,
      line,
      message: reason,
      severity: 'error',
    });
  }

  return failures;
}

function classifyLintError(verdict: OracleVerdict): ClassifiedFailure[] {
  const failures: ClassifiedFailure[] = [];
  const reason = verdict.reason ?? '';

  // Parse ESLint/Biome style: "src/foo.ts:42:5 — no-unused-vars"
  const lintPattern = /([^\s]+\.(?:ts|tsx|js|jsx)):(\d+):\d+\s*[-—]\s*(\S+)/g;
  for (const match of reason.matchAll(lintPattern)) {
    failures.push({
      category: 'lint_violation',
      file: match[1],
      line: parseInt(match[2] ?? '0', 10),
      message: match[3] ?? '',
      severity: 'warning',
    });
  }

  if (failures.length === 0 && reason) {
    const { file, line } = extractFileLine(reason);
    failures.push({
      category: 'lint_violation',
      file,
      line,
      message: reason,
      severity: 'warning',
    });
  }

  return failures;
}

function classifyTestFailure(verdict: OracleVerdict): ClassifiedFailure[] {
  const failures: ClassifiedFailure[] = [];
  const reason = verdict.reason ?? '';

  // Parse test failure: "test-name > it should pass — expected X got Y"
  const { file, line } = extractFileLine(reason);
  failures.push({
    category: 'test_failure',
    file,
    line,
    message: reason || 'Test verification failed',
    severity: 'error',
    suggestedFix: 'Review test expectations and verify implementation matches spec',
  });

  return failures;
}

function classifyGoalMisalignment(verdict: OracleVerdict): ClassifiedFailure[] {
  const failures: ClassifiedFailure[] = [];
  const reason = verdict.reason ?? '';

  // Goal alignment reasons are semicolon-separated (from the oracle's multi-check aggregation)
  const parts = reason
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    failures.push({
      category: 'goal_misalignment',
      message: part,
      severity: 'warning',
      suggestedFix: 'Re-read the task goal and verify output matches user intent',
    });
  }

  if (failures.length === 0) {
    failures.push({
      category: 'goal_misalignment',
      message: reason || 'Output does not align with task understanding',
      severity: 'warning',
    });
  }

  return failures;
}

// ── Main classification function ───────────────────────────────

/**
 * Classify an oracle verdict into typed failures.
 * @param verdict - The oracle verdict to classify
 * @param oracleName - Which oracle produced this verdict (e.g. 'type', 'lint', 'test')
 * @returns Array of classified failures (may be empty if verdict is positive)
 */
export function classifyFailure(verdict: OracleVerdict, oracleName: string): ClassifiedFailure[] {
  // Only classify failed verdicts
  if (verdict.verified) return [];

  switch (oracleName) {
    case 'type':
      return classifyTypeError(verdict);
    case 'lint':
      return classifyLintError(verdict);
    case 'test':
      return classifyTestFailure(verdict);
    case 'ast':
      return [
        {
          category: 'ast_error',
          message: verdict.reason ?? 'AST verification failed',
          severity: 'error',
          ...(verdict.evidence?.[0] ? { file: verdict.evidence[0].file, line: verdict.evidence[0].line } : {}),
        },
      ];
    case 'goal-alignment':
      return classifyGoalMisalignment(verdict);
    default:
      return [
        {
          category: 'unknown',
          message: verdict.reason ?? `Oracle '${oracleName}' rejected`,
          severity: 'error',
        },
      ];
  }
}

/**
 * Classify all failed verdicts from a gate result.
 */
export function classifyAllFailures(verdicts: Record<string, OracleVerdict>): ClassifiedFailure[] {
  const failures: ClassifiedFailure[] = [];
  for (const [oracleName, verdict] of Object.entries(verdicts)) {
    failures.push(...classifyFailure(verdict, oracleName));
  }
  return failures;
}

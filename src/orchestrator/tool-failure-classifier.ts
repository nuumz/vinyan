/**
 * Tool Failure Classifier — deterministic triage of tool execution errors.
 *
 * Classifies raw shell errors into structured types to determine whether
 * LLM remediation is worth attempting or to skip straight to escalation.
 *
 * A3 compliant: fully deterministic, same input → same output.
 */

export type ToolFailureType =
  | 'not_found'     // command/app not found
  | 'permission'    // permission denied
  | 'timeout'       // execution timeout
  | 'syntax'        // command syntax error
  | 'network'       // connection error
  | 'resource'      // resource busy/unavailable
  | 'unknown';

export interface ToolFailureAnalysis {
  type: ToolFailureType;
  /** Whether LLM remediation is worth attempting. */
  recoverable: boolean;
  /** Whether simple retry (without modification) might work. */
  retryable: boolean;
  originalError: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Pattern → classification rules (order matters: first match wins)
// ---------------------------------------------------------------------------

interface ClassificationRule {
  patterns: RegExp[];
  type: ToolFailureType;
  recoverable: boolean;
  retryable: boolean;
}

const RULES: ClassificationRule[] = [
  // App/command not found — LLM can suggest correct name
  {
    patterns: [
      /unable to find application/i,
      /command not found/i,
      /not found/i,
      /no such file or directory/i,
      /cannot find/i,
      /does not exist/i,
      /is not recognized/i,
    ],
    type: 'not_found',
    recoverable: true,
    retryable: false,
  },
  // Permission denied — LLM can suggest alternative approach
  {
    patterns: [
      /permission denied/i,
      /EPERM/,
      /EACCES/,
      /operation not permitted/i,
      /access is denied/i,
    ],
    type: 'permission',
    recoverable: true,
    retryable: false,
  },
  // Timeout — retry might help
  {
    patterns: [
      /timed? ?out/i,
      /ETIMEDOUT/,
      /deadline exceeded/i,
    ],
    type: 'timeout',
    recoverable: false,
    retryable: true,
  },
  // Network — retry might help
  {
    patterns: [
      /connection refused/i,
      /ECONNREFUSED/,
      /ECONNRESET/,
      /network.*(unreachable|error)/i,
      /DNS.*failed/i,
    ],
    type: 'network',
    recoverable: false,
    retryable: true,
  },
  // Syntax error — LLM can fix
  {
    patterns: [
      /syntax error/i,
      /unexpected token/i,
      /invalid option/i,
      /unrecognized option/i,
      /illegal option/i,
      /bad flag/i,
    ],
    type: 'syntax',
    recoverable: true,
    retryable: false,
  },
  // Resource busy — retry might help
  {
    patterns: [
      /resource busy/i,
      /EBUSY/,
      /already in use/i,
      /lock/i,
    ],
    type: 'resource',
    recoverable: false,
    retryable: true,
  },
];

/**
 * Classify a tool execution failure into a structured type.
 * Returns analysis with recovery/retry guidance.
 */
export function classifyToolFailure(exitCode: number, stderr: string): ToolFailureAnalysis {
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(stderr)) {
        return {
          type: rule.type,
          recoverable: rule.recoverable,
          retryable: rule.retryable,
          originalError: stderr,
          exitCode,
        };
      }
    }
  }

  return {
    type: 'unknown',
    recoverable: false,
    retryable: false,
    originalError: stderr,
    exitCode,
  };
}

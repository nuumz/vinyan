/**
 * Tool helpers shared across category-specific tool files.
 *
 * Lives in its own module (no imports from sibling tool files) to break
 * circular import chains when a tool is imported directly without going
 * through `built-in-tools.ts`. The barrel re-exports these for any caller
 * that already pulls from `built-in-tools`.
 */

import { createHash } from 'crypto';
import type { Evidence } from '../../core/types.ts';
import type { ToolResult } from '../types.ts';

export function makeEvidence(file: string, content: string): Evidence {
  return {
    file,
    line: 0,
    snippet: content.slice(0, 100),
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

export function makeResult(callId: string, tool: string, partial: Partial<ToolResult>): ToolResult {
  return {
    callId,
    tool,
    status: 'success',
    durationMs: 0,
    ...partial,
  };
}

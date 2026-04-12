/**
 * Built-in tools — shared helpers and assembled tool map.
 * Source of truth: spec/tdd.md §18.1
 *
 * Tool implementations are split into category-specific files:
 *   file-tools.ts, directory-tools.ts, search-tools.ts,
 *   shell-tools.ts, git-tools.ts, http-tools.ts, control-tools.ts
 */

import { createHash } from 'crypto';
import type { ToolResult } from '../types.ts';
import type { Tool } from './tool-interface.ts';

// ── Category imports ────────────────────────────────────────────────
import { fileRead, fileWrite, fileEdit } from './file-tools.ts';
import { directoryList } from './directory-tools.ts';
import { searchGrep, searchSemantic } from './search-tools.ts';
import { shellExec } from './shell-tools.ts';
import { gitStatus, gitDiff } from './git-tools.ts';
import { httpGet } from './http-tools.ts';
import { memoryPropose } from './memory-tools.ts';
import { attemptCompletion, requestBudgetExtension, delegateTask } from './control-tools.ts';

// ── Shared constants ────────────────────────────────────────────────

/** Configurable tool execution timeouts. */
export interface ToolConfig {
  /** Default tool execution timeout in ms. Default: 30000 */
  defaultTimeoutMs: number;
  /** HTTP GET timeout in ms. Default: 10000 */
  httpGetTimeoutMs: number;
}

export const TOOL_CONFIG_DEFAULTS: ToolConfig = {
  defaultTimeoutMs: 30_000,
  httpGetTimeoutMs: 10_000,
};

export const TOOL_TIMEOUT_MS = TOOL_CONFIG_DEFAULTS.defaultTimeoutMs;

// ── Shared helpers (used by category files) ─────────────────────────

export function makeEvidence(file: string, content: string) {
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

// ── Re-exports for backwards compatibility ──────────────────────────

export {
  fileRead, fileWrite, fileEdit,
  directoryList,
  searchGrep, searchSemantic,
  shellExec,
  gitStatus, gitDiff,
  httpGet,
  memoryPropose,
  attemptCompletion, requestBudgetExtension, delegateTask,
};

// ── Scan utility ────────────────────────────────────────────────────

/**
 * Scan tool result for prompt injection / adversarial content before returning to worker.
 * Called from agent-loop.ts after each tool execution (A6 — zero-trust execution).
 */
export function scanToolResult(
  result: ToolResult,
  guardrailsScan?: (input: string) => { blocked: boolean; reason?: string },
): ToolResult {
  if (!guardrailsScan || !result.output) return result;
  const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  const scanResult = guardrailsScan(text);
  if (scanResult.blocked) {
    return {
      ...result,
      output: `[CONTENT BLOCKED: ${scanResult.reason ?? 'potential prompt injection detected'}]`,
    };
  }
  return result;
}

// ── Assembled tool map ──────────────────────────────────────────────

/** All built-in tools indexed by name. */
export const BUILT_IN_TOOLS: Map<string, Tool> = new Map([
  ['file_read', fileRead],
  ['file_write', fileWrite],
  ['file_edit', fileEdit],
  ['directory_list', directoryList],
  ['search_grep', searchGrep],
  ['shell_exec', shellExec],
  ['git_status', gitStatus],
  ['git_diff', gitDiff],
  ['search_semantic', searchSemantic],
  ['http_get', httpGet],
  ['memory_propose', memoryPropose],
  ['attempt_completion', attemptCompletion],
  ['request_budget_extension', requestBudgetExtension],
  ['delegate_task', delegateTask],
]);

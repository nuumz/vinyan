/**
 * JSONL Session Logger — append-only log of gate decisions.
 * Each decision is one JSON line in `.vinyan/sessions/{session_id}.jsonl`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { OracleVerdict } from '../core/types.ts';
import type { GateDecision } from './gate.ts';

export interface SessionLogEntry {
  timestamp: string;
  session_id: string;
  tool: string;
  file_path: string;
  decision: GateDecision;
  reasons: string[];
  oracle_results: Record<string, OracleVerdict>;
  durationMs: number;
  /** Specific verdicts that caused blocking — for false-positive tracking. */
  blocked_verdicts?: OracleVerdict[];
  /** Content hash of the mutation for dedup/FP tracking. */
  mutation_hash?: string;
}

/**
 * Append a single decision to the session JSONL log file.
 * Creates the directory structure if it doesn't exist.
 */
export async function logDecision(workspace: string, entry: SessionLogEntry): Promise<void> {
  const sessionDir = join(workspace, '.vinyan', 'sessions');
  mkdirSync(sessionDir, { recursive: true });

  const logPath = join(sessionDir, `${entry.session_id}.jsonl`);
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(logPath, line, 'utf-8');
}

/**
 * Read all log entries from a session file.
 */
export function readSessionLog(logPath: string): SessionLogEntry[] {
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, 'utf-8');
  return content
    .split('\n')
    .filter((line: string) => line.trim().length > 0)
    .map((line: string) => JSON.parse(line) as SessionLogEntry);
}

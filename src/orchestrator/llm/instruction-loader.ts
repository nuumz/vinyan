/**
 * Instruction Loader — loads project-level instructions from VINYAN.md.
 *
 * Human-authored only (A1: no LLM writes to instruction memory).
 * Falls back gracefully if file not found.
 */
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

/** Max instruction file size (50KB) — prevents context window blowout. */
const MAX_INSTRUCTION_SIZE = 50_000;

export interface InstructionMemory {
  /** Raw content of the instruction file */
  content: string;
  /** SHA-256 hash of content for cache invalidation */
  contentHash: string;
  /** Absolute path to the file */
  filePath: string;
}

/** In-memory cache keyed by content hash */
let cachedInstructions: InstructionMemory | null = null;

/**
 * Load VINYAN.md from the workspace root. Returns null if not found.
 * Caches by content hash — re-reads only if file content changes.
 */
export function loadInstructionMemory(workspaceRoot: string): InstructionMemory | null {
  const filePath = join(workspaceRoot, 'VINYAN.md');
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, 'utf-8');
    if (content.length > MAX_INSTRUCTION_SIZE) return null;
    const contentHash = createHash('sha256').update(content).digest('hex');

    // Return cached if unchanged
    if (cachedInstructions?.contentHash === contentHash) {
      return cachedInstructions;
    }

    cachedInstructions = { content, contentHash, filePath };
    return cachedInstructions;
  } catch {
    return null;
  }
}

/** Clear the instruction cache (for testing). */
export function clearInstructionCache(): void {
  cachedInstructions = null;
}

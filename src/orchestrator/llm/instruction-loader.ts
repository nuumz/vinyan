/**
 * Instruction Loader — loads project-level instructions from VINYAN.md and
 * the broader instruction hierarchy (user prefs, project rules, learned conventions).
 *
 * Human-authored only (A1: no LLM writes to user/project/scoped-rule tiers).
 * The "learned" tier (M4) is agent-proposed but oracle-gated before commit.
 *
 * Falls back gracefully if no instruction sources found.
 *
 * @see instruction-hierarchy.ts for the multi-tier resolver implementation.
 */
import {
  resolveInstructions,
  clearInstructionHierarchyCache,
  type InstructionMemory as HierarchyMemory,
  type InstructionContext,
} from './instruction-hierarchy.ts';

// Re-export the hierarchy memory type — it's the same shape used throughout the pipeline.
export type InstructionMemory = HierarchyMemory;

/**
 * Load instruction memory for a given workspace.
 * Backwards-compatible signature: single workspace argument returns project-level instructions
 * without per-task filtering. Callers that want applyTo-based filtering should call
 * resolveInstructions() directly with an InstructionContext.
 */
export function loadInstructionMemory(workspaceRoot: string): InstructionMemory | null {
  return resolveInstructions({ workspace: workspaceRoot });
}

/**
 * Load instruction memory scoped to a specific task context.
 * This is the preferred entry point — enables applyTo-based rule filtering so
 * scoped rules only load when their glob patterns match the task's target files.
 */
export function loadInstructionMemoryForTask(ctx: InstructionContext): InstructionMemory | null {
  return resolveInstructions(ctx);
}

/** Clear the instruction cache (for testing). */
export function clearInstructionCache(): void {
  clearInstructionHierarchyCache();
}

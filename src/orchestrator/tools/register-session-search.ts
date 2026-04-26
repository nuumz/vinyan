/**
 * Helper to mount the `session_search` tool onto the built-in tool registry.
 * Mirrors `registerSkillTools` — idempotent overwrite on repeat calls, does
 * NOT import factory.ts. The factory wires this in a follow-up PR:
 *
 *     registerSessionSearchTool({ toolRegistry: BUILT_IN_TOOLS, deps: { db } });
 */
import { createSessionSearchTool, type SessionSearchToolDeps } from './session-search-tool.ts';
import type { Tool } from './tool-interface.ts';

export interface RegisterSessionSearchOptions {
  readonly toolRegistry: Map<string, Tool>;
  readonly deps: SessionSearchToolDeps;
}

export function registerSessionSearchTool(opts: RegisterSessionSearchOptions): void {
  const tool = createSessionSearchTool(opts.deps);
  opts.toolRegistry.set(tool.name, tool);
}

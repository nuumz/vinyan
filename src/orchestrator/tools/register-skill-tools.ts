/**
 * Helper to register the SK2 skill tools onto the existing built-in tool
 * registry. The caller owns lifecycle — this helper is idempotent (a second
 * call overwrites the prior entries with the new instances).
 *
 * The factory will wire this in a follow-up PR; by design this module does
 * NOT import factory.ts.
 *
 * The registry shape in this codebase is `Map<string, Tool>` (see
 * `src/orchestrator/tools/built-in-tools.ts`). We accept that exact type
 * rather than introducing a new indirection so the wiring PR can call:
 *
 *     registerSkillTools({ toolRegistry: BUILT_IN_TOOLS, deps: { artifactStore } });
 *
 * without any further plumbing.
 */

import {
  createSkillsListTool,
  createSkillViewFileTool,
  createSkillViewTool,
  type SkillToolsDeps,
} from './skill-tools.ts';
import type { Tool } from './tool-interface.ts';

export interface RegisterSkillToolsOptions {
  readonly toolRegistry: Map<string, Tool>;
  readonly deps: SkillToolsDeps;
}

export function registerSkillTools(opts: RegisterSkillToolsOptions): void {
  const { toolRegistry, deps } = opts;
  const list = createSkillsListTool(deps);
  const view = createSkillViewTool(deps);
  const viewFile = createSkillViewFileTool(deps);
  toolRegistry.set(list.name, list);
  toolRegistry.set(view.name, view);
  toolRegistry.set(viewFile.name, viewFile);
}

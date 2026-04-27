/**
 * Built-in agent roster — shipped with Vinyan.
 *
 * Users extend via `vinyan.json` agents[] or CLI `vinyan agent add`.
 * Built-ins can be overridden (same id in config replaces the default).
 */
import type { AgentSpec } from '../../types.ts';
import { CREATIVE_TEAM_AGENTS } from './creative-team.ts';
import { secretary } from './secretary.ts';
import { systemDesigner } from './system-designer.ts';
import { tsCoder } from './ts-coder.ts';
import { writer } from './writer.ts';

export const BUILTIN_AGENTS: readonly AgentSpec[] = [
  tsCoder,
  systemDesigner,
  secretary,
  writer,
  ...CREATIVE_TEAM_AGENTS,
] as const;

/** Default agent for workspaces without explicit configuration. */
export const DEFAULT_AGENT_ID = 'ts-coder';

export {
  creativeDirector,
  critic,
  editor,
  novelist,
  plotArchitect,
  storyStrategist,
} from './creative-team.ts';
export { secretary, systemDesigner, tsCoder, writer };

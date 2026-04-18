/**
 * Built-in agent roster — shipped with Vinyan.
 *
 * Users extend via `vinyan.json` agents[] or CLI `vinyan agent add`.
 * Built-ins can be overridden (same id in config replaces the default).
 */
import type { AgentSpec } from '../../types.ts';
import { secretary } from './secretary.ts';
import { systemDesigner } from './system-designer.ts';
import { tsCoder } from './ts-coder.ts';
import { writer } from './writer.ts';

export const BUILTIN_AGENTS: readonly AgentSpec[] = [
  tsCoder,
  systemDesigner,
  secretary,
  writer,
] as const;

/** Default agent for workspaces without explicit configuration. */
export const DEFAULT_AGENT_ID = 'ts-coder';

export { tsCoder, systemDesigner, secretary, writer };

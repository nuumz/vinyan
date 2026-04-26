/**
 * Plugin BUNDLE manifest (G12 — DX / thClaws drop-in compat).
 *
 * NOT to be confused with the programmatic `PluginManifest` in `manifest.ts`,
 * which describes a single signed code module (memory backend, worker backend,
 * messaging adapter, etc.). The BUNDLE manifest is a different thing: a
 * declarative bag that ships a curated set of MCP servers + skill references
 * + agent references in one folder, matching the format thClaws uses for
 * `.thclaws-plugin/plugin.json` and what Anthropic's plugin tooling uses
 * around `plugin.json`.
 *
 * Today this loader only acts on the `mcpServers` field — that is the
 * one piece of every popular plugin format that maps directly onto an
 * existing Vinyan subsystem (MCPClientPool). The `skills` and `agents`
 * fields are parsed and exposed in the result, but the higher-level
 * SkillManager + agent registry don't yet scan directory bundles, so the
 * caller currently treats those as forward-compat metadata. A follow-up
 * PR wires them through the skill / agent loaders.
 *
 * Search order (later overrides earlier on name conflicts):
 *   1. `<workspace>/.vinyan-plugin/plugin.json`
 *   2. `<workspace>/.thclaws-plugin/plugin.json`
 *
 * Failure modes are soft — a malformed file logs a warning and is skipped
 * rather than blocking orchestrator startup. Unknown fields are tolerated
 * (passthrough) so future format extensions don't break boots.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod/v4';

const McpServerEntrySchema = z
  .object({
    type: z.enum(['stdio']).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  })
  .passthrough();

const SkillRefSchema = z
  .object({
    /** Relative path to a skill directory or SKILL.md file from the bundle root. */
    path: z.string().min(1).optional(),
    /** Registry id (`github:owner/repo@ref/path`, `agentskills:...`). */
    id: z.string().min(1).optional(),
  })
  .passthrough()
  .refine((v) => Boolean(v.path) !== Boolean(v.id), {
    message: 'skill ref needs exactly one of `path` or `id`',
  });

const AgentRefSchema = z
  .object({
    name: z.string().min(1),
    /** Subagent role hint understood by Vinyan's agent router. */
    role: z.enum(['explore', 'plan', 'general-purpose']).optional(),
    description: z.string().optional(),
    /** Relative path to the agent definition file from the bundle root. */
    path: z.string().min(1).optional(),
  })
  .passthrough();

export const BundleManifestSchema = z
  .object({
    /** Optional human-readable identifier. Conventional `org.author/bundle-name`. */
    name: z.string().optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    /** MCP server entries — same shape as `.mcp.json` `mcpServers`. */
    mcpServers: z.record(z.string(), McpServerEntrySchema).optional(),
    /** Skills shipped by the bundle. Honored by a future SkillManager scan. */
    skills: z.array(SkillRefSchema).optional(),
    /** Agent definitions shipped by the bundle. Honored by a future agent scan. */
    agents: z.array(AgentRefSchema).optional(),
    /** CLI command overrides — reserved for future use, currently ignored. */
    commands: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type BundleManifest = z.infer<typeof BundleManifestSchema>;
export type BundleSkillRef = z.infer<typeof SkillRefSchema>;
export type BundleAgentRef = z.infer<typeof AgentRefSchema>;

export interface BundleMcpServer {
  name: string;
  command: string;
  args?: string[];
  source: string;
}

export interface LoadBundleResult {
  /** Bundles successfully parsed (most-recent wins on later merge). */
  bundles: BundleManifest[];
  /** Files attempted in load order. */
  attemptedPaths: string[];
  /** Files that were present but malformed. */
  invalidPaths: string[];
  /**
   * Flattened MCP servers from all parsed bundles, deduped by name (later
   * bundle wins). Ready to merge into the factory's MCP server list.
   */
  mcpServers: BundleMcpServer[];
}

/**
 * Load all known bundle manifests for `workspace`.
 *
 * Order (later overrides earlier on name conflict):
 *   1. `<workspace>/.vinyan-plugin/plugin.json`
 *   2. `<workspace>/.thclaws-plugin/plugin.json`
 */
export function loadBundleManifests(workspace: string): LoadBundleResult {
  const candidates = [
    join(workspace, '.vinyan-plugin', 'plugin.json'),
    join(workspace, '.thclaws-plugin', 'plugin.json'),
  ];
  const bundles: BundleManifest[] = [];
  const attemptedPaths: string[] = [];
  const invalidPaths: string[] = [];
  const mcpByName = new Map<string, BundleMcpServer>();

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    attemptedPaths.push(path);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      invalidPaths.push(path);
      console.warn(
        `[vinyan] plugin bundle parse error at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const parsed = BundleManifestSchema.safeParse(raw);
    if (!parsed.success) {
      invalidPaths.push(path);
      console.warn(`[vinyan] plugin bundle schema mismatch at ${path}: ${parsed.error.message}`);
      continue;
    }
    bundles.push(parsed.data);

    if (parsed.data.mcpServers) {
      for (const [name, entry] of Object.entries(parsed.data.mcpServers)) {
        mcpByName.set(name, {
          name,
          command: entry.command,
          ...(entry.args ? { args: entry.args } : {}),
          source: path,
        });
      }
    }
  }

  return {
    bundles,
    attemptedPaths,
    invalidPaths,
    mcpServers: Array.from(mcpByName.values()),
  };
}

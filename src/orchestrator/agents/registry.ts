/**
 * Agent Registry — loads specialist agents from config + built-in defaults.
 *
 * Precedence: config `agents[]` overrides built-ins (same id = override).
 * If config has no agents, built-ins are used. Never writes to disk.
 *
 * Exposes read-only accessors for the core loop, intent resolver, CLI, and API.
 */
import type { AgentSpecConfig } from '../../config/schema.ts';
import type { AgentCapabilityOverrides, AgentRoutingHints, AgentSpec } from '../types.ts';
import { BUILTIN_AGENTS, DEFAULT_AGENT_ID } from './builtin/index.ts';
import { loadAgentSoul } from './soul-loader.ts';

export interface AgentRegistry {
  /** Get agent by id. Returns null if not found. */
  getAgent(id: string): AgentSpec | null;
  /** List all registered agents (built-ins + config). */
  listAgents(): AgentSpec[];
  /** Default agent for tasks with no explicit selection. */
  defaultAgent(): AgentSpec;
  /** Check if agent exists. */
  has(id: string): boolean;
}

/**
 * Build the runtime registry by merging built-in defaults with user config.
 * Config agents with the same id as a built-in REPLACE the built-in.
 *
 * Soul resolution precedence (highest wins):
 *   1. Disk soul file (`.vinyan/agents/<id>/soul.md` or explicit `soul_path`)
 *   2. `extraSouls.get(id)` — used by `markdown-loader` to thread an
 *      AGENT.md body in as the soul without writing to disk.
 *   3. Built-in soul string (compiled-in default).
 */
export function loadAgentRegistry(
  workspace: string,
  configAgents?: AgentSpecConfig[],
  extraSouls?: ReadonlyMap<string, string>,
): AgentRegistry {
  const byId = new Map<string, AgentSpec>();

  // 1. Seed with built-in defaults
  for (const agent of BUILTIN_AGENTS) {
    byId.set(agent.id, { ...agent });
  }

  // 2. Apply config overrides / additions
  for (const cfg of configAgents ?? []) {
    const existing = byId.get(cfg.id);
    const agent: AgentSpec = {
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      soulPath: cfg.soul_path ?? existing?.soulPath,
      allowedTools: cfg.allowed_tools ?? existing?.allowedTools,
      capabilityOverrides: fromConfigOverrides(cfg.capability_overrides) ?? existing?.capabilityOverrides,
      routingHints: fromConfigHints(cfg.routing_hints) ?? existing?.routingHints,
      builtin: existing?.builtin ?? false,
      // Preserve built-in soul string; soul file on disk takes precedence at load time
      soul: existing?.soul,
    };
    byId.set(cfg.id, agent);
  }

  // 3. Soul resolution: disk file > extraSouls (AGENT.md body) > built-in string
  for (const [id, agent] of byId) {
    const diskSoul = loadAgentSoul(workspace, id, agent.soulPath);
    if (diskSoul !== null) {
      byId.set(id, { ...agent, soul: diskSoul });
    } else if (extraSouls?.has(id)) {
      byId.set(id, { ...agent, soul: extraSouls.get(id)! });
    }
  }

  const defaultId = byId.has(DEFAULT_AGENT_ID) ? DEFAULT_AGENT_ID : ([...byId.keys()][0] ?? DEFAULT_AGENT_ID);

  return {
    getAgent(id: string): AgentSpec | null {
      return byId.get(id) ?? null;
    },
    listAgents(): AgentSpec[] {
      return [...byId.values()];
    },
    defaultAgent(): AgentSpec {
      const agent = byId.get(defaultId);
      if (agent) return agent;
      // Last-resort fallback if registry is empty
      return {
        id: 'default',
        name: 'Vinyan',
        description: 'General-purpose agent',
      };
    },
    has(id: string): boolean {
      return byId.has(id);
    },
  };
}

function fromConfigOverrides(cfg?: AgentSpecConfig['capability_overrides']): AgentCapabilityOverrides | undefined {
  if (!cfg) return undefined;
  const out: AgentCapabilityOverrides = {};
  if (cfg.read_any !== undefined) out.readAny = cfg.read_any;
  if (cfg.write_any !== undefined) out.writeAny = cfg.write_any;
  if (cfg.network !== undefined) out.network = cfg.network;
  if (cfg.shell !== undefined) out.shell = cfg.shell;
  return out;
}

function fromConfigHints(cfg?: AgentSpecConfig['routing_hints']): AgentRoutingHints | undefined {
  if (!cfg) return undefined;
  const out: AgentRoutingHints = {};
  if (cfg.min_level !== undefined) out.minLevel = cfg.min_level;
  if (cfg.prefer_domains) out.preferDomains = cfg.prefer_domains;
  if (cfg.prefer_extensions) out.preferExtensions = cfg.prefer_extensions;
  if (cfg.prefer_frameworks) out.preferFrameworks = cfg.prefer_frameworks;
  return out;
}

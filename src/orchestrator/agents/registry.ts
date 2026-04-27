/**
 * Agent Registry — loads specialist agents from config + built-in defaults.
 *
 * Precedence: config `agents[]` overrides built-ins (same id = override).
 * If config has no agents, built-ins are used. Never writes to disk.
 *
 * Exposes read-only accessors for the core loop, intent resolver, CLI, and API.
 */
import type { AgentSpecConfig } from '../../config/schema.ts';
import type {
  AgentCapabilityOverrides,
  AgentRoutingHints,
  AgentSpec,
  CapabilityClaim,
} from '../types.ts';
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
  /**
   * Register a runtime-synthesized agent. Throws when:
   *   - the id is already taken (built-in or another synthetic)
   *   - the id collides with a known builtin id (defense in depth)
   *
   * Synthesized agents must carry `builtin: false`. The registry tags
   * them by `taskId` (when supplied) so `unregisterAgentsForTask` can
   * sweep them at task end without the caller tracking ids itself.
   */
  registerAgent(spec: AgentSpec, opts?: { taskId?: string }): void;
  /** Remove a previously registered synthetic agent. Returns true if removed. */
  unregisterAgent(id: string): boolean;
  /**
   * Sweep every synthetic agent registered with `taskId`. Returns the ids
   * that were actually removed. Safe to call multiple times — idempotent.
   */
  unregisterAgentsForTask(taskId: string): string[];
  /**
   * Phase D — Capability promotion: merge `claims` onto the agent's
   * `capabilities` list, replacing any prior claim with the same `id`.
   * Returns true when the agent exists and the merge was applied.
   *
   * Used by the sleep-cycle evolution path to attach `evidence:'evolved'`
   * claims with statistically-bounded confidence (Wilson LB). Refuses to
   * mutate task-scoped synthetic agents (they are ephemeral) — those are
   * cleaned up at task end via `unregisterAgentsForTask`.
   */
  mergeCapabilityClaims(agentId: string, claims: CapabilityClaim[]): boolean;
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
      capabilities: fromConfigCapabilities(cfg.capabilities) ?? existing?.capabilities,
      roles: cfg.roles ?? existing?.roles,
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

  // 4. Backfill inferred capabilities for agents that declare none. This keeps
  //    the capability layer useful for legacy/custom agents without forcing
  //    every config author to spell out claims. Inferred entries carry low
  //    confidence so explicit declarations always win.
  for (const [id, agent] of byId) {
    if (agent.capabilities && agent.capabilities.length > 0) continue;
    const inferred = inferCapabilitiesFromHints(agent);
    if (inferred.length > 0) byId.set(id, { ...agent, capabilities: inferred });
  }

  const defaultId = byId.has(DEFAULT_AGENT_ID) ? DEFAULT_AGENT_ID : ([...byId.keys()][0] ?? DEFAULT_AGENT_ID);

  // Set of ids that exist as built-ins or shipped config — registerAgent
  // refuses to overwrite these. Captured BEFORE returning so later calls
  // to registerAgent cannot poison this snapshot.
  const protectedIds = new Set<string>(byId.keys());
  // Map syntheticId → taskId so we can sweep on task completion. Built-ins
  // and config agents are never tracked here.
  const syntheticByTask = new Map<string, string>();

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
    registerAgent(spec, opts) {
      if (protectedIds.has(spec.id)) {
        throw new Error(`registerAgent: cannot overwrite protected agent '${spec.id}'`);
      }
      if (byId.has(spec.id)) {
        throw new Error(`registerAgent: id '${spec.id}' is already registered`);
      }
      if (spec.builtin === true) {
        throw new Error(`registerAgent: refusing to register '${spec.id}' with builtin=true`);
      }
      byId.set(spec.id, { ...spec });
      if (opts?.taskId) syntheticByTask.set(spec.id, opts.taskId);
    },
    unregisterAgent(id: string): boolean {
      if (protectedIds.has(id)) return false;
      const removed = byId.delete(id);
      if (removed) syntheticByTask.delete(id);
      return removed;
    },
    unregisterAgentsForTask(taskId: string): string[] {
      const removed: string[] = [];
      for (const [id, owner] of syntheticByTask) {
        if (owner !== taskId) continue;
        if (byId.delete(id)) removed.push(id);
        syntheticByTask.delete(id);
      }
      return removed;
    },
    mergeCapabilityClaims(agentId: string, claims: CapabilityClaim[]): boolean {
      const agent = byId.get(agentId);
      if (!agent) return false;
      // Refuse to mutate task-scoped synthetic agents — they are ephemeral.
      if (syntheticByTask.has(agentId)) return false;
      if (claims.length === 0) return true;
      const merged = new Map<string, CapabilityClaim>();
      for (const existing of agent.capabilities ?? []) {
        merged.set(existing.id, existing);
      }
      for (const incoming of claims) {
        merged.set(incoming.id, incoming);
      }
      byId.set(agentId, { ...agent, capabilities: [...merged.values()] });
      return true;
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

function fromConfigCapabilities(cfg?: AgentSpecConfig['capabilities']): CapabilityClaim[] | undefined {
  if (!cfg || cfg.length === 0) return undefined;
  return cfg.map((c) => ({
    id: c.id,
    label: c.label,
    fileExtensions: c.file_extensions,
    actionVerbs: c.action_verbs,
    domains: c.domains,
    frameworkMarkers: c.framework_markers,
    role: c.role,
    evidence: c.evidence,
    confidence: c.confidence,
  }));
}

/**
 * Synthesize a coarse capability set from `routingHints` for agents that
 * have no explicit declarations. The intent is to keep capability-first
 * routing meaningful for legacy/custom config without forcing migration.
 *
 * Uses evidence='inferred' and a low confidence so explicit claims always
 * outweigh inferred ones during fit scoring.
 */
function inferCapabilitiesFromHints(agent: AgentSpec): CapabilityClaim[] {
  const hints = agent.routingHints;
  if (!hints) return [];
  const exts = hints.preferExtensions ?? [];
  const domains = hints.preferDomains ?? [];
  const fws = hints.preferFrameworks ?? [];
  if (exts.length === 0 && domains.length === 0 && fws.length === 0) return [];
  return [
    {
      id: `inferred.${agent.id}`,
      label: `${agent.name} (inferred)`,
      fileExtensions: exts.length > 0 ? exts : undefined,
      domains: domains.length > 0 ? domains : undefined,
      frameworkMarkers: fws.length > 0 ? fws : undefined,
      evidence: 'inferred',
      confidence: 0.4,
    },
  ];
}

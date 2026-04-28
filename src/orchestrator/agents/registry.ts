/**
 * Agent Registry — loads specialist agents from config + built-in defaults.
 *
 * Precedence: config `agents[]` overrides built-ins (same id = override).
 * If config has no agents, built-ins are used. Never writes to disk.
 *
 * Exposes read-only accessors for the core loop, intent resolver, CLI, and API.
 */
import type { AgentSpecConfig } from '../../config/schema.ts';
import type { AgentCapabilityOverrides, AgentRoutingHints, AgentSpec, CapabilityClaim, SkillRef } from '../types.ts';
import { BUILTIN_AGENTS, DEFAULT_AGENT_ID, RETIRED_LEGACY_AGENT_IDS } from './builtin/index.ts';
import {
  type DerivedCapabilities,
  derivePersonaCapabilities,
  type SyncSkillResolver,
} from './derive-persona-capabilities.ts';
import { loadBoundSkills } from './persona-skill-loader.ts';
import { loadAgentSoul } from './soul-loader.ts';

/**
 * First-person verification verbs that should not appear in a Generator-class
 * persona's soul. The pattern enforces A1 Epistemic Separation at the prompt
 * boundary: a Developer or Author whose soul says "I check my work" is doing
 * self-verification inside the Generator, which is exactly what A1 forbids.
 * Only the Reviewer persona is allowed to use these verbs in its soul.
 */
const SELF_VERIFICATION_PATTERN = /\bI (?:check|verify|review|audit|evaluate|validate|assess|critique)\b/i;

function lintSoulForA1(spec: AgentSpec): string | null {
  if (!spec.soul) return null;
  if (spec.role === 'reviewer') return null;
  const match = spec.soul.match(SELF_VERIFICATION_PATTERN);
  if (!match) return null;
  return `Soul for agent '${spec.id}' (role=${spec.role ?? 'unknown'}) contains a first-person verification verb '${match[0]}'. Move self-verification to a Reviewer persona — A1 Epistemic Separation forbids generators from evaluating their own output. Either remove the phrase or set role='reviewer'.`;
}

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
  /**
   * Phase 2 — Capability derivation: resolve the persona's loaded skills
   * (base + bound) into an effective claim list and composed ACL.
   *
   * Returns null when the agent is unknown. Returns a derivation with empty
   * skill arrays when no skill resolver was provided at registry construction
   * (Phase 2 feature flag off, or the workspace has no skills configured) —
   * callers can treat the returned `capabilities` as equivalent to the raw
   * `AgentSpec.capabilities` plus any bound-skill claims.
   *
   * The derivation is computed on-demand and not cached: skill bindings can
   * change at runtime through CLI bind/unbind, and the registry must reflect
   * the current `.vinyan/agents/<id>/skills.json` snapshot when the next
   * routing decision is made.
   *
   * Phase-5B: `options.extraRefs` is the **acquired-scope** mechanism —
   * caller-managed per-task skills that augment base+bound for ONE call only.
   * The registry does not retain extras between calls. Callers (the future
   * skill-acquisition path) own the extras' lifecycle and pass them on each
   * derivation that needs them. This avoids registry-side per-task state
   * and mirrors how synthetic agents are scoped to a taskId.
   */
  getDerivedCapabilities(agentId: string, options?: { extraRefs?: readonly SkillRef[] }): DerivedCapabilities | null;
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
/**
 * Optional dependencies that wire skill composition into the registry. When
 * `skillResolver` is omitted, `getDerivedCapabilities` still returns a result —
 * but the result includes no skill-derived claims and no ACL composition.
 * Phase 2 callers pass a resolver backed by `SkillArtifactStore`.
 */
export interface AgentRegistryOptions {
  /** Resolves a SkillRef → SkillMdRecord. Pass a sync wrapper around the artifact store. */
  skillResolver?: SyncSkillResolver;
  /** Phase-2 feature flag. When false, skill composition is skipped entirely. */
  enableSkillComposition?: boolean;
}

export function loadAgentRegistry(
  workspace: string,
  configAgents?: AgentSpecConfig[],
  extraSouls?: ReadonlyMap<string, string>,
  options: AgentRegistryOptions = {},
): AgentRegistry {
  const byId = new Map<string, AgentSpec>();

  // 1. Seed with built-in defaults
  for (const agent of BUILTIN_AGENTS) {
    byId.set(agent.id, cloneAgentSpec(agent));
  }

  // Detect config references to retired legacy persona ids — Phase-1 hard-cut
  // migration. We log once per stale id so users see the migration cost up
  // front rather than silently inheriting the default. There is intentionally
  // no alias resolution: the user must adopt the new role-pure roster.
  const retiredSet = new Set<string>(RETIRED_LEGACY_AGENT_IDS);
  const seenLegacy = new Set<string>();
  for (const cfg of configAgents ?? []) {
    if (retiredSet.has(cfg.id) && !seenLegacy.has(cfg.id)) {
      seenLegacy.add(cfg.id);
      console.warn(
        `[agent:legacy-id] config references retired persona '${cfg.id}'. The Phase-1 redesign hard-cut the prior roster — move this entry to one of: ${BUILTIN_AGENTS.map((a) => a.id).join(', ')}. See CHANGELOG for the migration rationale.`,
      );
    }
  }

  // 2. Apply config overrides / additions
  for (const cfg of configAgents ?? []) {
    const existing = byId.get(cfg.id);
    const agent: AgentSpec = {
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      // Preserve role/baseSkills/acquirableSkillTags from existing builtin.
      // Phase 1 does not yet expose these on the config-side schema; users
      // who override a builtin keep the persona's role tagging by default.
      role: existing?.role,
      soulPath: cfg.soul_path ?? existing?.soulPath,
      allowedTools: cfg.allowed_tools ?? existing?.allowedTools,
      capabilityOverrides: fromConfigOverrides(cfg.capability_overrides) ?? existing?.capabilityOverrides,
      routingHints: fromConfigHints(cfg.routing_hints) ?? existing?.routingHints,
      capabilities: fromConfigCapabilities(cfg.capabilities) ?? existing?.capabilities,
      roles: cfg.roles ?? existing?.roles,
      baseSkills: existing?.baseSkills,
      acquirableSkillTags: existing?.acquirableSkillTags,
      builtin: existing?.builtin ?? false,
      // Preserve built-in soul string; soul file on disk takes precedence at load time
      soul: existing?.soul,
    };
    byId.set(cfg.id, cloneAgentSpec(agent));
  }

  // 3. Soul resolution: disk file > extraSouls (AGENT.md body) > built-in string.
  //    Track which agents picked up a non-builtin soul so the lint below can
  //    distinguish "shipped soul" (must pass — A1 non-negotiable) from
  //    "user-overridden soul" (warn — user controls their own files).
  const userAuthoredSoulIds = new Set<string>();
  for (const [id, agent] of byId) {
    const diskSoul = loadAgentSoul(workspace, id, agent.soulPath);
    if (diskSoul !== null) {
      byId.set(id, { ...agent, soul: diskSoul });
      userAuthoredSoulIds.add(id);
    } else if (extraSouls?.has(id)) {
      byId.set(id, { ...agent, soul: extraSouls.get(id)! });
      userAuthoredSoulIds.add(id);
    }
  }

  // 4. A1 soul lint — reject Generator-class personas whose soul contains a
  //    first-person verification verb. The Reviewer persona is exempt.
  //
  //    Shipped built-in souls: A1 is non-negotiable for personas we ship.
  //    A violating built-in is a code bug we want to fail loud about, not
  //    silently warn on. THROW — registry construction aborts.
  //
  //    User-authored / disk-overridden souls: warn-only. Their souls evolve
  //    independently and may pre-date this lint; throwing would crash every
  //    workspace with a custom soul. Surface the violation so the user sees
  //    it, but keep the registry usable.
  for (const agent of byId.values()) {
    const violation = lintSoulForA1(agent);
    if (!violation) continue;
    const isShippedBuiltin = agent.builtin === true && !userAuthoredSoulIds.has(agent.id);
    if (isShippedBuiltin) {
      throw new Error(
        `[agent:soul-lint] Built-in persona '${agent.id}' violates A1 Epistemic Separation. ${violation}`,
      );
    }
    console.warn(`[agent:soul-lint] ${violation}`);
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
      const agent = byId.get(id);
      return agent ? cloneAgentSpec(agent) : null;
    },
    listAgents(): AgentSpec[] {
      return [...byId.values()].map(cloneAgentSpec);
    },
    defaultAgent(): AgentSpec {
      const agent = byId.get(defaultId);
      if (agent) return cloneAgentSpec(agent);
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
      byId.set(spec.id, cloneAgentSpec(spec));
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
        merged.set(existing.id, cloneCapabilityClaim(existing));
      }
      for (const incoming of claims) {
        merged.set(incoming.id, cloneCapabilityClaim(incoming));
      }
      byId.set(agentId, { ...agent, capabilities: [...merged.values()] });
      return true;
    },
    getDerivedCapabilities(
      agentId: string,
      callOpts?: { extraRefs?: readonly SkillRef[] },
    ): DerivedCapabilities | null {
      const agent = byId.get(agentId);
      if (!agent) return null;
      const compositionEnabled = options.enableSkillComposition !== false;
      const baseRefs: SkillRef[] = agent.baseSkills ?? [];
      // Bound skills are stored per-workspace at .vinyan/agents/<id>/skills.json
      // and are reloaded on each call so live CLI bind/unbind takes effect
      // without re-instantiating the registry.
      const boundRefs: SkillRef[] = compositionEnabled ? loadBoundSkills(workspace, agentId) : [];
      // Phase-5B acquired scope — caller-managed runtime refs. Always merged
      // last so dedupe-by-last semantics in `derivePersonaCapabilities` let
      // an acquired skill override a stale bound skill of the same id.
      const extraRefs: readonly SkillRef[] = compositionEnabled ? (callOpts?.extraRefs ?? []) : [];
      const allRefs = [...baseRefs, ...boundRefs, ...extraRefs];
      // Defensive: if no resolver was wired or composition is disabled,
      // return the persona's claims/ACL unchanged so callers get a
      // semantically valid `DerivedCapabilities`.
      if (!compositionEnabled || !options.skillResolver) {
        return {
          capabilities: (agent.capabilities ?? []).map(cloneCapabilityClaim),
          effectiveAcl: { ...(agent.capabilityOverrides ?? {}) },
          loadedSkills: [],
          resolvedRefs: [],
          skipped: [],
        };
      }
      return derivePersonaCapabilities(agent, allRefs, options.skillResolver);
    },
  };
}

function cloneAgentSpec(agent: AgentSpec): AgentSpec {
  return {
    ...agent,
    allowedTools: agent.allowedTools ? [...agent.allowedTools] : undefined,
    capabilityOverrides: agent.capabilityOverrides ? { ...agent.capabilityOverrides } : undefined,
    routingHints: agent.routingHints
      ? {
          minLevel: agent.routingHints.minLevel,
          preferDomains: agent.routingHints.preferDomains ? [...agent.routingHints.preferDomains] : undefined,
          preferExtensions: agent.routingHints.preferExtensions ? [...agent.routingHints.preferExtensions] : undefined,
          preferFrameworks: agent.routingHints.preferFrameworks ? [...agent.routingHints.preferFrameworks] : undefined,
        }
      : undefined,
    capabilities: agent.capabilities?.map(cloneCapabilityClaim),
    roles: agent.roles ? [...agent.roles] : undefined,
    baseSkills: agent.baseSkills ? agent.baseSkills.map((s) => ({ ...s })) : undefined,
    acquirableSkillTags: agent.acquirableSkillTags ? [...agent.acquirableSkillTags] : undefined,
  };
}

function cloneCapabilityClaim(claim: CapabilityClaim): CapabilityClaim {
  return {
    ...claim,
    fileExtensions: claim.fileExtensions ? [...claim.fileExtensions] : undefined,
    actionVerbs: claim.actionVerbs ? [...claim.actionVerbs] : undefined,
    domains: claim.domains ? [...claim.domains] : undefined,
    frameworkMarkers: claim.frameworkMarkers ? [...claim.frameworkMarkers] : undefined,
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

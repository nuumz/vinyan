/**
 * Capability profile adapter — converts agent identity records into routing
 * profiles. Agents remain identity/persona/ACL envelopes; the capability
 * router scores these profiles instead of depending on AgentSpec directly.
 *
 * Phase-2 wiring: when `options.derived` is supplied, claims and ACL come
 * from the persona's `DerivedCapabilities` (skill-aware) instead of the raw
 * `AgentSpec`. This is how skill-derived claims and skill-narrowed ACL
 * actually reach the routing layer. Without `derived`, the legacy raw-spec
 * path remains so callers without a registry-resolver wired in still work.
 */
import type { DerivedCapabilities } from '../agents/derive-persona-capabilities.ts';
import type {
  AgentCapabilityProfile,
  AgentCapabilityProfileSource,
  AgentSpec,
  CapabilityProfileTrustTier,
} from '../types.ts';

export interface ProfileAdapterOptions {
  source?: AgentCapabilityProfileSource;
  provenance?: string;
  taskId?: string;
  /**
   * Phase-2: pre-computed `DerivedCapabilities` from the registry. When
   * supplied, the profile's `claims` come from `derived.capabilities` (which
   * folds in skill-derived claims) and `acl` reflects `derived.effectiveAcl`
   * (which intersects persona ACL with skill ACL — A6 narrowing rule).
   *
   * Callers without skill composition wired in (or with the feature flag
   * off) leave this undefined, and the adapter falls back to raw spec data.
   */
  derived?: DerivedCapabilities;
}

export function buildAgentCapabilityProfile(
  agent: AgentSpec,
  options: ProfileAdapterOptions = {},
): AgentCapabilityProfile {
  const source = options.source ?? inferSource(agent);
  const claimsSource = options.derived?.capabilities ?? agent.capabilities;
  const aclSource = options.derived?.effectiveAcl ?? agent.capabilityOverrides;
  return {
    id: agent.id,
    routeTargetId: agent.id,
    displayName: agent.name,
    source,
    provenance: options.provenance ?? `agent:${agent.id}`,
    trustTier: inferTrustTier(agent, source),
    taskScope: options.taskId ? { taskId: options.taskId } : undefined,
    claims:
      claimsSource?.map((claim) => ({
        ...claim,
        fileExtensions: claim.fileExtensions ? [...claim.fileExtensions] : undefined,
        actionVerbs: claim.actionVerbs ? [...claim.actionVerbs] : undefined,
        domains: claim.domains ? [...claim.domains] : undefined,
        frameworkMarkers: claim.frameworkMarkers ? [...claim.frameworkMarkers] : undefined,
      })) ?? [],
    roles: agent.roles ? [...agent.roles] : [],
    acl: {
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : undefined,
      readAny: aclSource?.readAny,
      writeAny: aclSource?.writeAny,
      network: aclSource?.network,
      shell: aclSource?.shell,
    },
    routingHints: agent.routingHints
      ? {
          minLevel: agent.routingHints.minLevel,
          preferDomains: agent.routingHints.preferDomains ? [...agent.routingHints.preferDomains] : undefined,
          preferExtensions: agent.routingHints.preferExtensions ? [...agent.routingHints.preferExtensions] : undefined,
          preferFrameworks: agent.routingHints.preferFrameworks ? [...agent.routingHints.preferFrameworks] : undefined,
        }
      : undefined,
  };
}

export function buildAgentCapabilityProfiles(agents: readonly AgentSpec[]): AgentCapabilityProfile[] {
  return agents.map((agent) => buildAgentCapabilityProfile(agent));
}

/**
 * Phase-2 — build profiles for every agent, asking `getDerived` for each
 * agent's skill-aware capabilities + ACL. When `getDerived` returns null
 * (unknown agent) or an empty derivation (no skill resolver wired) the
 * adapter degrades to the raw-spec path, so this helper is safe to call
 * even when skill composition is off.
 */
export function buildAgentCapabilityProfilesFromRegistry(
  agents: readonly AgentSpec[],
  getDerived: (agentId: string) => DerivedCapabilities | null,
): AgentCapabilityProfile[] {
  return agents.map((agent) => {
    const derived = getDerived(agent.id);
    return buildAgentCapabilityProfile(agent, derived ? { derived } : {});
  });
}

function inferSource(agent: AgentSpec): AgentCapabilityProfileSource {
  return agent.id.startsWith('synthetic-') ? 'synthetic' : 'registry';
}

function inferTrustTier(agent: AgentSpec, source: AgentCapabilityProfileSource): CapabilityProfileTrustTier {
  if (source === 'synthetic' || source === 'external') return 'probabilistic';
  if (source === 'peer') return 'heuristic';
  return agent.builtin === true ? 'deterministic' : 'heuristic';
}

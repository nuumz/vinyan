/**
 * Capability profile adapter — converts agent identity records into routing
 * profiles. Agents remain identity/persona/ACL envelopes; the capability
 * router scores these profiles instead of depending on AgentSpec directly.
 */
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
}

export function buildAgentCapabilityProfile(
  agent: AgentSpec,
  options: ProfileAdapterOptions = {},
): AgentCapabilityProfile {
  const source = options.source ?? inferSource(agent);
  return {
    id: agent.id,
    routeTargetId: agent.id,
    displayName: agent.name,
    source,
    provenance: options.provenance ?? `agent:${agent.id}`,
    trustTier: inferTrustTier(agent, source),
    taskScope: options.taskId ? { taskId: options.taskId } : undefined,
    claims: agent.capabilities?.map((claim) => ({
      ...claim,
      fileExtensions: claim.fileExtensions ? [...claim.fileExtensions] : undefined,
      actionVerbs: claim.actionVerbs ? [...claim.actionVerbs] : undefined,
      domains: claim.domains ? [...claim.domains] : undefined,
      frameworkMarkers: claim.frameworkMarkers ? [...claim.frameworkMarkers] : undefined,
    })) ?? [],
    roles: agent.roles ? [...agent.roles] : [],
    acl: {
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : undefined,
      readAny: agent.capabilityOverrides?.readAny,
      writeAny: agent.capabilityOverrides?.writeAny,
      network: agent.capabilityOverrides?.network,
      shell: agent.capabilityOverrides?.shell,
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

function inferSource(agent: AgentSpec): AgentCapabilityProfileSource {
  return agent.id.startsWith('synthetic-') ? 'synthetic' : 'registry';
}

function inferTrustTier(agent: AgentSpec, source: AgentCapabilityProfileSource): CapabilityProfileTrustTier {
  if (source === 'synthetic' || source === 'external') return 'probabilistic';
  if (source === 'peer') return 'heuristic';
  return agent.builtin === true ? 'deterministic' : 'heuristic';
}
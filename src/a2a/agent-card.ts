/**
 * A2A Agent Card Generator — PH5.6.
 *
 * Generates Vinyan's /.well-known/agent.json from the live oracle registry.
 * Each registered oracle becomes an A2A skill.
 * Vinyan peers are recognized via the `x-vinyan-ecp` extension.
 *
 * Source of truth: Plan Phase D1
 */
import { getOracleEntry, listOracles } from '../oracle/registry.ts';
import type { AgentProfile } from '../orchestrator/types.ts';
import type { A2AAgentCard, VinyanECPExtension } from './types.ts';

export interface AgentCardIdentity {
  instanceId: string;
  publicKey: string;
}

/** Default features advertised by a Vinyan instance. */
const DEFAULT_FEATURES = ['knowledge_sharing', 'feedback_loop', 'file_invalidation'] as const;

export interface AgentCardOptions {
  streaming?: boolean;
  /**
   * Workspace-level Vinyan Agent identity (if bootstrapped).
   * When present: card.name/description and declared capabilities come from here
   * instead of hardcoded defaults.
   */
  agentProfile?: AgentProfile;
}

/** Build an A2A Agent Card from the current oracle registry state */
export function generateAgentCard(
  baseUrl: string,
  identity?: AgentCardIdentity,
  capabilityVersion: number = 1,
  options: AgentCardOptions = {},
): A2AAgentCard {
  const oracles = listOracles();

  const skills = oracles.map((name) => {
    const entry = getOracleEntry(name);
    return {
      id: name,
      name: `Vinyan ${name}`,
      description: `Run ${name} verification oracle`,
      tags: entry?.languages ?? ['typescript'],
    };
  });

  const profile = options.agentProfile;
  const card: A2AAgentCard = {
    name: profile?.displayName ?? 'Vinyan',
    description: profile?.description ?? 'Autonomous task orchestrator built on the Epistemic Orchestration paradigm',
    url: baseUrl,
    version: '5.0.0',
    capabilities: {
      streaming: options.streaming ?? false,
      pushNotifications: false,
    },
    skills,
  };

  // Add Vinyan ECP extension if identity is available
  if (identity) {
    const oracleCapabilities = oracles.map((name) => {
      const entry = getOracleEntry(name);
      return {
        name,
        tier: entry?.tier ?? ('heuristic' as const),
        languages: entry?.languages ?? ['typescript'],
      };
    });

    // Merge DEFAULT_FEATURES with agent's declared capabilities (if any).
    // Profile capabilities are prefixed (oracle:/engine:/mcp:) — we add them
    // as additional feature strings so peers can discover what this agent offers.
    const features: string[] = [...DEFAULT_FEATURES];
    if (profile?.capabilities?.length) {
      for (const cap of profile.capabilities) {
        if (!features.includes(cap)) features.push(cap);
      }
    }

    card['x-vinyan-ecp'] = {
      protocol: 'vinyan-ecp',
      ecp_version: 1,
      supported_versions: [1],
      instance_id: identity.instanceId,
      public_key: identity.publicKey,
      capability_version: capabilityVersion,
      oracle_capabilities: oracleCapabilities,
      features,
    };
  }

  return card;
}

/** Check if an Agent Card belongs to a Vinyan peer. */
export function isVinyanPeer(card: A2AAgentCard): boolean {
  return card['x-vinyan-ecp']?.protocol === 'vinyan-ecp';
}

/** Extract the ECP extension from an Agent Card. Returns null for non-Vinyan peers. */
export function getECPExtension(card: A2AAgentCard): VinyanECPExtension | null {
  return card['x-vinyan-ecp'] ?? null;
}

/**
 * A2A Agent Card Generator — PH5.6.
 *
 * Generates Vinyan's /.well-known/agent.json from the live oracle registry.
 * Each registered oracle becomes an A2A skill.
 */
import { listOracles, getOracleEntry } from "../oracle/registry.ts";
import type { A2AAgentCard } from "./types.ts";

/** Build an A2A Agent Card from the current oracle registry state */
export function generateAgentCard(baseUrl: string): A2AAgentCard {
  const oracles = listOracles();

  const skills = oracles.map((name) => {
    const entry = getOracleEntry(name);
    return {
      id: name,
      name: `Vinyan ${name}`,
      description: `Run ${name} verification oracle`,
      tags: entry?.languages ?? ["typescript"],
    };
  });

  return {
    name: "Vinyan ENS",
    description: "Epistemic Nervous System — verification oracles for code analysis",
    url: baseUrl,
    version: "5.0.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills,
  };
}
